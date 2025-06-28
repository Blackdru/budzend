// MemoryGameService.js - Server-side socket handlers (Node.js)
const logger = require('../config/logger');
const gameService = require('./gameService');
const prisma = require('../config/database');

class MemoryGameService {
  constructor(io) {
    this.io = io;
    this.games = new Map();
    this.TURN_TIMER = 10000; // 10 seconds per turn
    this.turnTimers = new Map(); // Store turn timers
    
    // Start periodic validation of game instances
    this.startPeriodicValidation();
  }

  startPeriodicValidation() {
    // Check game instances every 30 seconds
    setInterval(async () => {
      for (const [gameId, gameInstance] of this.games.entries()) {
        if (!gameInstance.players || gameInstance.players.length === 0) {
          logger.warn(`Memory Game: Detected corrupted game instance ${gameId}, attempting recovery`);
          await this.validateAndRecoverGameInstance(gameId);
        }
      }
    }, 30000); // 30 seconds
  }

  // Helper function to safely update game instance
  safeUpdateGameInstance(gameId, updates) {
    const gameInstance = this.games.get(gameId);
    if (!gameInstance) {
      logger.error(`Memory Game: Cannot update non-existent game instance ${gameId}`);
      return false;
    }

    // Preserve players array
    const originalPlayers = gameInstance.players;
    
    // Apply updates
    Object.assign(gameInstance, updates);
    
    // Ensure players array is not corrupted
    if (!gameInstance.players || gameInstance.players.length === 0) {
      logger.warn(`Memory Game: Players array corrupted during update for ${gameId}, restoring`);
      gameInstance.players = originalPlayers;
    }

    return true;
  }

  setupSocketHandlers(socket) {
    socket.on('START_MEMORY_GAME', (data) => this.startGame(data));
    socket.on('SELECT_MEMORY_CARD', (data) => this.selectCard(socket, data));
    socket.on('selectCard', (data) => this.selectCard(socket, data)); // Also handle server.js event
    socket.on('JOIN_MEMORY_ROOM', (data) => this.joinRoom(socket, data));
  }

  // Helper function to validate and recover game instance
  async validateAndRecoverGameInstance(gameId) {
    const gameInstance = this.games.get(gameId);
    if (!gameInstance) {
      logger.error(`Memory Game: Game instance not found for ${gameId}`);
      return null;
    }

    // Check if players array is valid
    if (!gameInstance.players || !Array.isArray(gameInstance.players) || gameInstance.players.length === 0) {
      logger.warn(`Memory Game: Invalid players array detected for ${gameId}, attempting recovery`);
      
      try {
        const gameFromDb = await gameService.getGameById(gameId);
        if (gameFromDb && gameFromDb.participants && gameFromDb.participants.length > 0) {
          const recoveredPlayers = gameFromDb.participants.map((p, index) => ({
            id: p.userId,
            name: p.user?.name || p.user?.username || p.userName || `Player ${index + 1}`,
            position: p.position || index
          }));
          
          gameInstance.players = recoveredPlayers;
          
          // Validate and fix game state
          if (!gameInstance.gameState.currentTurnPlayerId || 
              typeof gameInstance.gameState.currentTurnIndex !== 'number' ||
              gameInstance.gameState.currentTurnIndex >= recoveredPlayers.length) {
            gameInstance.gameState.currentTurnIndex = 0;
            gameInstance.gameState.currentTurnPlayerId = recoveredPlayers[0].id;
          }
          
          logger.info(`Memory Game: Successfully recovered ${recoveredPlayers.length} players for ${gameId}`);
          return gameInstance;
        } else {
          logger.error(`Memory Game: Could not recover players from database for ${gameId}`);
          return null;
        }
      } catch (error) {
        logger.error(`Memory Game: Error during game instance recovery for ${gameId}:`, error);
        return null;
      }
    }

    return gameInstance;
  }

  formatScoresForFrontend(players, scores) {
    // Convert player ID based scores to score1, score2 format
    const formattedScores = { score1: 0, score2: 0 };
    
    if (players && players.length >= 2) {
      formattedScores.score1 = scores[players[0].id] || 0;
      formattedScores.score2 = scores[players[1].id] || 0;
    }
    
    return formattedScores;
  }

