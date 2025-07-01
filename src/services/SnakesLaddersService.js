const logger = require('../config/logger');
const gameService = require('./gameService');
const gameStateManager = require('./gameStateManager');

class SnakesLaddersService {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();
    this.GAME_CONFIG = {
      BOARD_SIZE: 100,
      MAX_PLAYERS: 4,
      SNAKES: {
        99: 21, 95: 75, 87: 24, 62: 19, 
        54: 34, 49: 11, 46: 25, 17: 7
      },
      LADDERS: {
        4: 14, 9: 31, 20: 38, 28: 84, 
        40: 59, 51: 67, 63: 81, 71: 91
      },
      PLAYER_COLORS: ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A'],
      PLAYER_AVATARS: ['🐯', '🐶', '🐼', '🐵']
    };
  }

  setupSocketHandlers(socket) {
    const userId = socket.user.id;
    const userName = socket.user.name || 'Unknown';

    socket.on('snakes_createRoom', async (data) => {
      try {
        const { gameId } = data;
        
        if (!gameId) {
          return socket.emit('snakes_error', { message: 'Game ID required' });
        }

        const game = await gameService.getGameById(gameId);
        if (!game) {
          return socket.emit('snakes_error', { message: 'Game not found' });
        }

        const isParticipant = game.participants.some(p => p.userId === userId);
        if (!isParticipant) {
          return socket.emit('snakes_error', { message: 'Not a participant' });
        }

        // Create room if it doesn't exist
        if (!this.rooms.has(gameId)) {
          const room = new GameRoom(gameId, userId, userName);
          this.rooms.set(gameId, room);
          logger.info(`Snakes & Ladders room created: ${gameId} by ${userName}`);
        }

        const room = this.rooms.get(gameId);
        
        // Add player if not already in room
        if (!room.getPlayer(userId)) {
          room.addPlayer(userId, userName);
        }

        socket.join(`game:${gameId}`);
        
        socket.emit('snakes_roomCreated', {
          gameId,
          players: room.players,
          gameState: {
            started: room.gameStarted,
            currentTurn: room.currentTurnIndex,
            lastDiceRoll: room.lastDiceRoll
          }
        });

      } catch (error) {
        logger.error(`Snakes create room error for user ${userId}:`, error);
        socket.emit('snakes_error', { message: 'Failed to create room' });
      }
    });

    socket.on('snakes_joinRoom', async (data) => {
      try {
        const { gameId } = data;
        
        if (!gameId) {
          return socket.emit('snakes_error', { message: 'Game ID required' });
        }

        const game = await gameService.getGameById(gameId);
        if (!game) {
          return socket.emit('snakes_error', { message: 'Game not found' });
        }

        const isParticipant = game.participants.some(p => p.userId === userId);
        if (!isParticipant) {
          return socket.emit('snakes_error', { message: 'Not a participant' });
        }

        // Create room if it doesn't exist
        if (!this.rooms.has(gameId)) {
          const room = new GameRoom(gameId, userId, userName);
          this.rooms.set(gameId, room);
        }

        const room = this.rooms.get(gameId);
        
        // Add player if not already in room
        if (!room.getPlayer(userId)) {
          if (room.players.length >= this.GAME_CONFIG.MAX_PLAYERS) {
            return socket.emit('snakes_error', { message: 'Room is full' });
          }
          room.addPlayer(userId, userName);
        }

        socket.join(`game:${gameId}`);

        this.io.to(`game:${gameId}`).emit('snakes_playerJoined', {
          players: room.players,
          gameState: {
            started: room.gameStarted,
            currentTurn: room.currentTurnIndex,
            lastDiceRoll: room.lastDiceRoll
          }
        });

        logger.info(`${userName} joined Snakes & Ladders room: ${gameId}`);
      } catch (error) {
        logger.error(`Snakes join room error for user ${userId}:`, error);
        socket.emit('snakes_error', { message: 'Failed to join room' });
      }
    });

    socket.on('snakes_startGame', async (data) => {
      try {
        const { gameId } = data;
        
        if (!gameId || !this.rooms.has(gameId)) {
          return socket.emit('snakes_error', { message: 'Invalid game ID' });
        }

        const room = this.rooms.get(gameId);
        const player = room.getPlayer(userId);

        if (!player) {
          return socket.emit('snakes_error', { message: 'Player not found in room' });
        }

        // Only allow game creator or first player to start
        if (player.id !== room.players[0].id) {
          return socket.emit('snakes_error', { message: 'Only room creator can start the game' });
        }

        room.startGame();
        
        // Update game status in database
        await gameService.updateGameState(gameId, { 
          board: room.getGameState(),
          config: this.GAME_CONFIG 
        }, room.currentTurnIndex, 'PLAYING');

        this.io.to(`game:${gameId}`).emit('snakes_gameStarted', {
          players: room.players,
          currentPlayer: room.getCurrentPlayer(),
          gameState: {
            started: true,
            currentTurn: room.currentTurnIndex
          }
        });

        logger.info(`Snakes & Ladders game started in room: ${gameId}`);
      } catch (error) {
        logger.error(`Snakes start game error for user ${userId}:`, error);
        socket.emit('snakes_error', { message: 'Failed to start game' });
      }
    });

    socket.on('snakes_rollDice', async (data) => {
      try {
        const { gameId } = data;
        
        if (!gameId || !this.rooms.has(gameId)) {
          return socket.emit('snakes_error', { message: 'Invalid game ID' });
        }

        const room = this.rooms.get(gameId);
        
        if (!room.gameStarted) {
          return socket.emit('snakes_error', { message: 'Game not started yet' });
        }

        const currentPlayer = room.getCurrentPlayer();
        if (currentPlayer.id !== userId) {
          return socket.emit('snakes_error', { message: 'Not your turn' });
        }

        // Check if dice already rolled this turn
        if (room.diceRolled) {
          return socket.emit('snakes_error', { message: 'Dice already rolled this turn' });
        }

        const diceValue = Math.floor(Math.random() * 6) + 1;
        room.lastDiceRoll = { player: userId, value: diceValue, timestamp: new Date() };
        room.diceRolled = true;

        const oldPosition = currentPlayer.position;
        let newPosition = oldPosition + diceValue;
        
        // Check if player would go beyond 100
        if (newPosition > this.GAME_CONFIG.BOARD_SIZE) {
          newPosition = oldPosition; // Stay in same position if would exceed 100
        }
        
        const moveResult = room.updatePlayerPosition(userId, newPosition);

        this.io.to(`game:${gameId}`).emit('snakes_diceRolled', {
          playerId: userId,
          playerName: currentPlayer.username,
          value: diceValue,
          oldPosition,
          newPosition: currentPlayer.position,
          event: moveResult.event,
          canMove: newPosition !== oldPosition
        });

        if (moveResult.won) {
          // Update game as finished
          await gameService.updateGameState(gameId, { 
            board: room.getGameState(),
            winner: moveResult.winner 
          }, room.currentTurnIndex, 'FINISHED', userId);

          // Process winnings
          await gameService.processGameWinnings(gameId);

          this.io.to(`game:${gameId}`).emit('snakes_gameWon', {
            winner: moveResult.winner,
            players: room.players
          });
          
          logger.info(`${moveResult.winner.username} won Snakes & Ladders in room: ${gameId}`);
        } else {
          // Move to next turn after a delay
          setTimeout(() => {
            room.nextTurn();
            room.diceRolled = false; // Reset dice for next player
            
            // Update game state in database
            gameService.updateGameState(gameId, { 
              board: room.getGameState() 
            }, room.currentTurnIndex).catch(err => 
              logger.error(`Error updating game state for ${gameId}:`, err)
            );

            this.io.to(`game:${gameId}`).emit('snakes_turnChanged', {
              currentPlayer: room.getCurrentPlayer(),
              players: room.players,
              currentTurnIndex: room.currentTurnIndex
            });
          }, 3000); // 3 second delay to show the move
        }

      } catch (error) {
        logger.error(`Snakes roll dice error for user ${userId}:`, error);
        socket.emit('snakes_error', { message: 'Failed to roll dice' });
      }
    });

    socket.on('snakes_sendMessage', (data) => {
      try {
        const { gameId, message } = data;
        
        if (!gameId || !this.rooms.has(gameId)) {
          return socket.emit('snakes_error', { message: 'Invalid game ID' });
        }

        const room = this.rooms.get(gameId);
        const player = room.getPlayer(userId);

        if (!player) {
          return socket.emit('snakes_error', { message: 'Player not found in room' });
        }

        if (typeof message !== 'string' || message.trim().length === 0 || message.length > 200) {
          return socket.emit('snakes_error', { message: 'Invalid message' });
        }

        this.io.to(`game:${gameId}`).emit('snakes_messageReceived', {
          from: player.username,
          message: message.trim(),
          timestamp: new Date(),
          playerId: player.id
        });

      } catch (error) {
        logger.error(`Snakes send message error for user ${userId}:`, error);
      }
    });

    socket.on('snakes_sendEmote', (data) => {
      try {
        const { gameId, emote } = data;
        
        if (!gameId || !this.rooms.has(gameId)) return;

        const room = this.rooms.get(gameId);
        const player = room.getPlayer(userId);

        if (!player) return;

        const validEmotes = ['😀', '😂', '😍', '😎', '🤔', '😢', '😡', '👍', '👎', '❤️'];
        if (!validEmotes.includes(emote)) return;

        this.io.to(`game:${gameId}`).emit('snakes_emoteReceived', {
          from: player.username,
          emote,
          playerId: player.id,
          timestamp: new Date()
        });

      } catch (error) {
        logger.error(`Snakes send emote error for user ${userId}:`, error);
      }
    });

    socket.on('snakes_resetGame', async (data) => {
      try {
        const { gameId } = data;
        
        if (!gameId || !this.rooms.has(gameId)) {
          return socket.emit('snakes_error', { message: 'Invalid game ID' });
        }

        const room = this.rooms.get(gameId);
        const player = room.getPlayer(userId);

        if (!player || player.id !== room.players[0].id) {
          return socket.emit('snakes_error', { message: 'Only room creator can reset the game' });
        }

        room.resetGame();

        // Update game status in database
        await gameService.updateGameState(gameId, { 
          board: room.getGameState() 
        }, 0, 'WAITING');

        this.io.to(`game:${gameId}`).emit('snakes_gameReset', {
          players: room.players,
          gameState: {
            started: false,
            currentTurn: 0,
            lastDiceRoll: null
          }
        });

        logger.info(`Snakes & Ladders game reset in room: ${gameId}`);
      } catch (error) {
        logger.error(`Snakes reset game error for user ${userId}:`, error);
        socket.emit('snakes_error', { message: 'Failed to reset game' });
      }
    });

    socket.on('snakes_leaveRoom', (data) => {
      try {
        const { gameId } = data;
        
        if (!gameId || !this.rooms.has(gameId)) return;

        const room = this.rooms.get(gameId);
        const removedPlayer = room.getPlayer(userId);
        
        if (removedPlayer) {
          room.removePlayer(userId);
          socket.leave(`game:${gameId}`);

          if (room.players.length === 0) {
            this.rooms.delete(gameId);
            logger.info(`Snakes & Ladders room deleted: ${gameId}`);
          } else {
            this.io.to(`game:${gameId}`).emit('snakes_playerLeft', {
              leftPlayer: removedPlayer,
              players: room.players,
              currentPlayer: room.getCurrentPlayer()
            });
          }

          logger.info(`${removedPlayer.username} left Snakes & Ladders room: ${gameId}`);
        }
      } catch (error) {
        logger.error(`Snakes leave room error for user ${userId}:`, error);
      }
    });
  }

  async joinRoom(socket, data) {
    const { gameId, playerId, playerName } = data;
    
    try {
      // Create room if it doesn't exist
      if (!this.rooms.has(gameId)) {
        const room = new GameRoom(gameId, playerId, playerName);
        this.rooms.set(gameId, room);
      }

      const room = this.rooms.get(gameId);
      
      // Add player if not already in room
      if (!room.getPlayer(playerId)) {
        if (room.players.length >= this.GAME_CONFIG.MAX_PLAYERS) {
          return socket.emit('snakes_error', { message: 'Room is full' });
        }
        room.addPlayer(playerId, playerName);
      }

      socket.join(`game:${gameId}`);

      socket.emit('snakes_roomJoined', {
        gameId,
        players: room.players,
        gameState: {
          started: room.gameStarted,
          currentTurn: room.currentTurnIndex,
          lastDiceRoll: room.lastDiceRoll
        }
      });

      logger.info(`${playerName} joined Snakes & Ladders room: ${gameId}`);
    } catch (error) {
      logger.error(`Error joining Snakes & Ladders room ${gameId}:`, error);
      socket.emit('snakes_error', { message: 'Failed to join room' });
    }
  }

  async startGame(data) {
    const { gameId } = data;
    
    try {
      if (!this.rooms.has(gameId)) {
        logger.error(`Snakes & Ladders room not found: ${gameId}`);
        return;
      }

      const room = this.rooms.get(gameId);
      
      if (room.players.length < 2) {
        logger.error(`Not enough players in Snakes & Ladders room: ${gameId}`);
        return;
      }

      room.startGame();
      
      // Update game status in database
      await gameService.updateGameState(gameId, { 
        board: room.getGameState(),
        config: this.GAME_CONFIG 
      }, room.currentTurnIndex, 'PLAYING');

      this.io.to(`game:${gameId}`).emit('snakes_gameStarted', {
        players: room.players,
        currentPlayer: room.getCurrentPlayer(),
        gameState: {
          started: true,
          currentTurn: room.currentTurnIndex
        }
      });

      logger.info(`Snakes & Ladders game auto-started in room: ${gameId}`);
    } catch (error) {
      logger.error(`Error auto-starting Snakes & Ladders game ${gameId}:`, error);
    }
  }

  async getGameState(gameId) {
    if (!this.rooms.has(gameId)) {
      return null;
    }

    const room = this.rooms.get(gameId);
    return room.getGameState();
  }

  // Cleanup method
  cleanup() {
    const now = new Date();
    const ROOM_TIMEOUT = 2 * 60 * 60 * 1000; // 2 hours

    for (const [gameId, room] of this.rooms.entries()) {
      if (now - room.createdAt > ROOM_TIMEOUT && room.players.length === 0) {
        this.rooms.delete(gameId);
        logger.info(`Cleaned up inactive Snakes & Ladders room: ${gameId}`);
      }
    }
  }
}

