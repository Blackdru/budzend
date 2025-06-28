const logger = require('../config/logger');
const gameService = require('./gameService');

class GameStateManager {
  constructor() {
    this.gameStates = new Map(); // gameId -> gameState
    this.gameLocks = new Map(); // gameId -> lock status
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) {
      logger.info('GameStateManager already initialized');
      return;
    }
    
    try {
      // Load active games from database into memory
      const activeGames = await gameService.getActiveGames();
      for (const game of activeGames) {
        this.setGameState(game.id, {
          id: game.id,
          type: game.type,
          status: game.status,
          currentTurn: game.currentTurn,
          gameData: game.gameData,
          participants: game.participants,
          winner: game.winner
        });
      }
      
      this.initialized = true;
      logger.info(`GameStateManager initialized successfully with ${activeGames.length} active games`);
    } catch (error) {
      logger.error('Failed to initialize GameStateManager:', error);
      throw error;
    }
  }

  async acquireLock(gameId, timeout = 5000) {
    const startTime = Date.now();
    while (this.gameLocks.has(gameId)) {
      if (Date.now() - startTime > timeout) {
        throw new Error(`Lock timeout for game ${gameId}`);
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    this.gameLocks.set(gameId, true);
  }

  releaseLock(gameId) {
    this.gameLocks.delete(gameId);
  }

  async withLock(gameId, operation) {
    await this.acquireLock(gameId);
    try {
      return await operation();
    } finally {
      this.releaseLock(gameId);
    }
  }

  setGameState(gameId, state) {
    this.gameStates.set(gameId, {
      ...state,
      lastUpdated: Date.now()
    });
  }

  getGameState(gameId) {
    return this.gameStates.get(gameId);
  }

  removeGameState(gameId) {
    this.gameStates.delete(gameId);
    this.releaseLock(gameId); // Ensure lock is released
  }

  async syncGameState(gameId) {
    try {
      const dbGame = await gameService.getGameById(gameId);
      if (dbGame) {
        this.setGameState(gameId, {
          id: dbGame.id,
          type: dbGame.type,
          status: dbGame.status,
          currentTurn: dbGame.currentTurn,
          gameData: dbGame.gameData,
          participants: dbGame.participants,
          winner: dbGame.winner
        });
      }
      return dbGame;
    } catch (error) {
      logger.error(`Error syncing game state for ${gameId}:`, error);
      return null;
    }
  }

  async updateGameState(gameId, updates) {
    return this.withLock(gameId, async () => {
      try {
        const currentState = this.getGameState(gameId);
        const newState = { ...currentState, ...updates };
        
        // Update in database
        await gameService.updateGameState(
          gameId,
          newState.gameData,
          newState.currentTurn,
          newState.status,
          newState.winner
        );
        
        // Update in memory
        this.setGameState(gameId, newState);
        
        return newState;
      } catch (error) {
        logger.error(`Error updating game state for ${gameId}:`, error);
        throw error;
      }
    });
  }

  validateGameAction(gameId, userId, action) {
    const gameState = this.getGameState(gameId);
    if (!gameState) {
      return { valid: false, reason: 'Game not found' };
    }

    if (gameState.status !== 'PLAYING') {
      return { valid: false, reason: 'Game not in playing state' };
    }

    const currentPlayer = gameState.participants[gameState.currentTurn];
    if (currentPlayer.userId !== userId) {
      return { valid: false, reason: 'Not your turn' };
    }

    // Action-specific validations
    switch (action) {
      case 'rollDice':
        if (gameState.gameData?.diceRolled) {
          return { valid: false, reason: 'Dice already rolled this turn' };
        }
        break;
      case 'movePiece':
        if (!gameState.gameData?.diceRolled) {
          return { valid: false, reason: 'Must roll dice first' };
        }
        break;
    }

    return { valid: true };
  }

  getStats() {
    return {
      totalGames: this.gameStates.size,
      activeLocks: this.gameLocks.size,
      games: Array.from(this.gameStates.entries()).map(([gameId, state]) => ({
        gameId,
        type: state.type,
        status: state.status,
        players: state.participants?.length || 0,
        lastUpdated: state.lastUpdated
      }))
    };
  }

  cleanup() {
    const now = Date.now();
    const staleThreshold = 30 * 60 * 1000; // 30 minutes
    let cleaned = 0;

    for (const [gameId, state] of this.gameStates.entries()) {
      if (now - state.lastUpdated > staleThreshold && state.status === 'FINISHED') {
        this.removeGameState(gameId);
        cleaned++;
      }
    }

    return cleaned;
  }
}

module.exports = new GameStateManager();