// FastLudoService.js - Fast Ludo game implementation with timer and points
const logger = require('../config/logger'); // Adjust path to logger
const gameService = require('./gameService'); // Import gameService
const prisma = require('../config/database'); // Import prisma for game.participants

class FastLudoService {
  constructor(io) {
    this.io = io;
    this.games = new Map(); // Store active game instances (mainly for timer and state references)
    this.gameLocks = new Map(); // Prevent race conditions in game operations
    this.COLORS = ['red', 'blue', 'green', 'yellow']; // Standard Ludo colors
    // Ludo Scoring (these are now defined in gameService but kept here for reference if specific adjustments needed)
    this.POINTS = {
      MOVE: 1, // Example: points for making a successful move
      KILL: 5, // Points for capturing an opponent's piece
      FINISH_TOKEN: 10, // Points for finishing a piece
      KILLED_PENALTY: -3 // Penalty for an own piece being captured
    };
  }

  /**
   * Acquire a lock for game operations to prevent race conditions
   */
  async acquireGameLock(gameId) {
    while (this.gameLocks.has(gameId)) {
      await new Promise(resolve => setTimeout(resolve, 10)); // Wait 10ms
    }
    this.gameLocks.set(gameId, true);
  }

  /**
   * Release a game lock
   */
  releaseGameLock(gameId) {
    this.gameLocks.delete(gameId);
  }

  setupSocketHandlers(socket) {
    // Note: 'START_FAST_LUDO' should ideally be triggered by matchmakingService
    // or an admin, not directly by a client, for security and game flow.
    // However, if it's meant for manual game start for testing, it's fine.
    socket.on('START_FAST_LUDO', (data) => this.startGame(data));
    socket.on('ROLL_FAST_LUDO_DICE', (data) => this.rollDice(socket, data));
    socket.on('MOVE_FAST_LUDO_PIECE', (data) => this.movePiece(socket, data));
    socket.on('JOIN_FAST_LUDO_ROOM', (data) => this.joinRoom(socket, data));
    
    // Auto-join room when socket connects (for matchmaking integration)
    // This listener is typically handled in server.js after matchFound event
    // Leaving it here as a fallback or for direct client calls.
    socket.on('joinGameRoom', (data) => {
      if (data.gameId) {
        logger.info(`FastLudoService: Direct joinGameRoom for user ${socket.user.id} to game ${data.gameId}`);
        this.joinRoom(socket, {
          gameId: data.gameId,
          playerId: socket.user.id,
          playerName: socket.user.name
        });
      }
    });
  }

