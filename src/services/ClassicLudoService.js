const logger = require('../config/logger');
const gameService = require('./gameService');
const prisma = require('../config/database');

class ClassicLudoService {
  constructor(io) {
    this.io = io;
    this.games = new Map(); // In-memory game state for active games
    this.COLORS = ['red', 'blue', 'green', 'yellow'];
    this.POINTS = {
      MOVE_OUT_HOME: 1,
      MOVE: 0,
      KILL: 5,
      FINISH_TOKEN: 10,
      KILLED_PENALTY: -3
    };
  }

  setupSocketHandlers(socket) {
    socket.on('START_CLASSIC_LUDO', (data) => this.startGame(data));
    socket.on('ROLL_CLASSIC_LUDO_DICE', (data) => this.rollDice(socket, data));
    socket.on('MOVE_CLASSIC_LUDO_PIECE', (data) => this.movePiece(socket, data));
    socket.on('JOIN_CLASSIC_LUDO_ROOM', (data) => this.joinRoom(socket, data));
  }

  async startGame({ gameId }) {
  try {
    // Validate gameId parameter
    if (!gameId || typeof gameId !== 'string') {
      logger.error(`Classic Ludo: Invalid gameId provided for starting: ${gameId}`);
      return;
    }

    logger.info(`Classic Ludo: Starting game ${gameId}`);
    let game = await gameService.getGameById(gameId);
    if (!game) {
      logger.error(`Classic Ludo: Game ${gameId} not found for starting.`);
      this.io.to(`game:${gameId}`).emit('CLASSIC_LUDO_ERROR', { message: 'Game not found.' });
      return;
    }

    // Add detailed logging to debug the game object structure
    logger.info(`Classic Ludo: Game ${gameId} structure:`, JSON.stringify(game, null, 2));

    if (!game.participants || game.participants.length < 2) {
      logger.warn(`Classic Ludo: Not enough players in game ${gameId}. Current: ${game.participants?.length || 0}`);
      this.io.to(`game:${gameId}`).emit('CLASSIC_LUDO_ERROR', { message: 'Not enough players to start game.' });
      return;
    }

    // Initialize game board and assign colors to participants
    const initialBoard = gameService.initializeLudoGameBoard(game.maxPlayers);
    if (!initialBoard || typeof initialBoard !== 'object') {
      logger.error(`Classic Ludo: Failed to initialize game board for ${gameId}`);
      this.io.to(`game:${gameId}`).emit('CLASSIC_LUDO_ERROR', { message: 'Failed to initialize game board.' });
      return;
    }
    
    // Assign player IDs to colors
    game.participants.forEach((participant, index) => {
      const color = this.COLORS[index];
      if (initialBoard[color]) {
        initialBoard[color].playerId = participant.userId;
        // Handle case where user data might not be populated
        initialBoard[color].playerName = participant.user?.name || participant.userName || 'Unknown';
      }
    });

    const currentTurnUserId = game.participants[0]?.userId;
    if (!currentTurnUserId) {
      logger.error(`Classic Ludo: No valid user found for first turn in game ${gameId}`);
      this.io.to(`game:${gameId}`).emit('CLASSIC_LUDO_ERROR', { message: 'Failed to determine first player.' });
      return;
    }

    logger.info(`Classic Ludo: Updating game state for ${gameId}, first player: ${currentTurnUserId}`);
    game = await gameService.updateGameState(gameId, initialBoard, 0, 'PLAYING', null);
    
    if (!game) {
      logger.error(`Classic Ludo: Failed to update game state for ${gameId}`);
      this.io.to(`game:${gameId}`).emit('CLASSIC_LUDO_ERROR', { message: 'Failed to update game state.' });
      return;
    }

    // Store game instance in memory for quick access
    this.games.set(gameId, {
      gameState: {
        board: initialBoard,
        currentTurnIndex: 0,
        currentTurnPlayerId: currentTurnUserId,
        diceRolled: false,
        diceValue: null,
        gameStatus: 'PLAYING'
      },
      participants: game.participants
    });

    // Safely create players array for broadcast
    const players = game.participants ? game.participants.map((p, index) => ({
      id: p.userId,
      name: p.user?.name || p.userName || 'Unknown',
      color: this.COLORS[index]
    })) : [];

    // Broadcast game started to all players
    this.io.to(`game:${gameId}`).emit('CLASSIC_LUDO_GAME_STARTED', {
      gameBoard: initialBoard,
      players: players,
      currentTurn: currentTurnUserId,
      gameStatus: 'PLAYING'
    });

    logger.info(`✅ Classic Ludo game ${gameId} started with ${game.participants?.length || 0} players.`);
  } catch (error) {
    logger.error(`❌ Classic Ludo: Error starting game ${gameId}:`, error);
    this.io.to(`game:${gameId}`).emit('CLASSIC_LUDO_ERROR', { message: 'Failed to start game.' });
  }
}

