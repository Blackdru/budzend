const prisma = require('../config/database');
const logger = require('../config/logger');
const walletService = require('./walletService');
const gameService = require('./gameService'); // For initializing game board based on game type

class MatchmakingService {
  constructor() {
    this.matchmakingInterval = null;
    this.onGameCreatedCallback = null; // Callback to notify server.js
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) {
      logger.info('MatchmakingService already initialized');
      return;
    }
    
    try {
      this.startMatchmaking();
      this.initialized = true;
      logger.info('MatchmakingService initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize MatchmakingService:', error);
      throw error;
    }
  }

  startMatchmaking() {
    // Run matchmaking every 5 seconds for faster matching
    if (this.matchmakingInterval) {
      clearInterval(this.matchmakingInterval);
    }
    this.matchmakingInterval = setInterval(() => {
      this.processMatchmaking();
    }, 5000);
    logger.info('Matchmaking interval started, running every 5 seconds.');
  }

  stop() {
    if (this.matchmakingInterval) {
      clearInterval(this.matchmakingInterval);
      this.matchmakingInterval = null;
      logger.info('Matchmaking interval stopped.');
    }
  }

  setGameCreatedCallback(callback) {
    this.onGameCreatedCallback = callback;
  }

  async joinQueue(userId, gameType, maxPlayers, entryFee) {
    try {
      logger.info(`🎯 User ${userId} attempting to join queue: ${gameType} - ${maxPlayers}P - ₹${entryFee}`);
      
      // Check if user has sufficient balance (skip for free games)
      if (entryFee > 0) {
        const balance = await walletService.getWalletBalance(userId);
        logger.info(`💰 User ${userId} balance: ₹${balance}, required: ₹${entryFee}`);
        if (balance < entryFee) {
          logger.warn(`❌ Insufficient balance for user ${userId} to join queue. Has: ${balance}, Needs: ${entryFee}`);
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
        logger.info(`⚠️ User ${userId} already in queue (ID: ${existingQueue.id}) - removing old entry before adding new.`);
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

      logger.info(`✅ User ${userId} successfully joined matchmaking queue (ID: ${queueEntry.id}) for ${gameType} ${maxPlayers}P game.`);

      return {
        success: true,
        message: 'Joined matchmaking queue',
        queueId: queueEntry.id
      };
    } catch (error) {
      logger.error(`Join queue error for user ${userId}:`, error);
      throw error; // Re-throw for API/socket handler to catch
    }
  }

  async leaveQueue(userId) {
    try {
      const deletedCount = await prisma.matchmakingQueue.deleteMany({
        where: { userId }
      });
      if (deletedCount.count > 0) {
        logger.info(`✅ User ${userId} successfully left matchmaking queue. Removed ${deletedCount.count} entries.`);
      } else {
        logger.info(`User ${userId} was not in any matchmaking queue.`);
      }

      return {
        success: true,
        message: 'Left matchmaking queue'
      };
    } catch (error) {
      logger.error(`Leave queue error for user ${userId}:`, error);
      throw error;
    }
  }

  async processMatchmaking() {
    try {
      logger.info('🔍 Processing matchmaking cycle...');
      
      // Group queue entries by game type, maxPlayers, and entry fee
      // We need to find groups that have enough players for a game
      const matchableGroups = await prisma.matchmakingQueue.groupBy({
        by: ['gameType', 'maxPlayers', 'entryFee'],
        _count: {
          id: true
        },
        having: {
          id: {
            _count: {
              gte: 2 // Minimum 2 players needed for any game
            }
          }
        },
        orderBy: {
          _count: {
            id: 'desc' // Prioritize groups with more players
          }
        }
      });

      logger.info(`📊 Found ${matchableGroups.length} potential matchable groups.`);

      let gamesCreated = 0;
      for (const group of matchableGroups) {
        const { gameType, maxPlayers, entryFee } = group;
        const availableCount = group._count.id;

        logger.info(`🎮 Evaluating group: GameType: ${gameType}, MaxPlayers: ${maxPlayers}P, EntryFee: ₹${entryFee}, Available: ${availableCount}`);
        
        // Create multiple games if we have enough players
        const possibleGames = Math.floor(availableCount / maxPlayers);
        
        if (possibleGames > 0) {
          logger.info(`✅ Can create ${possibleGames} games with ${maxPlayers} players each from ${availableCount} available players`);
          
          for (let i = 0; i < possibleGames; i++) {
            try {
              await this.createGame(gameType, maxPlayers, entryFee);
              gamesCreated++;
              logger.info(`🎉 Created game ${i + 1}/${possibleGames} for ${gameType} ${maxPlayers}P ₹${entryFee}`);
            } catch (error) {
              logger.error(`Failed to create game ${i + 1}/${possibleGames}:`, error);
              break; // Stop creating more games if one fails
            }
          }
        } else {
          logger.info(`⚠️ Not enough players for a full ${maxPlayers}-player ${gameType} game. Available: ${availableCount}. Skipping for now.`);
        }
      }
      
      if (gamesCreated > 0) {
        logger.info(`🎉 Matchmaking cycle completed. Created ${gamesCreated} new games.`);
        // Schedule next cycle immediately if games were created
        setTimeout(() => this.processMatchmaking(), 1000);
      } else {
        logger.info('🔍 Matchmaking cycle completed. No new games created in this cycle.');
      }
    } catch (error) {
      logger.error('Process matchmaking error:', error);
    }
  }

  async createGame(gameType, playersToMatch, entryFee) {
    try {
      logger.info(`Attempting to create game: Type: ${gameType}, Players: ${playersToMatch}, EntryFee: ₹${entryFee}`);
      
      // Get exact number of players from queue (oldest entries first)
      const queueEntries = await prisma.matchmakingQueue.findMany({
        where: {
          gameType,
          maxPlayers: playersToMatch, // Important: Match on maxPlayers
          entryFee
        },
        take: playersToMatch, // Take exactly the number of players needed
        include: {
          user: true
        },
        orderBy: {
          createdAt: 'asc'
        }
      });

      if (queueEntries.length < playersToMatch) {
        logger.warn(`❌ Failed to create game: Not enough players found after re-query. Needed: ${playersToMatch}, Found: ${queueEntries.length}. This might be a race condition, retrying next cycle.`);
        return null; // Not enough players (might have been removed by another process)
      }

      // Calculate prize pool (90% of total entry fees, 10% platform fee)
      const totalEntryFees = entryFee * playersToMatch;
      const prizePool = totalEntryFees * 0.9;
      logger.info(`Calculated prize pool: ₹${prizePool.toFixed(2)} from total entry fees ₹${totalEntryFees.toFixed(2)}.`);

      // Create game and process payments in transaction
      const result = await prisma.$transaction(async (tx) => {
        // Initialize gameData based on gameType
        let initialGameData = {};
        if (gameType === 'CLASSIC_LUDO') {
          initialGameData = gameService.initializeLudoGameBoard(playersToMatch);
        } else if (gameType === 'FAST_LUDO') {
          initialGameData = gameService.initializeLudoGameBoard(playersToMatch);
        } else if (gameType === 'MEMORY') {
          initialGameData = gameService.initializeMemoryGameBoard();
        } else if (gameType === 'SNAKES_LADDERS') {
          initialGameData = gameService.initializeSnakesLaddersGameBoard(playersToMatch);
        }

        // Create game
        const game = await tx.game.create({
          data: {
            type: gameType,
            maxPlayers: playersToMatch,
            entryFee,
            prizePool,
            status: 'WAITING', // Game is created but waiting for players to join socket room
            gameData: initialGameData, // Store initial game board state
            // currentTurn will be set when the game actually starts
          }
        });
        logger.info(`Game ${game.id} created in database with initial status 'WAITING'.`);

        // Process entry fees and create participations
        const participations = [];
        const colors = ['red', 'blue', 'green', 'yellow']; // Standard Ludo colors

        for (let i = 0; i < queueEntries.length; i++) {
          const queueEntry = queueEntries[i];
          const playerColor = colors[i % colors.length]; // Assign colors cyclically

          // Deduct entry fee only if not free game
          if (entryFee > 0) {
            await walletService.deductGameEntry(queueEntry.userId, entryFee, game.id);
            logger.info(`Deducted ₹${entryFee} from user ${queueEntry.userId} for game entry.`);
          }

          // Create participation record
          const participation = await tx.gameParticipation.create({
            data: {
              userId: queueEntry.userId,
              gameId: game.id,
              position: i, // Store turn order
              color: playerColor, // Assign color to participant
              score: 0 // Initialize score to 0
            }
          });
          participations.push(participation);
          logger.info(`User ${queueEntry.userId} added as participant for game ${game.id} with color ${playerColor}.`);

          // Remove from queue (use deleteMany to avoid errors if already deleted)
          const deletedQueue = await tx.matchmakingQueue.deleteMany({
            where: { id: queueEntry.id }
          });
          if (deletedQueue.count > 0) {
            logger.info(`Queue entry ${queueEntry.id} removed for user ${queueEntry.userId}.`);
          } else {
            logger.warn(`Queue entry ${queueEntry.id} was already removed for user ${queueEntry.userId}.`);
          }
        }

        // Fetch the game again with its participants to ensure the `participants` relation is loaded
        const gameWithParticipants = await tx.game.findUnique({
            where: { id: game.id },
            include: { participants: true } // Include the participants
        });


        return { game: gameWithParticipants, participations, players: queueEntries.map(q => q.user) };
      });

      logger.info(`🎉 Game ${result.game.id} successfully created and players matched. Notifying via callback.`);

      // Notify server.js about the created game and matched players
      // The callback is responsible for emitting socket events to clients
      if (this.onGameCreatedCallback) {
        this.onGameCreatedCallback(result.game, result.players);
      } else {
        logger.warn('No onGameCreatedCallback registered with MatchmakingService.');
      }

      return result.game;
    } catch (error) {
      logger.error('Create game error:', error);
      // Re-throw the error so the caller can decide how to handle it
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
      logger.error(`Get queue status error for user ${userId}:`, error);
      throw new Error('Failed to get queue status');
    }
  }
}

module.exports = new MatchmakingService();