  startTurnTimer(gameId, playerId) {
    // Clear existing timer
    if (this.turnTimers.has(gameId)) {
      clearTimeout(this.turnTimers.get(gameId));
    }

    const gameInstance = this.games.get(gameId);
    const currentPlayerData = gameInstance?.players?.find(p => p.id === playerId);

    // Start new timer
    const timer = setTimeout(() => {
      this.handleTurnTimeout(gameId, playerId);
    }, this.TURN_TIMER);

    this.turnTimers.set(gameId, timer);

    // Notify players about timer start
    this.io.to(`game:${gameId}`).emit('MEMORY_TURN_TIMER', {
      playerId,
      playerName: currentPlayerData?.name || 'Unknown',
      timeLeft: this.TURN_TIMER / 1000, // Send in seconds
      totalTime: this.TURN_TIMER / 1000
    });

    // Send countdown updates every second
    let timeLeft = this.TURN_TIMER / 1000;
    const countdownInterval = setInterval(() => {
      timeLeft--;
      if (timeLeft > 0) {
        this.io.to(`game:${gameId}`).emit('MEMORY_TURN_TIMER_UPDATE', {
          playerId,
          playerName: currentPlayerData?.name || 'Unknown',
          timeLeft: timeLeft
        });
      } else {
        clearInterval(countdownInterval);
      }
    }, 1000);

    // Store countdown interval for cleanup
    if (!this.countdownIntervals) {
      this.countdownIntervals = new Map();
    }
    this.countdownIntervals.set(gameId, countdownInterval);
  }

handleTurnTimeout(gameId, playerId) {
  const gameInstance = this.games.get(gameId);
  if (!gameInstance || gameInstance.gameState.currentTurnPlayerId !== playerId) {
    return;
  }

  // Auto-skip turn
  this.skipTurn(gameId);
}

skipTurn(gameId) {
  const gameInstance = this.games.get(gameId);
  if (!gameInstance) {
    logger.error(`Memory Game: Game instance not found for ${gameId} during skipTurn`);
    return;
  }

  // Validate that players array exists and has valid data
  if (!gameInstance.players || gameInstance.players.length === 0) {
    logger.error(`Memory Game: No players found in game ${gameId} during skipTurn`);
    logger.error(`Memory Game: Game instance structure:`, JSON.stringify(gameInstance, null, 2));
    
    // Attempt to recover players from database
    logger.info(`Memory Game: Attempting to recover players from database in skipTurn for ${gameId}`);
    try {
      const gameFromDbForRecovery = gameService.getGameById(gameId);
      if (gameFromDbForRecovery && gameFromDbForRecovery.participants) {
        const recoveredPlayers = gameFromDbForRecovery.participants.map((p, index) => ({
          id: p.userId,
          name: p.user?.name || p.user?.username || p.userName || `Player ${index + 1}`,
          position: p.position || index
        }));
        
        if (recoveredPlayers.length > 0) {
          logger.info(`Memory Game: Recovered ${recoveredPlayers.length} players in skipTurn for ${gameId}`);
          gameInstance.players = recoveredPlayers;
          
          // Reset turn to first player
          gameInstance.gameState.currentTurnIndex = 0;
          gameInstance.gameState.currentTurnPlayerId = recoveredPlayers[0].id;
        } else {
          logger.error(`Memory Game: Could not recover any players in skipTurn for ${gameId}`);
          return;
        }
      } else {
        logger.error(`Memory Game: Could not find game in database for recovery in skipTurn ${gameId}`);
        return;
      }
    } catch (recoveryError) {
      logger.error(`Memory Game: Error during player recovery in skipTurn for ${gameId}:`, recoveryError);
      return;
    }
  }

  // Clear any selected cards
  gameInstance.gameState.selectedCards = [];

  // Validate and fix currentTurnIndex if needed
  if (typeof gameInstance.gameState.currentTurnIndex !== 'number' || isNaN(gameInstance.gameState.currentTurnIndex)) {
    logger.warn(`Memory Game: Invalid currentTurnIndex in skipTurn for ${gameId}, resetting to 0`);
    gameInstance.gameState.currentTurnIndex = 0;
  }

  if (gameInstance.gameState.currentTurnIndex >= gameInstance.players.length) {
    logger.warn(`Memory Game: currentTurnIndex out of bounds in skipTurn for ${gameId}, resetting to 0`);
    gameInstance.gameState.currentTurnIndex = 0;
  }

  // Get the current player ID before changing turn
  const currentPlayerIndex = gameInstance.gameState.currentTurnIndex;
  const currentPlayer = gameInstance.players[currentPlayerIndex];
  
  if (!currentPlayer) {
    logger.error(`Memory Game: Current player not found at index ${currentPlayerIndex} in game ${gameId}`);
    logger.error(`Memory Game: Available players:`, gameInstance.players);
    logger.error(`Memory Game: Current turn index:`, currentPlayerIndex);
    return;
  }

  const skippedPlayerId = currentPlayer.id;

  // Move to next player safely
  const playersCount = gameInstance.players.length;
  const nextTurnIndex = (currentPlayerIndex + 1) % playersCount;
  gameInstance.gameState.currentTurnIndex = nextTurnIndex;
  
  const nextPlayer = gameInstance.players[nextTurnIndex];
  if (!nextPlayer) {
    logger.error(`Memory Game: Next player not found at index ${nextTurnIndex} in game ${gameId}`);
    logger.error(`Memory Game: Available players:`, gameInstance.players);
    logger.error(`Memory Game: Current index:`, currentPlayerIndex);
    logger.error(`Memory Game: Next index:`, nextTurnIndex);
    logger.error(`Memory Game: Players count:`, playersCount);
    return;
  }
  
  gameInstance.gameState.currentTurnPlayerId = nextPlayer.id;

  // Clear any existing timer and countdown
  if (this.turnTimers.has(gameId)) {
    clearTimeout(this.turnTimers.get(gameId));
    this.turnTimers.delete(gameId);
  }
  if (this.countdownIntervals && this.countdownIntervals.has(gameId)) {
    clearInterval(this.countdownIntervals.get(gameId));
    this.countdownIntervals.delete(gameId);
  }

  logger.info(`Memory Game: Turn skipped from ${skippedPlayerId} to ${nextPlayer.id} in game ${gameId}`);

  this.io.to(`game:${gameId}`).emit('MEMORY_TURN_SKIPPED', {
    skippedPlayerId: skippedPlayerId,
    nextPlayerId: gameInstance.gameState.currentTurnPlayerId,
    nextPlayerName: nextPlayer.name
  });

  this.io.to(`game:${gameId}`).emit('MEMORY_GAME_CURRENT_TURN', {
    currentPlayer: gameInstance.gameState.currentTurnPlayerId,
    currentPlayerId: gameInstance.gameState.currentTurnPlayerId,
    currentPlayerName: nextPlayer.name
  });

  // Start timer for next player
  this.startTurnTimer(gameId, gameInstance.gameState.currentTurnPlayerId);
}

