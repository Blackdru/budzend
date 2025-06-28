const logger = require('../config/logger');

class ConnectionManager {
  constructor() {
    // Active socket management: Mapping to support one user having multiple active sockets
    this.activeSockets = new Map(); // socketId -> userId
    this.userSockets = new Map(); // userId -> Set<socketId>
    this.userGameRooms = new Map(); // userId -> Set<gameId>
    this.gameRoomUsers = new Map(); // gameId -> Set<userId>
  }

  /**
   * Add a socket connection for a user
   */
  addConnection(socketId, userId) {
    try {
      // Add socket to active connections
      this.activeSockets.set(socketId, userId);

      // Add socketId to the set of sockets for this userId
      if (!this.userSockets.has(userId)) {
        this.userSockets.set(userId, new Set());
      }
      this.userSockets.get(userId).add(socketId);

      logger.info(`🔌 Connection added: Socket ${socketId} for user ${userId}`);
      logger.info(`📊 Total active unique users: ${this.userSockets.size}, total active sockets: ${this.activeSockets.size}`);
      
      return true;
    } catch (error) {
      logger.error(`❌ Error adding connection for socket ${socketId}, user ${userId}:`, error);
      return false;
    }
  }

  /**
   * Remove a socket connection
   */
  removeConnection(socketId) {
    try {
      const userId = this.activeSockets.get(socketId);
      if (!userId) {
        logger.warn(`⚠️ Attempted to remove non-existent socket: ${socketId}`);
        return false;
      }

      // Remove socket from active connections map
      this.activeSockets.delete(socketId);

      // Remove socketId from the user's set of sockets
      if (this.userSockets.has(userId)) {
        this.userSockets.get(userId).delete(socketId);
        if (this.userSockets.get(userId).size === 0) {
          this.userSockets.delete(userId);
          // Also clean up user's game rooms when they have no active sockets
          this.removeUserFromAllGameRooms(userId);
          logger.info(`🗑️ User ${userId} has no more active sockets. Removed user entry and game room associations.`);
        }
      }

      logger.info(`🔌 Connection removed: Socket ${socketId} for user ${userId}`);
      logger.info(`📊 Remaining active unique users: ${this.userSockets.size}, total active sockets: ${this.activeSockets.size}`);
      
      return true;
    } catch (error) {
      logger.error(`❌ Error removing connection for socket ${socketId}:`, error);
      return false;
    }
  }

  /**
   * Add user to a game room
   */
  addUserToGameRoom(userId, gameId) {
    try {
      // Add gameId to user's game rooms
      if (!this.userGameRooms.has(userId)) {
        this.userGameRooms.set(userId, new Set());
      }
      this.userGameRooms.get(userId).add(gameId);

      // Add userId to game room's users
      if (!this.gameRoomUsers.has(gameId)) {
        this.gameRoomUsers.set(gameId, new Set());
      }
      this.gameRoomUsers.get(gameId).add(userId);

      logger.debug(`🏠 User ${userId} added to game room ${gameId}`);
      return true;
    } catch (error) {
      logger.error(`❌ Error adding user ${userId} to game room ${gameId}:`, error);
      return false;
    }
  }

  /**
   * Remove user from a specific game room
   */
  removeUserFromGameRoom(userId, gameId) {
    try {
      // Remove gameId from user's game rooms
      if (this.userGameRooms.has(userId)) {
        this.userGameRooms.get(userId).delete(gameId);
        if (this.userGameRooms.get(userId).size === 0) {
          this.userGameRooms.delete(userId);
        }
      }

      // Remove userId from game room's users
      if (this.gameRoomUsers.has(gameId)) {
        this.gameRoomUsers.get(gameId).delete(userId);
        if (this.gameRoomUsers.get(gameId).size === 0) {
          this.gameRoomUsers.delete(gameId);
          logger.debug(`🗑️ Game room ${gameId} is now empty, removed from tracking`);
        }
      }

      logger.debug(`🚪 User ${userId} removed from game room ${gameId}`);
      return true;
    } catch (error) {
      logger.error(`❌ Error removing user ${userId} from game room ${gameId}:`, error);
      return false;
    }
  }

  /**
   * Remove user from all game rooms (called when user disconnects completely)
   */
  removeUserFromAllGameRooms(userId) {
    try {
      const userGameRooms = this.userGameRooms.get(userId);
      if (userGameRooms) {
        for (const gameId of userGameRooms) {
          this.removeUserFromGameRoom(userId, gameId);
        }
      }
      logger.debug(`🧹 User ${userId} removed from all game rooms`);
      return true;
    } catch (error) {
      logger.error(`❌ Error removing user ${userId} from all game rooms:`, error);
      return false;
    }
  }

  /**
   * Get all socket IDs for a user
   */
  getUserSockets(userId) {
    return this.userSockets.get(userId) || new Set();
  }

  /**
   * Get user ID for a socket
   */
  getSocketUser(socketId) {
    return this.activeSockets.get(socketId);
  }

  /**
   * Check if user is online (has active sockets)
   */
  isUserOnline(userId) {
    return this.userSockets.has(userId) && this.userSockets.get(userId).size > 0;
  }

  /**
   * Get all users in a game room
   */
  getGameRoomUsers(gameId) {
    return this.gameRoomUsers.get(gameId) || new Set();
  }

  /**
   * Get all game rooms for a user
   */
  getUserGameRooms(userId) {
    return this.userGameRooms.get(userId) || new Set();
  }

  /**
   * Get connection statistics
   */
  getStats() {
    return {
      totalActiveSockets: this.activeSockets.size,
      totalActiveUsers: this.userSockets.size,
      totalGameRooms: this.gameRoomUsers.size,
      averageSocketsPerUser: this.userSockets.size > 0 ? this.activeSockets.size / this.userSockets.size : 0
    };
  }

  /**
   * Clean up stale connections (for maintenance)
   */
  cleanup() {
    try {
      let cleanedSockets = 0;
      let cleanedUsers = 0;
      let cleanedGameRooms = 0;

      // Clean up empty user socket sets
      for (const [userId, socketSet] of this.userSockets.entries()) {
        if (socketSet.size === 0) {
          this.userSockets.delete(userId);
          this.removeUserFromAllGameRooms(userId);
          cleanedUsers++;
        }
      }

      // Clean up empty game rooms
      for (const [gameId, userSet] of this.gameRoomUsers.entries()) {
        if (userSet.size === 0) {
          this.gameRoomUsers.delete(gameId);
          cleanedGameRooms++;
        }
      }

      // Clean up orphaned socket entries
      for (const [socketId, userId] of this.activeSockets.entries()) {
        if (!this.userSockets.has(userId) || !this.userSockets.get(userId).has(socketId)) {
          this.activeSockets.delete(socketId);
          cleanedSockets++;
        }
      }

      if (cleanedSockets > 0 || cleanedUsers > 0 || cleanedGameRooms > 0) {
        logger.info(`🧹 Cleanup completed: ${cleanedSockets} sockets, ${cleanedUsers} users, ${cleanedGameRooms} game rooms`);
      }

      return { cleanedSockets, cleanedUsers, cleanedGameRooms };
    } catch (error) {
      logger.error(`❌ Error during cleanup:`, error);
      return { cleanedSockets: 0, cleanedUsers: 0, cleanedGameRooms: 0 };
    }
  }
}

module.exports = new ConnectionManager();