  async rollDice(socket, data) {
    const { gameId } = data;
    const playerId = socket.user.id;

    try {
      const gameInstance = this.games.get(gameId);
      const game = await gameService.getGameById(gameId);
      
      if (!game || game.status !== 'PLAYING') {
        logger.warn(`Classic Ludo: Player ${playerId} attempted rollDice in game ${gameId} - not found or not playing.`);
        return socket.emit('CLASSIC_LUDO_ERROR', { message: 'Game not found or not currently playing.' });
      }

      if (!gameInstance) {
        logger.warn(`Classic Ludo: Game instance not found for ${gameId}`);
        return socket.emit('CLASSIC_LUDO_ERROR', { message: 'Game instance not found.' });
      }

      if (gameInstance.gameState.currentTurnPlayerId !== playerId) {
        logger.warn(`Classic Ludo: Player ${playerId} attempted rollDice but it's not their turn in game ${gameId}.`);
        return socket.emit('CLASSIC_LUDO_ERROR', { message: 'It is not your turn to roll the dice.' });
      }

      if (gameInstance.gameState.diceRolled) {
        logger.warn(`Classic Ludo: Player ${playerId} attempted rollDice but dice already rolled this turn in game ${gameId}.`);
        return socket.emit('CLASSIC_LUDO_ERROR', { message: 'Dice already rolled this turn. Please move a piece or end turn.' });
      }

      // Roll dice (1-6)
      const diceValue = Math.floor(Math.random() * 6) + 1;
      gameInstance.gameState.diceRolled = true;
      gameInstance.gameState.diceValue = diceValue;

      const canMove = this.canPlayerMove(gameInstance.gameState.board, playerId, diceValue);
      const playerColor = gameService.getLudoPlayerColor(gameInstance.gameState.board, playerId);
      const movablePieces = this.getMovablePieces(gameInstance.gameState.board, playerId, diceValue);

      // Broadcast dice roll to all players
      this.io.to(`game:${gameId}`).emit('CLASSIC_LUDO_DICE_ROLLED', {
        playerId,
        diceValue,
        canMove,
        playerColor,
        movablePieces,
        gameBoard: gameInstance.gameState.board
      });

      // Check if player can move, if not, end turn automatically
      if (!canMove) {
        setTimeout(() => {
          try {
            this.endTurn(gameId, diceValue !== 6); // Don't change turn if rolled 6
          } catch (error) {
            logger.error(`Classic Ludo: Error in endTurn timeout for game ${gameId}:`, error);
          }
        }, 3000);
      }

      logger.info(`🎲 Classic Ludo: Player ${playerId} rolled ${diceValue} in game ${gameId}. Can move: ${canMove}`);
    } catch (error) {
      logger.error(`❌ Classic Ludo: Roll dice error for player ${playerId} in game ${gameId}:`, error);
      socket.emit('CLASSIC_LUDO_ERROR', { message: 'Failed to roll dice.' });
    }
  }