 async startGame({ roomId }) {
  try {
    logger.info(`Memory Game: startGame called with roomId: ${roomId}`);
    
    // Validate roomId parameter
    if (!roomId || typeof roomId !== 'string') {
      logger.error(`Memory Game: Invalid roomId provided for starting: ${roomId}`);
      this.io.to(`game:${roomId}`).emit('MEMORY_GAME_ERROR', { message: 'Invalid room ID provided.' });
      return;
    }

    logger.info(`Memory Game: Starting game ${roomId}`);
    let game = await gameService.getGameById(roomId);
    logger.info(`Memory Game: Retrieved game from database:`, game ? 'Found' : 'Not found');
    
    if (!game) {
      logger.error(`Memory Game: Game ${roomId} not found for starting.`);
      this.io.to(`game:${roomId}`).emit('MEMORY_GAME_ERROR', { message: 'Game not found.' });
      return;
    }

    // Add detailed logging to debug the game object structure
    logger.info(`Memory Game: Game ${roomId} structure:`, JSON.stringify(game, null, 2));

    logger.info(`Memory Game: Game participants:`, game.participants?.length || 0);
    if (!game.participants || game.participants.length < 2) {
      logger.warn(`Memory Game: Not enough players in game ${roomId}. Current: ${game.participants?.length || 0}`);
      this.io.to(`game:${roomId}`).emit('MEMORY_GAME_ERROR', { message: 'Not enough players to start game.' });
      return;
    }

    logger.info(`Memory Game: Initializing game board for ${roomId}`);
    const initialBoard = gameService.initializeMemoryGameBoard();
    logger.info(`Memory Game: Board initialized:`, initialBoard ? `${initialBoard.length} cards` : 'Failed');
    
    if (!initialBoard || !Array.isArray(initialBoard) || initialBoard.length === 0) {
      logger.error(`Memory Game: Failed to initialize game board for ${roomId}`);
      this.io.to(`game:${roomId}`).emit('MEMORY_GAME_ERROR', { message: 'Failed to initialize game board.' });
      return;
    }

    const turnIndex = 0;
    const currentTurnUserId = game.participants[turnIndex]?.userId;
    logger.info(`Memory Game: First player determined: ${currentTurnUserId}`);
    
    if (!currentTurnUserId) {
      logger.error(`Memory Game: No valid user found for first turn in game ${roomId}`);
      this.io.to(`game:${roomId}`).emit('MEMORY_GAME_ERROR', { message: 'Failed to determine first player.' });
      return;
    }

    logger.info(`Memory Game: Updating game state for ${roomId}, first player: ${currentTurnUserId}`);
    game = await gameService.updateGameState(roomId, initialBoard, turnIndex, 'PLAYING', null);
    logger.info(`Memory Game: Game state updated:`, game ? 'Success' : 'Failed');
    
    if (!game) {
      logger.error(`Memory Game: Failed to update game state for ${roomId}`);
      this.io.to(`game:${roomId}`).emit('MEMORY_GAME_ERROR', { message: 'Failed to update game state.' });
      return;
    }

    logger.info(`Memory Game: Setting up in-memory game instance for ${roomId}`);
    
    // Safely create players array with null checks and detailed logging
    const players = game.participants ? game.participants.map((p, index) => {
      const playerData = {
        id: p.userId, 
        name: p.user?.name || p.user?.username || p.userName || `Player ${index + 1}`,
        position: p.position || index
      };
      logger.info(`Memory Game: Player ${index}: ${JSON.stringify(playerData)}`);
      return playerData;
    }) : [];

    logger.info(`Memory Game: Created players array with ${players.length} players for ${roomId}`);

    const gameInstance = {
      id: roomId,
      players: players,
      gameState: {
        board: initialBoard,
        currentTurnIndex: Number(turnIndex) || 0, // Ensure it's a number
        currentTurnPlayerId: currentTurnUserId,
        selectedCards: [],
        scores: {},
        matchedPairs: 0,
        status: 'playing',
      }
    };

    // Validate the game instance before setting
    if (typeof gameInstance.gameState.currentTurnIndex !== 'number') {
      logger.warn(`Memory Game: Invalid currentTurnIndex type, setting to 0 for ${roomId}`);
      gameInstance.gameState.currentTurnIndex = 0;
    }

    if (gameInstance.gameState.currentTurnIndex >= players.length) {
      logger.warn(`Memory Game: currentTurnIndex out of bounds, setting to 0 for ${roomId}`);
      gameInstance.gameState.currentTurnIndex = 0;
    }

    this.games.set(roomId, gameInstance);
    logger.info(`Memory Game: Game instance created for ${roomId} with ${gameInstance.players.length} players`);
    logger.info(`Memory Game: Players:`, gameInstance.players.map(p => ({ id: p.id, name: p.name })));

    logger.info(`Memory Game: Initializing player scores for ${roomId}`);
    if (game.participants) {
      game.participants.forEach(p => {
        this.games.get(roomId).gameState.scores[p.userId] = 0;
      });
    }

    logger.info(`Memory Game: Formatting scores for frontend`);
    const formattedScores = this.formatScoresForFrontend(
      players, 
      this.games.get(roomId).gameState.scores
    );

    logger.info(`Memory Game: Emitting MEMORY_GAME_STARTED for ${roomId}`);
    this.io.to(`game:${roomId}`).emit('MEMORY_GAME_STARTED', {
      gameBoard: initialBoard.map(card => ({
        id: card.id,
        isFlipped: false,
        isMatched: false
      })),
      players: players,
      initialScores: formattedScores,
      totalPairs: 11 // 11 pairs for odd number
    });

    logger.info(`Memory Game: Emitting MEMORY_GAME_CURRENT_TURN for ${roomId}`);
    const currentPlayerData = players.find(p => p.id === currentTurnUserId);
    this.io.to(`game:${roomId}`).emit('MEMORY_GAME_CURRENT_TURN', {
      currentPlayer: currentTurnUserId,
      currentPlayerId: currentTurnUserId,
      currentPlayerName: currentPlayerData?.name || 'Unknown',
      players: players
    });

    // Start timer for first player
    logger.info(`Memory Game: Starting turn timer for ${roomId}`);
    this.startTurnTimer(roomId, currentTurnUserId);
    
    logger.info(`Memory Game: Game ${roomId} successfully started with 11 pairs and ${players.length} players.`);
  } catch (error) {
    logger.error(`Memory Game: Error starting game ${roomId}:`, error);
    logger.error(`Memory Game: Error stack:`, error.stack);
    this.io.to(`game:${roomId}`).emit('MEMORY_GAME_ERROR', { 
      message: 'Failed to start game.',
      error: error.message,
      details: 'Check server logs for more information'
    });
  }
}