  /**
   * Starts a new Fast Ludo game. This should be called by the matchmaking service.
   * It initializes the game state in the database and broadcasts to players.
   * @param {object} params - Contains gameId, participants, etc. (socket is no longer required for auto-start)
   */
  async startGame({ gameId }) {
    try {
      // Validate gameId parameter
      if (!gameId || typeof gameId !== 'string') {
        logger.error(`Fast Ludo: Invalid gameId provided for starting: ${gameId}`);
        return;
      }

      logger.info(`Fast Ludo: Starting game ${gameId}`);
      let game = await gameService.getGameById(gameId);
      if (!game) {
        logger.error(`Fast Ludo: Game ${gameId} not found for starting.`);
        this.io.to(`game:${gameId}`).emit('FAST_LUDO_GAME_ERROR', { message: 'Game not found.' });
        return;
      }
      
      // Check if participants is undefined and log the game object for debugging
      if (!game.participants) {
        logger.error(`Fast Ludo: Game ${gameId} has undefined participants. Game object:`, JSON.stringify(game, null, 2));
        
        // Try to fetch the game with explicit participants inclusion
        try {
          game = await prisma.game.findUnique({
            where: { id: gameId },
            include: {
              participants: {
                include: {
                  user: true
                }
              }
            }
          });
          
          if (!game || !game.participants) {
            logger.error(`Fast Ludo: Even after explicit fetch, game ${gameId} has no participants`);
            this.io.to(`game:${gameId}`).emit('FAST_LUDO_GAME_ERROR', { message: 'Game participants not found.' });
            return;
          }
          
          logger.info(`Fast Ludo: Successfully fetched participants for game ${gameId}. Count: ${game.participants.length}`);
        } catch (dbError) {
          logger.error(`Fast Ludo: Database error fetching game ${gameId} with participants:`, dbError);
          this.io.to(`game:${gameId}`).emit('FAST_LUDO_GAME_ERROR', { message: 'Database error fetching game participants.' });
          return;
        }
      }
      
      if (!Array.isArray(game.participants) || game.participants.length < 2) {
        logger.warn(`Fast Ludo: Not enough players in game ${gameId}. Current: ${game.participants?.length || 0}`);
        this.io.to(`game:${gameId}`).emit('FAST_LUDO_GAME_ERROR', { message: 'Not enough players to start game.' });
        return;
      }

      // Initialize game board and assign colors to participants
      const initialBoard = gameService.initializeLudoGameBoard(game.maxPlayers);
      if (!initialBoard || typeof initialBoard !== 'object') {
        logger.error(`Fast Ludo: Failed to initialize game board for ${gameId}`);
        this.io.to(`game:${gameId}`).emit('FAST_LUDO_GAME_ERROR', { message: 'Failed to initialize game board.' });
        return;
      }
      
      // Assign colors to players in the game's participants list
      const updatedParticipants = game.participants.map((player, index) => {
        const color = this.COLORS[index];
        if (initialBoard[color]) {
          initialBoard[color].playerId = player.userId; // Link player ID to color in board state
          initialBoard[color].playerName = player.user?.name || 'Unknown';
        }
        return { ...player, color: color }; // Add color to participant object if not already there
      });

      // Update game status and initial board state in DB
      // Also set the current turn (first player)
      const currentTurnUserId = updatedParticipants[0]?.userId;
      if (!currentTurnUserId) {
        logger.error(`Fast Ludo: No valid user found for first turn in game ${gameId}`);
        this.io.to(`game:${gameId}`).emit('FAST_LUDO_GAME_ERROR', { message: 'Failed to determine first player.' });
        return;
      }

      logger.info(`Fast Ludo: Updating game state for ${gameId}, first player: ${currentTurnUserId}`);
      game = await gameService.updateGameState(gameId, initialBoard, 0, 'PLAYING', null); // 0 = index of first player
      
      if (!game) {
        logger.error(`Fast Ludo: Failed to update game state for ${gameId}`);
        this.io.to(`game:${gameId}`).emit('FAST_LUDO_GAME_ERROR', { message: 'Failed to update game state.' });
        return;
      }

      // Store in-memory reference (primarily for timer management)
      this.games.set(gameId, {
        id: gameId,
        players: updatedParticipants, // Use updated participants
        gameState: {
          board: initialBoard, // In-memory reference for current board
          currentTurn: game.currentTurn, // Index of current turn player in participants array
          diceValue: null,
          diceRolled: false,
          status: 'playing',
          startTime: Date.now(), // Fixed: was Date.startTime which is undefined
          timerDuration: game.maxPlayers === 2 ? 300000 : 600000, // 5 or 10 minutes
          endTime: Date.now() + (game.maxPlayers === 2 ? 300000 : 600000)
        },
        timer: null
      });

      logger.info(`Fast Ludo: Starting game ${gameId} with ${game.participants.length} players. Initial turn for ${currentTurnUserId}.`);

      this.io.to(`game:${gameId}`).emit('FAST_LUDO_GAME_STARTED', {
        gameBoard: initialBoard, // Send the initial board state
        players: updatedParticipants.map(p => ({id: p.userId, name: p.user.name, color: p.color})), // Simplified player info
        currentTurn: currentTurnUserId,
        gameStatus: 'PLAYING',
        timerDuration: game.maxPlayers === 2 ? 300000 : 600000,
        endTime: Date.now() + (game.maxPlayers === 2 ? 300000 : 600000)
      });

      // Emit initial turn update
      this.io.to(`game:${gameId}`).emit('FAST_LUDO_TURN_UPDATE', {
        currentPlayerId: currentTurnUserId,
        currentTurnIndex: game.currentTurn // Index
      });

      // Start game timer
      this.startGameTimer(gameId);

      logger.info(`Fast Ludo game ${gameId} successfully started.`);
    } catch (error) {
      logger.error(`❌ Fast Ludo: Error starting game ${gameId}:`, error);
      this.io.to(`game:${gameId}`).emit('FAST_LUDO_GAME_ERROR', { message: 'Failed to start game.' });
    }
  }