  async movePiece(socket, data) {
    const { gameId, pieceId } = data;
    const playerId = socket.user.id;

    try {
      const gameInstance = this.games.get(gameId);
      const game = await gameService.getGameById(gameId);
      
      if (!game || game.status !== 'PLAYING') {
        logger.warn(`Classic Ludo: Player ${playerId} attempted movePiece in game ${gameId} - not found or not playing.`);
        return socket.emit('CLASSIC_LUDO_ERROR', { message: 'Game not found or not currently playing.' });
      }

      if (gameInstance.gameState.currentTurnPlayerId !== playerId) {
        logger.warn(`Classic Ludo: Player ${playerId} attempted movePiece but it's not their turn in game ${gameId}.`);
        return socket.emit('CLASSIC_LUDO_ERROR', { message: 'It is not your turn to move a piece.' });
      }

      if (!gameInstance.gameState.diceRolled) {
        logger.warn(`Classic Ludo: Player ${playerId} attempted movePiece without rolling dice in game ${gameId}.`);
        return socket.emit('CLASSIC_LUDO_ERROR', { message: 'Roll the dice first before moving a piece.' });
      }

      const board = gameInstance.gameState.board;
      const diceValue = gameInstance.gameState.diceValue;
      const playerColor = gameService.getLudoPlayerColor(board, playerId);
      
      if (!playerColor) {
        logger.error(`Classic Ludo: Player ${playerId} has no assigned color in game ${gameId}.`);
        return socket.emit('CLASSIC_LUDO_ERROR', { message: 'Your player color could not be determined.' });
      }

      const piece = board[playerColor].pieces[pieceId];
      if (!piece) {
        logger.warn(`Classic Ludo: Piece ${pieceId} not found for player ${playerId} in game ${gameId}.`);
        return socket.emit('CLASSIC_LUDO_ERROR', { message: 'Selected piece not found.' });
      }

      // Apply move using gameService
      const moveResult = gameService.applyLudoMove(piece, diceValue, playerColor, board);
      
      if (!moveResult.success) {
        logger.warn(`Classic Ludo: Invalid move for player ${playerId}, piece ${pieceId} in game ${gameId}: ${moveResult.message}`);
        return socket.emit('CLASSIC_LUDO_ERROR', { message: moveResult.message });
      }

      // The piece is already updated by applyLudoMove (it modifies the piece object directly)
      // Update player stats based on the action
      let scoreChange = 0;
      if (moveResult.action === 'MOVE_OUT_HOME') {
        scoreChange = this.POINTS?.MOVE_OUT_HOME || 1;
      } else if (moveResult.action === 'CAPTURE') {
        scoreChange = this.POINTS?.KILL || 5;
      } else if (moveResult.action === 'FINISH_PIECE') {
        scoreChange = this.POINTS?.FINISH_TOKEN || 10;
      }
      
      board[playerColor].score += scoreChange;

      // Check for game end condition
      const isGameFinished = board[playerColor].piecesFinished === 4;
      let winnerId = null;
      
      if (isGameFinished) {
        winnerId = playerId;
        gameInstance.gameState.gameStatus = 'FINISHED';
        await gameService.updateGameState(gameId, board, gameInstance.gameState.currentTurnIndex, 'FINISHED', winnerId);
        await gameService.processGameWinnings(gameId);
      } else {
        await gameService.updateGameState(gameId, board, gameInstance.gameState.currentTurnIndex, 'PLAYING', null);
      }

      // Broadcast move result to all players
      this.io.to(`game:${gameId}`).emit('CLASSIC_LUDO_PIECE_MOVED', {
        playerId,
        pieceId,
        updatedPiece: piece,
        gameBoard: board,
        killedPlayers: moveResult.capturedPiece ? [moveResult.capturedPiece] : [],
        scoreChange: scoreChange,
        diceValue: diceValue,
        action: moveResult.action,
        newPosition: moveResult.newPosition,
        playerColor: playerColor
      });

      if (isGameFinished) {
        this.io.to(`game:${gameId}`).emit('CLASSIC_LUDO_GAME_ENDED', {
          winner: winnerId,
          finalBoard: board,
          reason: 'All pieces finished'
        });
        this.games.delete(gameId);
      } else {
        // End turn (change turn if didn't roll 6 or if no more moves possible)
        const shouldChangeTurn = diceValue !== 6;
        this.endTurn(gameId, shouldChangeTurn);
      }

      logger.info(`♟️ Classic Ludo: Player ${playerId} moved piece ${pieceId} in game ${gameId}.`);
    } catch (error) {
      logger.error(`❌ Classic Ludo: Move piece error for player ${playerId}, piece ${pieceId} in game ${gameId}:`, error);
      socket.emit('CLASSIC_LUDO_ERROR', { message: 'Failed to move piece.' });
    }
  }