  async selectCard(socket, data) {
    try {
      // Handle both roomId (from frontend) and gameId (from server.js)
      const gameId = data.gameId || data.roomId;
      const playerId = data.playerId || socket.user?.id;
      const position = data.position;

      if (!gameId || playerId === undefined || position === undefined) {
        logger.warn('Memory Game: Invalid selectCard parameters:', data);
        return socket.emit('MEMORY_GAME_ERROR', { message: 'Invalid card selection parameters.' });
      }

      const gameFromDb = await gameService.getGameById(gameId);
      if (!gameFromDb || gameFromDb.status !== 'PLAYING') {
        return socket.emit('MEMORY_GAME_ERROR', { message: 'Game not found or not playing.' });
      }

      // Validate and recover game instance if needed
      const gameInstance = await this.validateAndRecoverGameInstance(gameId);
      if (!gameInstance || gameInstance.gameState.currentTurnPlayerId !== playerId) {
        return socket.emit('MEMORY_GAME_ERROR', { message: 'Not your turn.' });
      }

      let currentBoard = gameFromDb.gameData;
      let selectedCardsInTurn = gameInstance.gameState.selectedCards;

      const selectionResult = gameService.applyMemoryCardSelection(currentBoard, position, selectedCardsInTurn);

      if (!selectionResult.success) {
        return socket.emit('MEMORY_GAME_ERROR', { message: selectionResult.message });
      }

      gameInstance.gameState.selectedCards = selectionResult.selectedCardsInTurn;

      await gameService.updateGameState(gameId, currentBoard, gameFromDb.currentTurn, 'PLAYING', null);
      gameInstance.gameState.board = currentBoard;

      this.io.to(`game:${gameId}`).emit('MEMORY_CARD_OPENED', {
        position,
        symbol: selectionResult.updatedCard.symbol,
        playerId
      });

      if (gameInstance.gameState.selectedCards.length === 2) {
        // Clear turn timer when 2 cards selected
        if (this.turnTimers.has(gameId)) {
          clearTimeout(this.turnTimers.get(gameId));
          this.turnTimers.delete(gameId);
        }
        if (this.countdownIntervals && this.countdownIntervals.has(gameId)) {
          clearInterval(this.countdownIntervals.get(gameId));
          this.countdownIntervals.delete(gameId);
        }
        setTimeout(() => this.checkMatch(gameId), 1000);
      }
    } catch (error) {
      logger.error(`Memory Game: Select card error:`, error);
      socket.emit('MEMORY_GAME_ERROR', { message: 'Failed to select card.' });
    }
  }