  startGameTimer(gameId) {
    const gameInstance = this.games.get(gameId);
    if (!gameInstance || !gameInstance.gameState) {
      logger.warn(`Fast Ludo: Cannot start timer for game ${gameId}. Game instance not found.`);
      return;
    }

    // Clear any existing timer to prevent duplicates
    if (gameInstance.timer) {
      clearTimeout(gameInstance.timer);
    }

    gameInstance.timer = setTimeout(() => {
      logger.info(`Fast Ludo: Game ${gameId} timer ended.`);
      this.endGameByTimer(gameId);
    }, gameInstance.gameState.timerDuration);

    logger.info(`Fast Ludo: Timer started for game ${gameId} for ${gameInstance.gameState.timerDuration / 1000} seconds.`);
  }

  async rollDice(socket, { gameId, playerId }) {
    await this.acquireGameLock(gameId);
    
    try {
      const game = await gameService.getGameById(gameId); // Get current game state from DB
      if (!game || game.status !== 'PLAYING') {
        logger.warn(`Fast Ludo: Player ${playerId} attempted rollDice in game ${gameId} - not found or not playing.`);
        return socket.emit('FAST_LUDO_ERROR', { message: 'Game not found or not currently playing.' });
      }

      const currentPlayer = game.participants[game.currentTurn];
      if (currentPlayer.userId !== playerId) {
        logger.warn(`Fast Ludo: Player ${playerId} attempted rollDice but it's not their turn in game ${gameId}.`);
        return socket.emit('FAST_LUDO_ERROR', { message: 'It is not your turn to roll the dice.' });
      }

      const gameData = game.gameData || {}; // Current game data
      if (gameData.diceRolled) {
        logger.warn(`Fast Ludo: Player ${playerId} attempted rollDice but dice already rolled this turn in game ${gameId}.`);
        return socket.emit('FAST_LUDO_ERROR', { message: 'Dice already rolled this turn. Please move a piece.' });
      }

      const diceValue = Math.floor(Math.random() * 6) + 1;
      
      // Update gameData for persistence
      gameData.diceValue = diceValue;
      gameData.diceRolled = true;
      gameData.lastRollTime = new Date(); // Track last roll time

      // Persist updated game state (only relevant parts of gameData)
      await gameService.updateGameState(gameId, gameData, game.currentTurn, 'PLAYING', null);

      logger.info(`Fast Ludo: Player ${playerId} rolled ${diceValue} in game ${gameId}.`);

      const playerColor = gameService.getLudoPlayerColor(gameData.board, playerId);
      const canMove = this.canPlayerMove(gameData.board, playerId, diceValue);
      const movablePieces = this.getMovablePieces(gameData.board, playerId, diceValue);

      // Broadcast dice roll to all players in game room
      this.io.to(`game:${gameId}`).emit('FAST_LUDO_DICE_ROLLED', {
        playerId,
        diceValue,
        currentTurnIndex: game.currentTurn,
        currentPlayerId: currentPlayer.userId,
        gameId,
        playerColor,
        canMove,
        movablePieces,
        gameBoard: gameData.board
      });

      // Auto-end turn if player cannot move
      if (!canMove) {
        setTimeout(async () => {
          try {
            // Reset dice state and move to next turn
            gameData.diceRolled = false;
            gameData.diceValue = null;
            
            const nextTurnIndex = (game.currentTurn + 1) % game.participants.length;
            await gameService.updateGameState(gameId, gameData, nextTurnIndex, 'PLAYING', null);
            
            this.io.to(`game:${gameId}`).emit('FAST_LUDO_TURN_UPDATE', {
              currentPlayerId: game.participants[nextTurnIndex].userId,
              currentTurnIndex: nextTurnIndex,
              gameBoard: gameData.board
            });
          } catch (error) {
            logger.error(`Fast Ludo: Error auto-ending turn for ${gameId}:`, error);
          }
        }, 3000);
      }
    } catch (error) {
      logger.error(`❌ Fast Ludo: Roll dice error for player ${playerId} in game ${gameId}:`, error);
      socket.emit('FAST_LUDO_ERROR', { message: 'Failed to roll dice.', details: error.message });
    } finally {
      this.releaseGameLock(gameId);
    }
  }

