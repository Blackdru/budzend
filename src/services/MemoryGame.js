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
  }

  setupSocketHandlers(socket) {
    socket.on('START_MEMORY_GAME', (data) => this.startGame(data));
    socket.on('SELECT_MEMORY_CARD', (data) => this.selectCard(socket, data));
    socket.on('selectCard', (data) => this.selectCard(socket, data)); // Also handle server.js event
    socket.on('JOIN_MEMORY_ROOM', (data) => this.joinRoom(socket, data));
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

    // Start new timer
    const timer = setTimeout(() => {
      this.handleTurnTimeout(gameId, playerId);
    }, this.TURN_TIMER);

    this.turnTimers.set(gameId, timer);

    // Notify players about timer
    this.io.to(`game:${gameId}`).emit('MEMORY_TURN_TIMER', {
      playerId,
      timeLeft: this.TURN_TIMER
    });
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
  if (!gameInstance) return;

  // Validate that players array exists and has valid data
  if (!gameInstance.players || gameInstance.players.length === 0) {
    logger.error(`Memory Game: No players found in game ${gameId} during skipTurn`);
    return;
  }

  // Clear any selected cards
  gameInstance.gameState.selectedCards = [];

  // Get the current player ID before changing turn
  const currentPlayerIndex = gameInstance.gameState.currentTurnIndex;
  const currentPlayer = gameInstance.players[currentPlayerIndex];
  
  if (!currentPlayer) {
    logger.error(`Memory Game: Current player not found at index ${currentPlayerIndex} in game ${gameId}`);
    return;
  }

  const skippedPlayerId = currentPlayer.id;

  // Move to next player
  const nextTurnIndex = (gameInstance.gameState.currentTurnIndex + 1) % gameInstance.players.length;
  gameInstance.gameState.currentTurnIndex = nextTurnIndex;
  
  const nextPlayer = gameInstance.players[nextTurnIndex];
  if (!nextPlayer) {
    logger.error(`Memory Game: Next player not found at index ${nextTurnIndex} in game ${gameId}`);
    return;
  }
  
  gameInstance.gameState.currentTurnPlayerId = nextPlayer.id;

  // Clear any existing timer
  if (this.turnTimers.has(gameId)) {
    clearTimeout(this.turnTimers.get(gameId));
    this.turnTimers.delete(gameId);
  }

  this.io.to(`game:${gameId}`).emit('MEMORY_TURN_SKIPPED', {
    skippedPlayerId: skippedPlayerId,
    nextPlayerId: gameInstance.gameState.currentTurnPlayerId
  });

  this.io.to(`game:${gameId}`).emit('MEMORY_GAME_CURRENT_TURN', {
    currentPlayer: gameInstance.gameState.currentTurnPlayerId,
    currentPlayerId: gameInstance.gameState.currentTurnPlayerId,
  });

  // Start timer for next player
  this.startTurnTimer(gameId, gameInstance.gameState.currentTurnPlayerId);
}
skipTurn(gameId) {
  const gameInstance = this.games.get(gameId);
  if (!gameInstance) return;

  // Validate that players array exists and has valid data
  if (!gameInstance.players || gameInstance.players.length === 0) {
    logger.error(`Memory Game: No players found in game ${gameId} during skipTurn`);
    return;
  }

  // Clear any selected cards
  gameInstance.gameState.selectedCards = [];

  // Get the current player ID before changing turn
  const currentPlayerIndex = gameInstance.gameState.currentTurnIndex;
  const currentPlayer = gameInstance.players[currentPlayerIndex];
  
  if (!currentPlayer) {
    logger.error(`Memory Game: Current player not found at index ${currentPlayerIndex} in game ${gameId}`);
    return;
  }

  const skippedPlayerId = currentPlayer.id;

  // Move to next player
  const nextTurnIndex = (gameInstance.gameState.currentTurnIndex + 1) % gameInstance.players.length;
  gameInstance.gameState.currentTurnIndex = nextTurnIndex;
  
  const nextPlayer = gameInstance.players[nextTurnIndex];
  if (!nextPlayer) {
    logger.error(`Memory Game: Next player not found at index ${nextTurnIndex} in game ${gameId}`);
    return;
  }
  
  gameInstance.gameState.currentTurnPlayerId = nextPlayer.id;

  // Clear any existing timer
  if (this.turnTimers.has(gameId)) {
    clearTimeout(this.turnTimers.get(gameId));
    this.turnTimers.delete(gameId);
  }

  this.io.to(`game:${gameId}`).emit('MEMORY_TURN_SKIPPED', {
    skippedPlayerId: skippedPlayerId,
    nextPlayerId: gameInstance.gameState.currentTurnPlayerId
  });

  this.io.to(`game:${gameId}`).emit('MEMORY_GAME_CURRENT_TURN', {
    currentPlayer: gameInstance.gameState.currentTurnPlayerId,
    currentPlayerId: gameInstance.gameState.currentTurnPlayerId,
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
    
    // Safely create players array with null checks
    const players = game.participants ? game.participants.map(p => ({
      id: p.userId, 
      name: p.user?.name || p.userName || 'Unknown'
    })) : [];

    this.games.set(roomId, {
      id: roomId,
      players: players,
      gameState: {
        board: initialBoard,
        currentTurnIndex: turnIndex,
        currentTurnPlayerId: currentTurnUserId,
        selectedCards: [],
        scores: {},
        matchedPairs: 0,
        status: 'playing',
      }
    });

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
    this.io.to(`game:${roomId}`).emit('MEMORY_GAME_CURRENT_TURN', {
      currentPlayer: currentTurnUserId,
      currentPlayerId: currentTurnUserId,
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

      const gameInstance = this.games.get(gameId);
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
      if (!gameInstance) return;

      const gameFromDb = await gameService.getGameById(gameId);
      let currentBoard = gameFromDb.gameData;
      const gameState = gameInstance.gameState;

      const [card1Selection, card2Selection] = gameState.selectedCards;
      if (!card1Selection || !card2Selection) {
        gameState.selectedCards = [];
        return;
      }

      let scoresToUpdate = { ...gameState.scores };
      let nextTurnIndex = gameState.currentTurnIndex;
      let gameStatus = 'PLAYING';
      let winnerId = null;

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
        // No match - flip cards back and change turn
        currentBoard[card1Selection.position].isFlipped = false;
        currentBoard[card2Selection.position].isFlipped = false;
        
        nextTurnIndex = (gameState.currentTurnIndex + 1) % gameInstance.players.length;
        gameState.currentTurnIndex = nextTurnIndex;
        gameState.currentTurnPlayerId = gameInstance.players[nextTurnIndex].id;

        this.io.to(`game:${gameId}`).emit('MEMORY_CARDS_MISMATCHED', {
          positions: [card1Selection.position, card2Selection.position],
          nextPlayerId: gameState.currentTurnPlayerId
        });

        // Start timer for next player
        this.startTurnTimer(gameId, gameState.currentTurnPlayerId);
      }

      await gameService.updateGameState(gameId, currentBoard, nextTurnIndex, gameStatus, winnerId);
      
      for (const pId in scoresToUpdate) {
        await gameService.updatePlayerScore(gameId, pId, scoresToUpdate[pId]);
      }
      gameInstance.gameState.scores = scoresToUpdate;

      if (gameStatus === 'PLAYING') {
        this.io.to(`game:${gameId}`).emit('MEMORY_GAME_CURRENT_TURN', {
          currentPlayer: gameState.currentTurnPlayerId,
          currentPlayerId: gameState.currentTurnPlayerId,
        });
      }

      gameState.selectedCards = [];

      if (gameStatus === 'FINISHED') {
        // Clear any remaining timers
        if (this.turnTimers.has(gameId)) {
          clearTimeout(this.turnTimers.get(gameId));
          this.turnTimers.delete(gameId);
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

      gameInstance = {
        id: roomId,
        players: gameFromDb.participants.map(p => ({id: p.userId, name: p.user.name})),
        gameState: {
          board: gameFromDb.gameData,
          currentTurnIndex: gameFromDb.currentTurn,
          currentTurnPlayerId: gameFromDb.participants[gameFromDb.currentTurn]?.userId,
          selectedCards: [],
          scores: {},
          matchedPairs: 0,
          status: gameFromDb.status,
        }
      };
      this.games.set(roomId, gameInstance);
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
      socket.emit('MEMORY_CURRENT_STATE', {
        gameBoard: gameBoard.map(card => ({
          id: card.id,
          isFlipped: card.isFlipped,
          isMatched: card.isMatched,
          symbol: card.isFlipped || card.isMatched ? card.symbol : null
        })),
        scores: gameInstance.gameState.scores || {},
        currentPlayerId: gameInstance.gameState.currentTurnPlayerId,
        status: gameInstance.gameState.status,
        matchedPairs: gameInstance.gameState.matchedPairs || 0,
        totalPairs: 11
      });
    } else {
      logger.warn(`Memory Game: Invalid game board for room ${roomId}, cannot send current state`);
      socket.emit('MEMORY_GAME_ERROR', { message: 'Game state not properly initialized.' });
    }
  }
}

module.exports = MemoryGameService;