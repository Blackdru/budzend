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
    }, 5000);
  }

  async joinQueue(userId, gameType, maxPlayers, entryFee) {
    try {
      logger.info(`🎯 User ${userId} attempting to join queue: ${gameType} - ${maxPlayers}P - ₹${entryFee}`);
      
      // Check if user has sufficient balance (skip for free games)
      if (entryFee > 0) {
        const balance = await walletService.getWalletBalance(userId);
        logger.info(`💰 User ${userId} balance: ₹${balance}, required: ₹${entryFee}`);
        if (balance < entryFee) {
          throw new Error('Insufficient balance');
        }
      } else {
        logger.info(`🆓 Free game - skipping balance check for user ${userId}`);
      }

      // Check if user is already in queue
      const existingQueue = await prisma.matchmakingQueue.findFirst({
        where: { userId }
      });

      if (existingQueue) {
        logger.info(`⚠️ User ${userId} already in queue - removing old entry`);
        await prisma.matchmakingQueue.delete({
          where: { id: existingQueue.id }
        });
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

      logger.info(`✅ User ${userId} successfully joined matchmaking queue (ID: ${queueEntry.id})`);

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
      logger.info('🔍 Processing matchmaking...');
      
      // First, let's see what's in the queue
      const allQueueEntries = await prisma.matchmakingQueue.findMany({
        include: { user: true }
      });
      
      logger.info(`📊 Total queue entries: ${allQueueEntries.length}`);
      allQueueEntries.forEach(entry => {
        logger.info(`   - User ${entry.userId} (${entry.user.name}) - ${entry.gameType} - ${entry.maxPlayers}P - ₹${entry.entryFee}`);
      });

      if (allQueueEntries.length < 2) {
        logger.info('❌ Not enough players in queue (need at least 2)');
        return;
      }

      // Group queue entries by game type and entry fee (ignore maxPlayers for now)
      const queueGroups = await prisma.matchmakingQueue.groupBy({
        by: ['gameType', 'entryFee'],
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

      logger.info(`🎯 Found ${queueGroups.length} matchable groups`);

      for (const group of queueGroups) {
        const { gameType, entryFee } = group;
        const availableCount = group._count.id;

        logger.info(`🎮 Processing group: ${gameType} - ₹${entryFee} - ${availableCount} players`);
        
        if (availableCount >= 2) {
          // Start game with 2 players (can expand later)
          logger.info(`✅ Creating game with 2 players for ${gameType}`);
          await this.createGame(gameType, 2, entryFee);
        }
      }
    } catch (error) {
      logger.error('Process matchmaking error:', error);
    }
  }

  async createGame(gameType, playersToMatch, entryFee) {
    try {
      logger.info(`🎮 Creating game: ${gameType} - ${playersToMatch} players - ₹${entryFee}`);
      
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

      logger.info(`📋 Found ${queueEntries.length} queue entries for matching`);
      queueEntries.forEach(entry => {
        logger.info(`   - ${entry.user.name} (${entry.userId})`);
      });

      if (queueEntries.length < playersToMatch) {
        logger.info(`❌ Not enough players: need ${playersToMatch}, found ${queueEntries.length}`);
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