  async movePiece(socket, { gameId, playerId, pieceId }) {
    await this.acquireGameLock(gameId);
    
    try {
      const game = await gameService.getGameById(gameId); // Get current game state from DB
      if (!game || game.status !== 'PLAYING') {
        logger.warn(`Fast Ludo: Player ${playerId} attempted movePiece in game ${gameId} - not found or not playing.`);
        return socket.emit('FAST_LUDO_ERROR', { message: 'Game not found or not currently playing.' });
      }

      const currentPlayer = game.participants[game.currentTurn];
      if (currentPlayer.userId !== playerId) {
        logger.warn(`Fast Ludo: Player ${playerId} attempted movePiece but it's not their turn in game ${gameId}.`);
        return socket.emit('FAST_LUDO_ERROR', { message: 'It is not your turn to move a piece.' });
      }

      let gameData = game.gameData || {};
      const board = gameData.board; // Get current board from gameData
      const diceValue = gameData.diceValue;

      if (!diceValue || !gameData.diceRolled) {
        logger.warn(`Fast Ludo: Player ${playerId} attempted movePiece without rolling dice in game ${gameId}.`);
        return socket.emit('FAST_LUDO_ERROR', { message: 'Roll the dice first before moving a piece.' });
      }

      const playerColor = gameService.getLudoPlayerColor(board, playerId);
      if (!playerColor) {
        logger.error(`Fast Ludo: Player ${playerId} has no assigned color in game ${gameId}.`);
        return socket.emit('FAST_LUDO_ERROR', { message: 'Your player color could not be determined.' });
      }

      const piece = board[playerColor].pieces[pieceId];
      if (!piece) {
        logger.warn(`Fast Ludo: Piece ${pieceId} not found for player ${playerId} in game ${gameId}.`);
        return socket.emit('FAST_LUDO_ERROR', { message: 'Selected piece not found.' });
      }

      // Apply Ludo move logic using gameService's centralized function
      const moveResult = gameService.applyLudoMove(piece, diceValue, playerColor, board);
      
      if (!moveResult.success) {
        logger.warn(`Fast Ludo: Invalid move for player ${playerId}, piece ${pieceId} in game ${gameId}: ${moveResult.message}`);
        return socket.emit('FAST_LUDO_ERROR', { message: moveResult.message });
      }

      // Update the piece state within the board
      board[playerColor].pieces[pieceId] = moveResult.updatedPiece;
      board[playerColor].score += moveResult.scoreChange;
      board[playerColor].piecesFinished += moveResult.piecesFinishedChange;
      board[playerColor].piecesInHome += moveResult.piecesInHomeChange; // This will be negative if moved out of home

      // Reset dice state after move
      gameData.diceRolled = false;
      gameData.diceValue = null;

      // Determine next turn
      let nextTurnIndex = game.currentTurn;
      let gameStatus = 'PLAYING';
      let winnerId = null;
      let isExtraTurn = false; // Ludo: roll a 6 often means an extra turn

      // Check if current player finished a piece (and won)
      if (board[playerColor].piecesFinished === 4) {
        gameStatus = 'FINISHED';
        winnerId = playerId;
        logger.info(`Fast Ludo: Player ${playerId} finished all pieces and won game ${gameId}.`);
      } else if (diceValue === 6) { // Ludo rule: rolling a 6 gives another turn
        isExtraTurn = true;
        logger.info(`Fast Ludo: Player ${playerId} rolled a 6 and gets an extra turn in game ${gameId}.`);
      } else {
        // Move to next turn in sequence if no extra turn
        if (game.participants && game.participants.length > 0) {
          nextTurnIndex = (game.currentTurn + 1) % game.participants.length;
          logger.debug(`Fast Ludo: Switching turn to index ${nextTurnIndex} in game ${gameId}.`);
        } else {
          logger.error(`Fast Ludo: Cannot switch turn - participants array is invalid in game ${gameId}`);
          return socket.emit('FAST_LUDO_ERROR', { message: 'Game participants data is corrupted.' });
        }
      }

      // Persist the updated game state to the database
      const updatedGame = await gameService.updateGameState(
        gameId,
        gameData,
        nextTurnIndex,
        gameStatus,
        winnerId
      );

      // Update in-memory game instance with new state (mainly for timer and quick access)
      const gameInstance = this.games.get(gameId);
      if (gameInstance) {
        gameInstance.gameState.board = updatedGame.gameData.board; // Sync in-memory board
        gameInstance.gameState.currentTurn = updatedGame.currentTurn;
        gameInstance.gameState.status = updatedGame.status;
        // Reset timer for next player's turn or end timer if game finished
        if (updatedGame.status === 'PLAYING' && !isExtraTurn) {
          this.startGameTimer(gameId); // Restart timer for the new player
        } else if (updatedGame.status === 'PLAYING' && isExtraTurn) {
          // Keep timer running if extra turn for same player, but reset if you have turn-based timers
          // For a game-long timer, no action needed here. If per-turn timer, reset it.
        } else if (updatedGame.status === 'FINISHED') {
          if (gameInstance.timer) clearTimeout(gameInstance.timer);
        }
      }

      // Prepare scores for client broadcast
      const currentScores = {};
      Object.keys(board).forEach(color => {
        if (board[color].playerId) {
          currentScores[board[color].playerId] = board[color].score;
        }
      });

      // Broadcast move result to all players in game room
      this.io.to(`game:${gameId}`).emit('FAST_LUDO_PIECE_MOVED', {
        playerId, // Player who moved
        pieceId,
        diceValue: diceValue,
        gameBoard: updatedGame.gameData.board, // Send the entire updated board from DB
        scores: currentScores,
        nextTurnIndex: updatedGame.currentTurn,
        nextPlayerId: updatedGame.participants[updatedGame.currentTurn].userId,
        isExtraTurn: isExtraTurn,
        killedPlayers: moveResult.killedPlayers // List of IDs of players whose pieces were killed
      });

      logger.info(`Fast Ludo: Player ${playerId} moved piece ${pieceId} with dice ${diceValue} in game ${gameId}.`);

      // If game is finished, broadcast end game event and process winnings
      if (updatedGame.status === 'FINISHED') {
        this.endGame(gameId, winnerId, 'completion'); // Calls processGameWinnings
        // Cleanup game instance from map
        this.games.delete(gameId);
      }
    } catch (error) {
      logger.error(`❌ Fast Ludo: Move piece error for player ${playerId}, piece ${pieceId} in game ${gameId}:`, error);
      socket.emit('FAST_LUDO_ERROR', { message: 'Failed to move piece.', details: error.message });
    } finally {
      this.releaseGameLock(gameId);
    }
  }