  async joinRoom(socket, data) {
    const { gameId, playerId, playerName } = data;

    try {
      const gameFromDb = await gameService.getGameById(gameId);
      if (!gameFromDb) {
        logger.warn(`Classic Ludo: Player ${playerName} tried to join non-existent game ${gameId}.`);
        return socket.emit('CLASSIC_LUDO_ERROR', { message: 'Game not found.' });
      }

      // Notify room about player joining
      this.io.to(`game:${gameId}`).emit('CLASSIC_LUDO_PLAYER_JOINED', {
        playerId,
        playerName
      });

      // Send current game state to the joining player
      const gameInstance = this.games.get(gameId);
      if (gameInstance) {
        socket.emit('CLASSIC_LUDO_CURRENT_STATE', {
          gameBoard: gameInstance.gameState.board,
          currentTurn: gameInstance.gameState.currentTurnPlayerId,
          gameStatus: gameInstance.gameState.gameStatus,
          diceValue: gameInstance.gameState.diceValue,
          diceRolled: gameInstance.gameState.diceRolled
        });
      }

      logger.info(`✅ Classic Ludo: Player ${playerName} (${playerId}) joined game ${gameId}.`);
    } catch (error) {
      logger.error(`❌ Classic Ludo: Error joining room for player ${playerId} in game ${gameId}:`, error);
      socket.emit('CLASSIC_LUDO_ERROR', { message: 'Failed to join game room.' });
    }
  }

  canPlayerMove(board, playerId, diceValue) {
    const playerColor = gameService.getLudoPlayerColor(board, playerId);
    if (!playerColor) return false;

    const playerData = board[playerColor];
    
    // Check each piece to see if it can move
    for (const piece of playerData.pieces) {
      if (piece.position === 'home' && diceValue === 6) {
        return true; // Can move out of home with 6
      }
      if (piece.position === 'board') {
        return true; // Can always try to move pieces on board
      }
      if (piece.position === 'homeStretch') {
        const newPos = piece.boardPosition + diceValue;
        if (newPos <= 6) {
          return true; // Can move in home stretch without overshooting
        }
      }
    }
    
    return false;
  }

  getMovablePieces(board, playerId, diceValue) {
    const playerColor = gameService.getLudoPlayerColor(board, playerId);
    if (!playerColor) return [];

    const playerData = board[playerColor];
    const movablePieces = [];
    
    playerData.pieces.forEach((piece, index) => {
      let canMove = false;
      
      if (piece.position === 'home' && diceValue === 6) {
        canMove = true;
      } else if (piece.position === 'board') {
        canMove = true;
      } else if (piece.position === 'homeStretch') {
        const newPos = piece.boardPosition + diceValue;
        if (newPos <= 6) {
          canMove = true;
        }
      }
      
      if (canMove) {
        movablePieces.push({
          pieceId: index,
          pieceIndex: index,
          currentPosition: piece.position,
          boardPosition: piece.boardPosition,
          homeIndex: piece.homeIndex
        });
      }
    });
    
    return movablePieces;
  }

  endTurn(gameId, changeTurn = true) {
    const gameInstance = this.games.get(gameId);
    if (!gameInstance) {
      logger.warn(`Classic Ludo: endTurn called for non-existent game ${gameId}`);
      return;
    }

    // Validate participants array exists
    if (!gameInstance.participants || !Array.isArray(gameInstance.participants) || gameInstance.participants.length === 0) {
      logger.error(`Classic Ludo: Invalid participants array in endTurn for game ${gameId}:`, gameInstance.participants);
      return;
    }

    // Reset dice state
    gameInstance.gameState.diceRolled = false;
    gameInstance.gameState.diceValue = null;

    if (changeTurn) {
      // Move to next player
      const nextTurnIndex = (gameInstance.gameState.currentTurnIndex + 1) % gameInstance.participants.length;
      gameInstance.gameState.currentTurnIndex = nextTurnIndex;
      
      // Validate the next participant exists
      if (gameInstance.participants[nextTurnIndex] && gameInstance.participants[nextTurnIndex].userId) {
        gameInstance.gameState.currentTurnPlayerId = gameInstance.participants[nextTurnIndex].userId;
      } else {
        logger.error(`Classic Ludo: Invalid participant at index ${nextTurnIndex} in game ${gameId}`);
        return;
      }
    }

    // Broadcast turn update
    this.io.to(`game:${gameId}`).emit('CLASSIC_LUDO_TURN_UPDATE', {
      currentTurn: gameInstance.gameState.currentTurnPlayerId,
      currentTurnIndex: gameInstance.gameState.currentTurnIndex,
      currentPlayer: gameInstance.participants[gameInstance.gameState.currentTurnIndex],
      gameBoard: gameInstance.gameState.board
    });
  }
}

module.exports = ClassicLudoService;