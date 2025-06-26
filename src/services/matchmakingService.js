const prisma = require('../config/database');
const logger = require('../config/logger');
const walletService = require('./walletService');

class MatchmakingService {
  constructor() {
    this.matchmakingInterval = null;
    this.startMatchmaking();
  }

  startMatchmaking() {
    // Run matchmaking every 3 seconds for faster matching
    this.matchmakingInterval = setInterval(() => {
      this.processMatchmaking();
    }, 3000);
  }

  async joinQueue(userId, gameType, maxPlayers, entryFee) {
    try {
      // Check if user has sufficient balance (skip for free games)
      if (entryFee > 0) {
        const balance = await walletService.getWalletBalance(userId);
        if (balance < entryFee) {
          throw new Error('Insufficient balance');
        }
      }

      // Check if user is already in queue
      const existingQueue = await prisma.matchmakingQueue.findFirst({
        where: { userId }
      });

      if (existingQueue) {
        throw new Error('Already in matchmaking queue');
      }

      // Add to queue
      const queueEntry = await prisma.matchmakingQueue.create({
        data: {
          userId,
          gameType,
          maxPlayers,
          entryFee
        }
      });

      logger.info(`User ${userId} joined matchmaking queue`);

      return {
        success: true,
        message: 'Joined matchmaking queue',
        queueId: queueEntry.id
      };
    } catch (error) {
      logger.error('Join queue error:', error);
      throw error;
    }
  }

  async leaveQueue(userId) {
    try {
      await prisma.matchmakingQueue.deleteMany({
        where: { userId }
      });

      return {
        success: true,
        message: 'Left matchmaking queue'
      };
    } catch (error) {
      logger.error('Leave queue error:', error);
      throw error;
    }
  }

  async processMatchmaking() {
    try {
      // Group queue entries by game type, max players, and entry fee
      const queueGroups = await prisma.matchmakingQueue.groupBy({
        by: ['gameType', 'maxPlayers', 'entryFee'],
        _count: {
          id: true
        },
        having: {
          id: {
            _count: {
              gte: 2 // At least 2 players needed
            }
          }
        }
      });

      for (const group of queueGroups) {
        const { gameType, maxPlayers, entryFee } = group;
        const availableCount = group._count.id;

        // For memory games, start with 2 players
        // For other games, can start with 2 players minimum
        const minPlayers = 2;
        
        if (availableCount >= minPlayers) {
          // Start game with available players (minimum 2)
          const playersToMatch = Math.min(availableCount, maxPlayers);
          await this.createGame(gameType, playersToMatch, entryFee);
        }
      }
    } catch (error) {
      logger.error('Process matchmaking error:', error);
    }
  }

  async createGame(gameType, playersToMatch, entryFee) {
    try {
      // Get players from queue
      const queueEntries = await prisma.matchmakingQueue.findMany({
        where: {
          gameType,
          entryFee
        },
        take: playersToMatch,
        include: {
          user: true
        },
        orderBy: {
          createdAt: 'asc'
        }
      });

      if (queueEntries.length < playersToMatch) {
        return; // Not enough players
      }

      // Calculate prize pool (90% of total entry fees, 10% platform fee)
      const totalEntryFees = entryFee * playersToMatch;
      const prizePool = totalEntryFees * 0.9;

      // Create game and process payments in transaction
      const result = await prisma.$transaction(async (tx) => {
        // Create game
        const game = await tx.game.create({
          data: {
            type: gameType,
            maxPlayers: playersToMatch,
            entryFee,
            prizePool,
            status: 'WAITING'
          }
        });

        // Process entry fees and create participations
        const participations = [];
        const colors = ['red', 'blue', 'green', 'yellow'];

        for (let i = 0; i < queueEntries.length; i++) {
          const queueEntry = queueEntries[i];
          
          // Deduct entry fee only if not free game (memory game)
          if (entryFee > 0) {
            await walletService.deductGameEntry(queueEntry.userId, entryFee, game.id);
          }

          // Create participation
          const participation = await tx.gameParticipation.create({
            data: {
              userId: queueEntry.userId,
              gameId: game.id,
              position: i,
              color: colors[i]
            }
          });

          participations.push(participation);

          // Remove from queue
          await tx.matchmakingQueue.delete({
            where: { id: queueEntry.id }
          });
        }

        return { game, participations, players: queueEntries.map(q => q.user) };
      });

      logger.info(`Game created: ${result.game.id} with ${playersToMatch} players`);

      // Emit game created event (will be handled by socket service)
      this.onGameCreated && this.onGameCreated(result.game, result.players);

      return result.game;
    } catch (error) {
      logger.error('Create game error:', error);
      throw error;
    }
  }

  async getQueueStatus(userId) {
    try {
      const queueEntry = await prisma.matchmakingQueue.findFirst({
        where: { userId }
      });

      if (!queueEntry) {
        return {
          inQueue: false,
          message: 'Not in queue'
        };
      }

      // Count players in same queue
      const playersInQueue = await prisma.matchmakingQueue.count({
        where: {
          gameType: queueEntry.gameType,
          maxPlayers: queueEntry.maxPlayers,
          entryFee: queueEntry.entryFee
        }
      });

      return {
        inQueue: true,
        gameType: queueEntry.gameType,
        maxPlayers: queueEntry.maxPlayers,
        entryFee: parseFloat(queueEntry.entryFee),
        playersInQueue,
        waitTime: Date.now() - queueEntry.createdAt.getTime()
      };
    } catch (error) {
      logger.error('Get queue status error:', error);
      throw new Error('Failed to get queue status');
    }
  }

  setGameCreatedCallback(callback) {
    this.onGameCreated = callback;
  }

  stop() {
    if (this.matchmakingInterval) {
      clearInterval(this.matchmakingInterval);
    }
  }
}

module.exports = new MatchmakingService();