  async endGameByTimer(gameId) {
    logger.info(`Fast Ludo: Ending game ${gameId} by timer.`);
    const gameInstance = this.games.get(gameId);
    if (!gameInstance) {
      logger.warn(`Fast Ludo: Game instance ${gameId} not found for timer end.`);
      return;
    }

    // Get final scores from the in-memory board (or fetch latest from DB if preferred)
    const board = gameInstance.gameState.board;
    const scores = {};
    Object.keys(board).forEach(color => {
      if (board[color].playerId) {
        scores[board[color].playerId] = board[color].score;
      }
    });

    let winner = null;
    let highestScore = -Infinity;

    Object.keys(scores).forEach(playerId => {
      if (scores[playerId] > highestScore) {
        highestScore = scores[playerId];
        winner = playerId;
      }
    });

    if (highestScore === -Infinity || winner === null) {
      logger.warn(`Fast Ludo: Game ${gameId} ended by timer with no clear winner (scores were all 0 or negative).`);
      winner = null; // Explicitly set winner to null if no one scored positive
    }

    // Use the centralized endGame to handle DB update and cleanup
    await this.endGame(gameId, winner, 'timer');
    // Cleanup game instance from map
    this.games.delete(gameId);
  }

  /**
   * Finalizes a game, updates DB, emits end event, and processes winnings.
   * @param {string} gameId - The ID of the game.
   * @param {string|null} winnerId - The ID of the winning player, or null for a tie/no clear winner.
   * @param {string} reason - The reason for ending the game ('completion' or 'timer').
   */
  async endGame(gameId, winnerId, reason = 'completion') {
    logger.info(`Fast Ludo: Calling endGame for game ${gameId}. Winner: ${winnerId}, Reason: ${reason}`);
    const gameInstance = this.games.get(gameId);
    if (!gameInstance) {
      logger.warn(`Fast Ludo: Game instance ${gameId} not found during endGame call.`);
      return;
    }

    // Clear the game timer
    if (gameInstance.timer) {
      clearTimeout(gameInstance.timer);
      gameInstance.timer = null;
    }

    // Update game status and winner in the database
    const finalGame = await gameService.updateGameState(
      gameId,
      gameInstance.gameState.board, // Persist final board state
      gameInstance.gameState.currentTurn, // Keep last turn index
      'FINISHED',
      winnerId
    );

    // Get final scores (could be from updatedGame.gameData or a re-fetch if needed)
    const finalScores = {};
    Object.keys(finalGame.gameData.board).forEach(color => {
      if (finalGame.gameData.board[color].playerId) {
        finalScores[finalGame.gameData.board[color].playerId] = finalGame.gameData.board[color].score;
      }
    });

    this.io.to(`game:${gameId}`).emit('FAST_LUDO_GAME_ENDED', {
      winner: winnerId,
      reason,
      finalScores,
      gameBoard: finalGame.gameData.board // Send final board state
    });

    logger.info(`Fast Ludo game ${gameId} ended. Winner: ${winnerId}, Reason: ${reason}`);

    // Process winnings after the game is officially ended and state updated
    await gameService.processGameWinnings(gameId);
    
    // Explicitly make all sockets leave this game room
    // This is handled in server.js's 'gameFinished' emit block.
    // If not, it should be done here:
    /*
    this.io.sockets.in(`game:${gameId}`).allSockets().then(sockets => {
      sockets.forEach(sId => {
        const connectedSocket = this.io.sockets.sockets.get(sId);
        if (connectedSocket) connectedSocket.leave(`game:${gameId}`);
      });
    }).catch(err => {
      logger.error(`Error forcing sockets to leave game room ${gameId}:`, err);
    });
    */
    this.games.delete(gameId); // Remove game from in-memory map
  }