// Game Room class for Snakes & Ladders
class GameRoom {
  constructor(id, creatorId, creatorName) {
    this.id = id;
    this.players = [];
    this.currentTurnIndex = 0;
    this.gameStarted = false;
    this.lastDiceRoll = null;
    this.diceRolled = false;
    this.gameHistory = [];
    this.createdAt = new Date();
    
    this.addPlayer(creatorId, creatorName);
  }

  addPlayer(socketId, username) {
    if (this.players.length >= 4) {
      throw new Error('Room is full');
    }

    const playerIndex = this.players.length;
    const PLAYER_COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A'];
    const PLAYER_AVATARS = ['🐯', '🐶', '🐼', '🐵'];
    
    const player = {
      id: socketId,
      username: username.trim() || `Player ${playerIndex + 1}`,
      position: 1,
      color: PLAYER_COLORS[playerIndex],
      avatar: PLAYER_AVATARS[playerIndex],
      isReady: false,
      score: 0,
      joinedAt: new Date()
    };

    this.players.push(player);
    return player;
  }

  removePlayer(socketId) {
    const playerIndex = this.players.findIndex(p => p.id === socketId);
    if (playerIndex !== -1) {
      this.players.splice(playerIndex, 1);
      // Adjust turn index if necessary
      if (this.currentTurnIndex >= this.players.length) {
        this.currentTurnIndex = 0;
      }
      return true;
    }
    return false;
  }

