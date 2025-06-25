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
    this.COLORS = ['red', 'blue', 'green', 'yellow'];
  }

  initializeGameBoard(maxPlayers) {
    const board = {};
    const colors = this.COLORS.slice(0, maxPlayers);
    
    colors.forEach(color => {
      board[color] = {
        pieces: [
          { id: 0, position: 'home', homeIndex: 0, boardPosition: -1, isInSafeZone: false },
          { id: 1, position: 'home', homeIndex: 1, boardPosition: -1, isInSafeZone: false },
          { id: 2, position: 'home', homeIndex: 2, boardPosition: -1, isInSafeZone: false },
          { id: 3, position: 'home', homeIndex: 3, boardPosition: -1, isInSafeZone: false }
        ],
        piecesInHome: 4,
        piecesFinished: 0,
        score: 0
      };
    });
    
    return board;
  }

  async getGameById(gameId) {
    return prisma.game.findUnique({
      where: { id: gameId },
      include: {
        participants: { 
          include: { user: true },
          orderBy: { position: 'asc' }
        }
      }
    });
  }

  async getUserActiveGame(userId) {
    const participation = await prisma.gameParticipation.findFirst({
      where: {
        userId,
        game: {
          status: { in: ['WAITING', 'PLAYING'] }
        }
      },
      include: { 
        game: {
          include: {
            participants: { include: { user: true } }
          }
        }
      }
    });
    return participation ? participation.game : null;
  }

  async updateGameState(gameId, gameData, currentTurn) {
    return prisma.game.update({
      where: { id: gameId },
      data: {
        gameData,
        currentTurn,
        updatedAt: new Date()
      }
    });
  }

  async movePiece(gameId, userId, pieceId, diceValue) {
    try {
      const game = await this.getGameById(gameId);
      if (!game) {
        return { success: false, message: 'Game not found' };
      }

      const gameData = game.gameData || {};
      const board = gameData.board || this.initializeGameBoard(game.maxPlayers);
      
      // Find player and their color
      const player = game.participants.find(p => p.userId === userId);
      if (!player) {
        return { success: false, message: 'Player not found in game' };
      }

      const playerColor = player.color;
      const piece = board[playerColor].pieces[pieceId];
      
      if (!piece) {
        return { success: false, message: 'Piece not found' };
      }

      // Validate move
      const moveResult = this.validateAndExecuteMove(piece, diceValue, playerColor, board);
      
      if (!moveResult.success) {
        return moveResult;
      }

      // Update board state
      board[playerColor] = moveResult.updatedPlayerBoard;
      gameData.board = board;
      gameData.diceRolled = false;
      gameData.diceValue = null;

      // Check for winner
      let nextTurn = game.currentTurn;
      let gameStatus = game.status;
      let winner = null;

      if (board[playerColor].piecesFinished === 4) {
        gameStatus = 'FINISHED';
        winner = userId;
        await this.finishGame(gameId, userId);
      } else {
        // Move to next turn (unless dice was 6)
        if (diceValue !== 6) {
          nextTurn = (game.currentTurn + 1) % game.participants.length;
        }
      }

      // Update game state
      await this.updateGameState(gameId, gameData, nextTurn);
      
      // Update player score
      await this.updatePlayerScore(gameId, userId, board[playerColor].score);

      return {
        success: true,
        board,
        nextTurn,
        gameStatus,
        winner,
        playerScore: board[playerColor].score
      };

    } catch (error) {
      logger.error('Move piece error:', error);
      return { success: false, message: 'Failed to process move' };
    }
  }

  validateAndExecuteMove(piece, diceValue, playerColor, board) {
    const playerBoard = { ...board[playerColor] };
    const updatedPiece = { ...piece };

    // If piece is in home and dice is 6, move to start
    if (piece.position === 'home' && diceValue === 6) {
      updatedPiece.position = 'board';
      updatedPiece.boardPosition = this.HOME_POSITIONS[playerColor];
      updatedPiece.homeIndex = -1;
      playerBoard.piecesInHome--;
      playerBoard.score += 1; // Points for getting piece out
    }
    // If piece is on board, move forward
    else if (piece.position === 'board') {
      const newPosition = (piece.boardPosition + diceValue) % this.BOARD_SIZE;
      
      // Check if piece reaches home stretch
      const homeStretchStart = (this.HOME_POSITIONS[playerColor] + 51) % this.BOARD_SIZE;
      
      if (this.isEnteringHomeStretch(piece.boardPosition, newPosition, homeStretchStart)) {
        const homeSteps = diceValue - (homeStretchStart - piece.boardPosition);
        if (homeSteps <= 6) {
          if (homeSteps === 6) {
            updatedPiece.position = 'finished';
            updatedPiece.boardPosition = -1;
            playerBoard.piecesFinished++;
            playerBoard.score += 10; // Points for finishing piece
          } else {
            updatedPiece.position = 'homeStretch';
            updatedPiece.boardPosition = homeSteps;
          }
        } else {
          return { success: false, message: 'Cannot overshoot home' };
        }
      } else {
        updatedPiece.boardPosition = newPosition;
        // Check for captures
        this.checkForCaptures(newPosition, playerColor, board);
      }
    }
    // If piece is in home stretch
    else if (piece.position === 'homeStretch') {
      const newHomePosition = piece.boardPosition + diceValue;
      if (newHomePosition === 6) {
        updatedPiece.position = 'finished';
        updatedPiece.boardPosition = -1;
        playerBoard.piecesFinished++;
        playerBoard.score += 10;
      } else if (newHomePosition < 6) {
        updatedPiece.boardPosition = newHomePosition;
      } else {
        return { success: false, message: 'Cannot overshoot finish line' };
      }
    }
    // If piece is finished, cannot move
    else if (piece.position === 'finished') {
      return { success: false, message: 'Piece already finished' };
    }

    // Update the piece in the board
    playerBoard.pieces[updatedPiece.id] = updatedPiece;

    return {
      success: true,
      updatedPlayerBoard: playerBoard,
      updatedPiece
    };
  }

  isEnteringHomeStretch(currentPos, newPos, homeStretchStart) {
    return currentPos < homeStretchStart && newPos >= homeStretchStart;
  }

  checkForCaptures(position, currentPlayerColor, board) {
    // Check if any opponent pieces are on the same position
    Object.keys(board).forEach(color => {
      if (color !== currentPlayerColor) {
        board[color].pieces.forEach((piece, index) => {
          if (piece.boardPosition === position && piece.position === 'board' && !piece.isInSafeZone) {
            // Capture the piece - send it back home
            board[color].pieces[index] = {
              ...piece,
              position: 'home',
              boardPosition: -1,
              homeIndex: board[color].piecesInHome
            };
            board[color].piecesInHome++;
            board[color].score = Math.max(0, board[color].score - 2); // Penalty for being captured
          }
        });
      }
    });
  }

  async finishGame(gameId, winnerUserId) {
    return prisma.game.update({
      where: { id: gameId },
      data: {
        status: 'FINISHED',
        winner: winnerUserId,
        finishedAt: new Date()
      }
    });
  }

  async processGameWinnings(gameId) {
    try {
      const game = await this.getGameById(gameId);
      if (!game || game.status !== 'FINISHED') {
        return;
      }

      // Calculate winnings (90% of prize pool to winner, 10% platform fee)
      const winnerAmount = game.prizePool * 0.9;
      
      // Credit winner's wallet
      await walletService.creditWallet(game.winner, winnerAmount, 'GAME_WINNING', gameId);
      
      logger.info(`Game ${gameId} winnings processed: ${winnerAmount} to user ${game.winner}`);
    } catch (error) {
      logger.error('Error processing game winnings:', error);
    }
  }

  async updatePlayerScore(gameId, userId, score, rank = null) {
    return prisma.gameParticipation.update({
      where: {
        userId_gameId: {
          userId,
          gameId
        }
      },
      data: {
        score,
        rank
      }
    });
  }

  async getGameHistory(userId, page = 1, limit = 20) {
    const participations = await prisma.gameParticipation.findMany({
      where: { userId },
      include: {
        game: {
          include: {
            participants: {
              include: { user: { select: { id: true, name: true, phoneNumber: true } } }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit
    });
    
    const total = await prisma.gameParticipation.count({ where: { userId } });
    
    return {
      games: participations,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    };
  }

  async getGameStats(userId) {
    const stats = await prisma.gameParticipation.aggregate({
      where: { userId },
      _count: { id: true },
      _sum: { score: true }
    });

    const wins = await prisma.game.count({
      where: { winner: userId }
    });

    return {
      totalGames: stats._count.id || 0,
      totalWins: wins,
      totalScore: stats._sum.score || 0,
      winRate: stats._count.id > 0 ? (wins / stats._count.id * 100).toFixed(2) : 0
    };
  }
}

module.exports = new GameService();