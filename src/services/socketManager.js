const logger = require('../config/logger');

class SocketManager {
  constructor() {
    this.userSockets = new Map(); // userId -> Set<socketId>
    this.socketUsers = new Map(); // socketId -> userId
    this.gameRooms = new Map(); // gameId -> Set<userId>
    this.userGames = new Map(); // userId -> Set<gameId>
  }

  addConnection(socketId, userId) {
    try {
      // Add socket to user mapping
      this.socketUsers.set(socketId, userId);
      
      // Add user to socket mapping
      if (!this.userSockets.has(userId)) {
        this.userSockets.set(userId, new Set());
      }
      this.userSockets.get(userId).add(socketId);
      
      logger.info(`Socket connected: ${socketId} for user ${userId}`);
      return true;
    } catch (error) {
      logger.error('Error adding socket connection:', error);
      return false;
    }
  }

  removeConnection(socketId) {
    try {
      const userId = this.socketUsers.get(socketId);
      if (!userId) return false;

      // Remove from socket-user mapping
      this.socketUsers.delete(socketId);
      
      // Remove from user-sockets mapping
      if (this.userSockets.has(userId)) {
        this.userSockets.get(userId).delete(socketId);
        if (this.userSockets.get(userId).size === 0) {
          this.userSockets.delete(userId);
          // Clean up user's game rooms when no sockets left
          this.removeUserFromAllGames(userId);
        }
      }
      
      logger.info(`Socket disconnected: ${socketId} for user ${userId}`);
      return true;
    } catch (error) {
      logger.error('Error removing socket connection:', error);
      return false;
    }
  }

  addUserToGame(userId, gameId) {
    try {
      // Add user to game room
      if (!this.gameRooms.has(gameId)) {
        this.gameRooms.set(gameId, new Set());
      }
      this.gameRooms.get(gameId).add(userId);
      
      // Add game to user's games
      if (!this.userGames.has(userId)) {
        this.userGames.set(userId, new Set());
      }
      this.userGames.get(userId).add(gameId);
      
      return true;
    } catch (error) {
      logger.error('Error adding user to game:', error);
      return false;
    }
  }

  removeUserFromGame(userId, gameId) {
    try {
      // Remove user from game room
      if (this.gameRooms.has(gameId)) {
        this.gameRooms.get(gameId).delete(userId);
        if (this.gameRooms.get(gameId).size === 0) {
          this.gameRooms.delete(gameId);
        }
      }
      
      // Remove game from user's games
      if (this.userGames.has(userId)) {
        this.userGames.get(userId).delete(gameId);
        if (this.userGames.get(userId).size === 0) {
          this.userGames.delete(userId);
        }
      }
      
      return true;
    } catch (error) {
      logger.error('Error removing user from game:', error);
      return false;
    }
  }

  removeUserFromAllGames(userId) {
    try {
      const userGameIds = this.userGames.get(userId);
      if (userGameIds) {
        for (const gameId of userGameIds) {
          this.removeUserFromGame(userId, gameId);
        }
      }
      return true;
    } catch (error) {
      logger.error('Error removing user from all games:', error);
      return false;
    }
  }

  getUserSockets(userId) {
    return this.userSockets.get(userId) || new Set();
  }

  getSocketUser(socketId) {
    return this.socketUsers.get(socketId);
  }

  isUserOnline(userId) {
    return this.userSockets.has(userId) && this.userSockets.get(userId).size > 0;
  }

  getGameUsers(gameId) {
    return this.gameRooms.get(gameId) || new Set();
  }

  getUserGames(userId) {
    return this.userGames.get(userId) || new Set();
  }

  getStats() {
    return {
      totalSockets: this.socketUsers.size,
      totalUsers: this.userSockets.size,
      totalGameRooms: this.gameRooms.size,
      averageSocketsPerUser: this.userSockets.size > 0 ? this.socketUsers.size / this.userSockets.size : 0
    };
  }

  cleanup() {
    let cleaned = 0;
    
    // Clean empty user socket sets
    for (const [userId, socketSet] of this.userSockets.entries()) {
      if (socketSet.size === 0) {
        this.userSockets.delete(userId);
        this.removeUserFromAllGames(userId);
        cleaned++;
      }
    }
    
    // Clean empty game rooms
    for (const [gameId, userSet] of this.gameRooms.entries()) {
      if (userSet.size === 0) {
        this.gameRooms.delete(gameId);
        cleaned++;
      }
    }
    
    return cleaned;
  }
}

module.exports = new SocketManager();