  /**
   * Handles a player joining a game room.
   * This is called both from matchmaking success and potentially directly by client.
   */
  async joinRoom(socket, { gameId, playerId, playerName }) {
    let gameInstance = this.games.get(gameId);
    
    if (!gameInstance) {
      // If game not in memory, try to fetch from DB to get initial state
      const gameFromDb = await gameService.getGameById(gameId);
      if (!gameFromDb) {
        logger.warn(`Fast Ludo: Player ${playerName} tried to join non-existent game ${gameId}.`);
        return socket.emit('FAST_LUDO_ERROR', { message: 'Game not found.' });
      }

      // Ensure participants are loaded
      if (!gameFromDb.participants) {
        logger.error(`Fast Ludo: Game ${gameId} loaded from DB without participants for joinRoom`);
        return socket.emit('FAST_LUDO_ERROR', { message: 'Game participants not available.' });
      }

      gameInstance = {
        id: gameId,
        players: gameFromDb.participants.map(p => ({id: p.userId, name: p.user?.name || 'Unknown', socketId: socket.id, color: p.color})), // Simplified player info
        gameState: {
          board: gameFromDb.gameData, // Initial board from DB
          currentTurn: gameFromDb.currentTurn,
          status: gameFromDb.status,
          diceValue: gameFromDb.gameData?.diceValue || null,
          diceRolled: gameFromDb.gameData?.diceRolled || false,
          startTime: gameFromDb.createdAt, // Or a specific game start time
          timerDuration: gameFromDb.maxPlayers === 2 ? 300000 : 600000, // Re-calculate or fetch from game.gameData
          endTime: gameFromDb.gameData?.endTime || (gameFromDb.createdAt.getTime() + (gameFromDb.maxPlayers === 2 ? 300000 : 600000))
        },
        timer: null
      };
      this.games.set(gameId, gameInstance);
      logger.info(`Fast Ludo: Loaded game ${gameId} into memory for player ${playerName}.`);
    }

    // Update player's socketId in the in-memory game instance (if player array is present and mutable)
    const existingPlayer = gameInstance.players.find(p => p.id === playerId);
    if (existingPlayer) {
      existingPlayer.socketId = socket.id;
    } else {
      // This case should ideally not happen if matchmaking properly sets up participants
      // But if a player joins a game not listed in DB participants (e.g., direct join to ongoing game)
      logger.warn(`Fast Ludo: Player ${playerId} not found in game ${gameId} participants, adding them for in-memory tracking.`);
      gameInstance.players.push({
        id: playerId,
        name: playerName,
        socketId: socket.id
      });
    }

    // Join Socket.IO room for game-specific broadcasts
    socket.join(`game:${gameId}`);
    
    // Notify room about player joining
    this.io.to(`game:${gameId}`).emit('FAST_LUDO_PLAYER_JOINED', {
      playerId,
      playerName,
      playersCount: gameInstance.players.length,
      gameId // Provide gameId in emit for context
    });

    logger.info(`Fast Ludo: Player ${playerName} joined socket room 'game:${gameId}'. Total players in room: ${gameInstance.players.length}`);
    
    // Send current game state to the joining player (useful for late joiners or re-connections)
    socket.emit('FAST_LUDO_CURRENT_STATE', {
      gameBoard: gameInstance.gameState.board,
      scores: this.getScoresFromBoard(gameInstance.gameState.board), // Helper to extract scores
      currentPlayerId: gameInstance.players[gameInstance.gameState.currentTurn]?.id,
      status: gameInstance.gameState.status,
      timerEndTime: gameInstance.gameState.endTime
    });
  }

  // Helper to extract current scores from the board object
  getScoresFromBoard(board) {
    const scores = {};
    Object.keys(board).forEach(color => {
      if (board[color].playerId) {
        scores[board[color].playerId] = board[color].score;
      }
    });
    return scores;
  }

  canPlayerMove(board, playerId, diceValue) {
    const playerColor = gameService.getLudoPlayerColor(board, playerId);
    if (!playerColor) return false;

    const playerData = board[playerColor];
    
    // In Fast Ludo, all pieces start outside, so check if any piece can move
    for (const piece of playerData.pieces) {
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
      
      if (piece.position === 'board') {
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
}

module.exports = FastLudoService;