  getPlayer(socketId) {
    return this.players.find(p => p.id === socketId);
  }

  getCurrentPlayer() {
    return this.players[this.currentTurnIndex];
  }

  nextTurn() {
    this.currentTurnIndex = (this.currentTurnIndex + 1) % this.players.length;
  }

  updatePlayerPosition(socketId, newPosition) {
    const player = this.getPlayer(socketId);
    if (player) {
      player.position = newPosition;
      
      // Check for win condition
      if (newPosition >= 100) {
        player.score = 100;
        return { won: true, winner: player };
      }

      // Check for snakes and ladders
      const SNAKES = {
        99: 21, 95: 75, 87: 24, 62: 19, 
        54: 34, 49: 11, 46: 25, 17: 7
      };
      const LADDERS = {
        4: 14, 9: 31, 20: 38, 28: 84, 
        40: 59, 51: 67, 63: 81, 71: 91
      };

      let finalPosition = newPosition;
      let event = null;

      if (SNAKES[newPosition]) {
        finalPosition = SNAKES[newPosition];
        event = { type: 'snake', from: newPosition, to: finalPosition };
      } else if (LADDERS[newPosition]) {
        finalPosition = LADDERS[newPosition];
        event = { type: 'ladder', from: newPosition, to: finalPosition };
      }

      player.position = finalPosition;
      
      return { 
        won: finalPosition >= 100, 
        winner: finalPosition >= 100 ? player : null,
        event 
      };
    }
    return { won: false, winner: null, event: null };
  }

  startGame() {
    if (this.players.length < 2) {
      throw new Error('Need at least 2 players to start');
    }
    this.gameStarted = true;
    this.currentTurnIndex = 0;
  }

  resetGame() {
    this.players.forEach(player => {
      player.position = 1;
      player.isReady = false;
      player.score = 0;
    });
    this.currentTurnIndex = 0;
    this.gameStarted = false;
    this.lastDiceRoll = null;
    this.diceRolled = false;
    this.gameHistory = [];
  }

  getGameState() {
    return {
      players: this.players,
      currentTurnIndex: this.currentTurnIndex,
      gameStarted: this.gameStarted,
      lastDiceRoll: this.lastDiceRoll,
      createdAt: this.createdAt
    };
  }
}

module.exports = SnakesLaddersService;