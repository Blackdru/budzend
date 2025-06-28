const prisma = require('../config/database');
const logger = require('../config/logger');
const walletService = require('./walletService');

class GameService {
  constructor() {
    this.BOARD_SIZE = 52;
    this.HOME_POSITIONS = {
      red: 0,
      blue: 13,
      green: 26,
      yellow: 39
    };
    this.SAFE_ZONES = [0, 13, 26, 39, 8, 21, 34, 47, 51, 12, 25, 38];
    this.STAR_CELLS = [1, 9, 14, 22, 27, 35, 40, 48];
    this.COLORS = ['red', 'blue', 'green', 'yellow'];
    this.POINTS = {
      MOVE_OUT_HOME: 1,
      MOVE: 0,
      KILL: 5,
      FINISH_TOKEN: 10,
      KILLED_PENALTY: -3
    };
  }

  initializeLudoGameBoard(maxPlayers) {
    const board = {};
    const colors = this.COLORS.slice(0, maxPlayers);
    
    colors.forEach(color => {
      board[color] = {
        pieces: [
          { id: 0, position: 'home', homeIndex: 0, boardPosition: -1 },
          { id: 1, position: 'home', homeIndex: 1, boardPosition: -1 },
          { id: 2, position: 'home', homeIndex: 2, boardPosition: -1 },
          { id: 3, position: 'home', homeIndex: 3, boardPosition: -1 }
        ],
        piecesInHome: 4,
        piecesFinished: 0,
        score: 0
      };
    });
    logger.info(`Ludo game board initialized for ${maxPlayers} players.`);
    return board;
  }

  /**
   * Fixed Memory Game Board - 11 pairs (22 cards) with 10-second timer
   */
  initializeMemoryGameBoard() {
    const CARD_SYMBOLS = [
      '🎮', '🎯', '🎲', '🃏', '🎪', '🎨', '🎭', '💡',
      '⚽', '🏀', '🏈'
    ];
    
    // Use exactly 11 unique symbols for 22 cards (11 pairs) - odd number prevents ties
    const selectedSymbols = CARD_SYMBOLS.slice(0, 11);
    const cards = [...selectedSymbols, ...selectedSymbols]; // Create exactly 2 of each symbol
    
    // Shuffle the cards (Fisher-Yates)
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }

    // Create card objects
    const gameBoard = cards.map((symbol, index) => ({
      id: index,
      symbol,
      isFlipped: false,
      isMatched: false,
    }));
    