  async checkMatch(gameId) {
    try {
      const gameInstance = this.games.get(gameId);
      if (!gameInstance) {
        logger.error(`Memory Game: Game instance not found for ${gameId} in checkMatch`);
        return;
      }

      // Log current state for debugging
      logger.info(`Memory Game: checkMatch called for ${gameId}`);
      logger.info(`Memory Game: Game instance has ${gameInstance.players?.length || 0} players`);
      if (gameInstance.players && gameInstance.players.length > 0) {
        logger.info(`Memory Game: Players:`, gameInstance.players.map(p => ({ id: p.id, name: p.name })));
      }

      // Validate game state
      if (!gameInstance.gameState) {
        logger.error(`Memory Game: Game state not found for ${gameId} in checkMatch`);
        return;
      }

      // Validate players array and attempt recovery
      if (!gameInstance.players || !Array.isArray(gameInstance.players) || gameInstance.players.length === 0) {
        logger.error(`Memory Game: No valid players array for ${gameId} in checkMatch`);
        logger.error(`Memory Game: Players:`, gameInstance.players);
        logger.error(`Memory Game: Game instance:`, JSON.stringify(gameInstance, null, 2));
        
        // Attempt to recover players from database
        logger.info(`Memory Game: Attempting to recover players from database for ${gameId}`);
        try {
          const gameFromDbForRecovery = await gameService.getGameById(gameId);
          if (gameFromDbForRecovery && gameFromDbForRecovery.participants) {
            const recoveredPlayers = gameFromDbForRecovery.participants.map((p, index) => ({
              id: p.userId,
              name: p.user?.name || p.user?.username || p.userName || `Player ${index + 1}`,
              position: p.position || index
            }));
            
            if (recoveredPlayers.length > 0) {
              logger.info(`Memory Game: Recovered ${recoveredPlayers.length} players for ${gameId}`);
              gameInstance.players = recoveredPlayers;
              
              // Also fix currentTurnIndex if needed
              if (typeof gameInstance.gameState.currentTurnIndex !== 'number' || 
                  gameInstance.gameState.currentTurnIndex >= recoveredPlayers.length) {
                gameInstance.gameState.currentTurnIndex = 0;
                gameInstance.gameState.currentTurnPlayerId = recoveredPlayers[0].id;
                logger.info(`Memory Game: Reset turn to first player for ${gameId}`);
              }
            } else {
              logger.error(`Memory Game: Could not recover any players for ${gameId}`);
              return;
            }
          } else {
            logger.error(`Memory Game: Could not find game in database for recovery ${gameId}`);
            return;
          }
        } catch (recoveryError) {
          logger.error(`Memory Game: Error during player recovery for ${gameId}:`, recoveryError);
          return;
        }
      }

      const gameFromDb = await gameService.getGameById(gameId);
      if (!gameFromDb) {
        logger.error(`Memory Game: Game not found in database for ${gameId} in checkMatch`);
        return;
      }

      let currentBoard = gameFromDb.gameData;
      const gameState = gameInstance.gameState;

      const [card1Selection, card2Selection] = gameState.selectedCards;
      if (!card1Selection || !card2Selection) {
        gameState.selectedCards = [];
        return;
      }

      // Validate and fix currentTurnIndex
      if (typeof gameState.currentTurnIndex !== 'number' || isNaN(gameState.currentTurnIndex)) {
        logger.warn(`Memory Game: Invalid currentTurnIndex (${gameState.currentTurnIndex}) for ${gameId}, resetting to 0`);
        gameState.currentTurnIndex = 0;
      }

      // Ensure currentTurnIndex is within bounds
      if (gameState.currentTurnIndex >= gameInstance.players.length) {
        logger.warn(`Memory Game: currentTurnIndex (${gameState.currentTurnIndex}) out of bounds for ${gameId}, resetting to 0`);
        gameState.currentTurnIndex = 0;
      }

      let scoresToUpdate = { ...gameState.scores };
      let nextTurnIndex = gameState.currentTurnIndex;
      let gameStatus = 'PLAYING';
      let winnerId = null;

      logger.info(`Memory Game: checkMatch for ${gameId} - currentTurnIndex: ${gameState.currentTurnIndex}, players: ${gameInstance.players.length}`);

      if (card1Selection.symbol === card2Selection.symbol) {
        // Match found!
        currentBoard[card1Selection.position].isMatched = true;
        currentBoard[card2Selection.position].isMatched = true;
        
        scoresToUpdate[gameState.currentTurnPlayerId] = (scoresToUpdate[gameState.currentTurnPlayerId] || 0) + 10;
        gameState.matchedPairs += 1;

        // Convert scores to expected format (score1, score2)
        const formattedScores = this.formatScoresForFrontend(gameInstance.players, scoresToUpdate);
        
        this.io.to(`game:${gameId}`).emit('MEMORY_CARDS_MATCHED', {
          positions: [card1Selection.position, card2Selection.position],
          playerId: gameState.currentTurnPlayerId,
          scores: formattedScores
        });

        // Check if game is finished (11 pairs matched)
        if (gameState.matchedPairs === 11) {
          gameStatus = 'FINISHED';
          let highestScore = -1;
          for (const pId in scoresToUpdate) {
            if (scoresToUpdate[pId] > highestScore) {
              highestScore = scoresToUpdate[pId];
              winnerId = pId;
            }
          }
        } else {
          // Player gets another turn for matching
          this.startTurnTimer(gameId, gameState.currentTurnPlayerId);
        }
      } else {
        // No match - cards will be flipped back after a delay
        // First emit that cards don't match so frontend can show them briefly
        this.io.to(`game:${gameId}`).emit('MEMORY_CARDS_REVEALED', {
          positions: [card1Selection.position, card2Selection.position],
          symbols: [card1Selection.symbol, card2Selection.symbol],
          matched: false
        });

        // Wait 1.5 seconds then flip cards back and change turn
        setTimeout(async () => {
          // Flip cards back in database
          currentBoard[card1Selection.position].isFlipped = false;
          currentBoard[card2Selection.position].isFlipped = false;
        
        // Calculate next turn index safely
        const currentIndex = gameState.currentTurnIndex;
        const playersCount = gameInstance.players.length;
        
        logger.info(`Memory Game: Calculating next turn - current: ${currentIndex}, players: ${playersCount}`);
        
        if (playersCount === 0) {
          logger.error(`Memory Game: No players available for turn calculation in ${gameId}`);
          return;
        }
        
        nextTurnIndex = (currentIndex + 1) % playersCount;
        gameState.currentTurnIndex = nextTurnIndex;
        
        logger.info(`Memory Game: Next turn index calculated: ${nextTurnIndex}`);
        
        // Safely get next player
        const nextPlayer = gameInstance.players[nextTurnIndex];
        if (!nextPlayer) {
          logger.error(`Memory Game: Next player not found at index ${nextTurnIndex} in checkMatch for game ${gameId}`);
          logger.error(`Memory Game: Available players:`, gameInstance.players);
          logger.error(`Memory Game: Current turn index:`, gameState.currentTurnIndex);
          logger.error(`Memory Game: Calculated next index:`, nextTurnIndex);
          logger.error(`Memory Game: Players count:`, playersCount);
          return;
        }
        
        gameState.currentTurnPlayerId = nextPlayer.id;

        logger.info(`Memory Game: Turn changed to player ${nextPlayer.id} (${nextPlayer.name}) at index ${nextTurnIndex}`);

        this.io.to(`game:${gameId}`).emit('MEMORY_CARDS_MISMATCHED', {
          positions: [card1Selection.position, card2Selection.position],
          nextPlayerId: gameState.currentTurnPlayerId,
          nextPlayerName: nextPlayer.name
        });

        // Update database with flipped back cards and new turn
          await gameService.updateGameState(gameId, currentBoard, nextTurnIndex, gameStatus, winnerId);

          // Emit cards mismatched event to flip them back on frontend
          this.io.to(`game:${gameId}`).emit('MEMORY_CARDS_MISMATCHED', {
            positions: [card1Selection.position, card2Selection.position],
            nextPlayerId: gameState.currentTurnPlayerId,
            nextPlayerName: nextPlayer.name
          });

          // Emit current turn update
          this.io.to(`game:${gameId}`).emit('MEMORY_GAME_CURRENT_TURN', {
            currentPlayer: gameState.currentTurnPlayerId,
            currentPlayerId: gameState.currentTurnPlayerId,
            currentPlayerName: nextPlayer.name,
            players: gameInstance.players
          });

          // Start timer for next player
          this.startTurnTimer(gameId, gameState.currentTurnPlayerId);
        }, 1500);

        // Don't update database immediately for mismatched cards
        gameState.selectedCards = [];
        return;
      }

      await gameService.updateGameState(gameId, currentBoard, nextTurnIndex, gameStatus, winnerId);
      
      for (const pId in scoresToUpdate) {
        await gameService.updatePlayerScore(gameId, pId, scoresToUpdate[pId]);
      }
      gameInstance.gameState.scores = scoresToUpdate;

      if (gameStatus === 'PLAYING') {
        const currentPlayerData = gameInstance.players.find(p => p.id === gameState.currentTurnPlayerId);
        this.io.to(`game:${gameId}`).emit('MEMORY_GAME_CURRENT_TURN', {
          currentPlayer: gameState.currentTurnPlayerId,
          currentPlayerId: gameState.currentTurnPlayerId,
          currentPlayerName: currentPlayerData?.name || 'Unknown',
          players: gameInstance.players
        });
      }

      gameState.selectedCards = [];

      if (gameStatus === 'FINISHED') {
        // Clear any remaining timers
        if (this.turnTimers.has(gameId)) {
          clearTimeout(this.turnTimers.get(gameId));
          this.turnTimers.delete(gameId);
        }
        if (this.countdownIntervals && this.countdownIntervals.has(gameId)) {
          clearInterval(this.countdownIntervals.get(gameId));
          this.countdownIntervals.delete(gameId);
        }
        await this.endGame(gameId, winnerId, scoresToUpdate);
      }

    } catch (error) {
      logger.error(`Memory Game: Check match error:`, error);
      const gameInstance = this.games.get(gameId);
      if (gameInstance) gameInstance.gameState.selectedCards = [];
    }
  }