    logger.info(`Memory game board initialized with ${gameBoard.length} cards (${selectedSymbols.length} pairs).`);
    return gameBoard;
  }

  async getGameById(gameId) {
    // Validate gameId parameter
    if (!gameId || typeof gameId !== 'string' || gameId.trim() === '') {
      logger.warn(`Invalid gameId provided to getGameById: ${gameId}`);
      return null;
    }

    try {
      return await prisma.game.findUnique({
        where: { id: gameId },
        include: {
          participants: { 
            include: { user: true },
            orderBy: { position: 'asc' }
          }
        }
      });
    } catch (error) {
      logger.error(`Error fetching game ${gameId}:`, error);
      return null;
    }
  }

  async getActiveGames() {
    try {
      return await prisma.game.findMany({
        where: {
          status: {
            in: ['WAITING', 'PLAYING']
          }
        },
        include: {
          participants: { 
            include: { user: true },
            orderBy: { position: 'asc' }
          }
        }
      });
    } catch (error) {
      logger.error('Error fetching active games:', error);
      return [];
    }
  }

  async updateGameState(gameId, newGameData, newCurrentTurn, newGameStatus = 'PLAYING', winnerId = null) {
    return prisma.game.update({
      where: { id: gameId },
      data: {
        gameData: newGameData,
        currentTurn: newCurrentTurn,
        status: newGameStatus,
        winner: winnerId,
        finishedAt: newGameStatus === 'FINISHED' ? new Date() : undefined,
        updatedAt: new Date()
      }
    });
  }

  getLudoPlayerColor(board, playerId) {
    for (const color of this.COLORS) {
      if (board[color] && board[color].playerId === playerId) {
        return color;
      }
    }
    return null;
  }

  /**
   * Fixed Memory Game Card Selection with proper validation
   */
  applyMemoryCardSelection(currentBoardState, position, selectedCardsInTurn) {
    const card = currentBoardState[position];

    if (!card) {
      return { success: false, message: 'Invalid card position.' };
    }
    if (card.isFlipped || card.isMatched) {
      return { success: false, message: 'Card already flipped or matched.' };
    }
    if (selectedCardsInTurn.length >= 2) {
      return { success: false, message: 'Maximum 2 cards per turn.' };
    }

    // Mark card as flipped
    card.isFlipped = true;
    selectedCardsInTurn.push({ position, symbol: card.symbol });

    let action = 'OPEN_CARD';
    
    // If two cards are selected, check for match
    if (selectedCardsInTurn.length === 2) {
      const [card1, card2] = selectedCardsInTurn;
      if (card1.symbol === card2.symbol) {
        // Match found!
        currentBoardState[card1.position].isMatched = true;
        currentBoardState[card2.position].isMatched = true;
        action = 'CARDS_MATCHED';
      } else {
        // No match
        action = 'CARDS_NO_MATCH';
      }
    }

    return {
      success: true,
      updatedCard: card,
      action: action,
      selectedCardsInTurn
    };
  }

  async processGameWinnings(gameId) {
    try {
      const game = await this.getGameById(gameId);
      if (!game || game.status !== 'FINISHED' || !game.winner) {
        return;
      }

      const winnerAmount = game.prizePool * 0.9;
      await walletService.creditWallet(game.winner, winnerAmount, 'GAME_WINNING', gameId);
      
      logger.info(`Game ${gameId} winnings processed: ₹${winnerAmount.toFixed(2)} credited to user ${game.winner}`);
    } catch (error) {
      logger.error(`Error processing game winnings for game ${gameId}:`, error);
    }
  }

  /**
   * Update player score in game participation record
   */
  async updatePlayerScore(gameId, playerId, newScore) {
    try {
      await prisma.gameParticipation.updateMany({
        where: {
          gameId: gameId,
          userId: playerId
        },
        data: {
          score: newScore
        }
      });
      logger.info(`Updated score for player ${playerId} in game ${gameId}: ${newScore}`);
    } catch (error) {
      logger.error(`Error updating player score for game ${gameId}, player ${playerId}:`, error);
      throw error;
    }
  }

  /**
   * Apply Ludo piece movement logic
   */
  applyLudoMove(piece, diceValue, playerColor, board) {
    try {
      // Validate inputs
      if (!piece || !diceValue || !playerColor || !board) {
        return { success: false, message: 'Invalid move parameters' };
      }

      if (diceValue < 1 || diceValue > 6) {
        return { success: false, message: 'Invalid dice value' };
      }

      // If piece is at home, can only move out with 6
      if (piece.position === 'home') {
        if (diceValue === 6) {
          // Move piece to starting position
          const startPosition = this.HOME_POSITIONS[playerColor];
          piece.position = 'board';
          piece.boardPosition = startPosition;
          piece.homeIndex = -1;
          
          // Update board state
          if (board[playerColor]) {
            board[playerColor].piecesInHome--;
          }
          
          return { 
            success: true, 
            message: 'Piece moved out of home',
            newPosition: startPosition,
            action: 'MOVE_OUT_HOME'
          };
        } else {
          return { success: false, message: 'Need 6 to move out of home' };
        }
      }

      // If piece is on board, calculate new position
      if (piece.position === 'board') {
        const currentPos = piece.boardPosition;
        let newPos = (currentPos + diceValue) % this.BOARD_SIZE;
        
        // Check if piece reaches home column (simplified logic)
        const homeStretch = this.HOME_POSITIONS[playerColor] + 51;
        if (newPos >= homeStretch) {
          // Piece is finishing
          piece.position = 'finished';
          piece.boardPosition = -1;
          
          if (board[playerColor]) {
            board[playerColor].piecesFinished++;
          }
          
          return { 
            success: true, 
            message: 'Piece finished!',
            newPosition: -1,
            action: 'FINISH_PIECE'
          };
        }

        // Normal move
        piece.boardPosition = newPos;
        
        // Check for captures (simplified - would need more complex logic)
        let capturedPiece = null;
        for (const color in board) {
          if (color !== playerColor) {
            for (const otherPiece of board[color].pieces) {
              if (otherPiece.position === 'board' && otherPiece.boardPosition === newPos) {
                // Capture logic - send opponent piece home
                if (!this.SAFE_ZONES.includes(newPos)) {
                  otherPiece.position = 'home';
                  otherPiece.boardPosition = -1;
                  otherPiece.homeIndex = board[color].piecesInHome;
                  board[color].piecesInHome++;
                  capturedPiece = { color, pieceId: otherPiece.id };
                }
              }
            }
          }
        }
        
        return { 
          success: true, 
          message: capturedPiece ? 'Piece moved and captured opponent' : 'Piece moved',
          newPosition: newPos,
          action: capturedPiece ? 'CAPTURE' : 'MOVE',
          capturedPiece
        };
      }

      return { success: false, message: 'Invalid piece position' };
    } catch (error) {
      logger.error('Error in applyLudoMove:', error);
      return { success: false, message: 'Move calculation failed' };
    }
  }
}

module.exports = new GameService();