  async endGame(roomId, winnerId, finalScores) {
    const gameInstance = this.games.get(roomId);
    const formattedScores = gameInstance ? 
      this.formatScoresForFrontend(gameInstance.players, finalScores) : 
      { score1: 0, score2: 0 };

    this.io.to(`game:${roomId}`).emit('MEMORY_GAME_ENDED', {
      winner: winnerId,
      finalScores: formattedScores,
      gameType: 'memory',
    });

    await gameService.processGameWinnings(roomId);
    this.games.delete(roomId);
  }

  async joinRoom(socket, { roomId, playerId, playerName }) {
    let gameInstance = this.games.get(roomId);
    
    if (!gameInstance) {
      const gameFromDb = await gameService.getGameById(roomId);
      if (!gameFromDb) {
        return socket.emit('MEMORY_GAME_ERROR', { message: 'Game not found.' });
      }

      // Create players array with proper fallbacks
      const players = gameFromDb.participants ? gameFromDb.participants.map((p, index) => ({
        id: p.userId, 
        name: p.user?.name || p.user?.username || p.userName || playerName || `Player ${index + 1}`,
        position: p.position || index
      })) : [];

      // Ensure currentTurn is a valid number
      const currentTurnIndex = Number(gameFromDb.currentTurn) || 0;
      const validCurrentTurnIndex = Math.max(0, Math.min(currentTurnIndex, players.length - 1));
      
      gameInstance = {
        id: roomId,
        players: players,
        gameState: {
          board: gameFromDb.gameData,
          currentTurnIndex: validCurrentTurnIndex,
          currentTurnPlayerId: gameFromDb.participants[validCurrentTurnIndex]?.userId,
          selectedCards: [],
          scores: {},
          matchedPairs: 0,
          status: gameFromDb.status,
        }
      };
      
      // Validate the recreated game instance
      if (!gameInstance.gameState.currentTurnPlayerId && players.length > 0) {
        logger.warn(`Memory Game: No valid currentTurnPlayerId found, using first player for ${roomId}`);
        gameInstance.gameState.currentTurnIndex = 0;
        gameInstance.gameState.currentTurnPlayerId = players[0].id;
      }
      
      this.games.set(roomId, gameInstance);
      logger.info(`Memory Game: Recreated game instance for ${roomId} with ${players.length} players, currentTurnIndex: ${validCurrentTurnIndex}`);
    }

    socket.join(`game:${roomId}`);
    
    this.io.to(`game:${roomId}`).emit('MEMORY_PLAYER_JOINED', {
      playerId,
      playerName,
      playersCount: gameInstance.players.length,
      gameId: roomId
    });

    // Send current game state to the joining player
    const gameBoard = gameInstance.gameState.board;
    if (gameBoard && Array.isArray(gameBoard)) {
      const formattedScores = this.formatScoresForFrontend(gameInstance.players, gameInstance.gameState.scores);
      const currentPlayerData = gameInstance.players.find(p => p.id === gameInstance.gameState.currentTurnPlayerId);
      
      socket.emit('MEMORY_CURRENT_STATE', {
        gameBoard: gameBoard.map(card => ({
          id: card.id,
          isFlipped: card.isFlipped,
          isMatched: card.isMatched,
          symbol: card.isFlipped || card.isMatched ? card.symbol : null
        })),
        scores: formattedScores,
        currentPlayerId: gameInstance.gameState.currentTurnPlayerId,
        currentPlayerName: currentPlayerData?.name || 'Unknown',
        status: gameInstance.gameState.status,
        matchedPairs: gameInstance.gameState.matchedPairs || 0,
        totalPairs: 11,
        players: gameInstance.players
      });
    } else {
      logger.warn(`Memory Game: Invalid game board for room ${roomId}, cannot send current state`);
      socket.emit('MEMORY_GAME_ERROR', { message: 'Game state not properly initialized.' });
    }
  }
}

module.exports = MemoryGameService;