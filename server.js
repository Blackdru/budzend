const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');
const { sendOtpViaRenflair } = require('./src/utils/sms');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Import services and config
const prisma = require('./src/config/database');
const jwt = require('jsonwebtoken');
const logger = require('./src/config/logger');
const matchmakingService = require('./src/services/matchmakingService');
const gameService = require('./src/services/gameService');
const MemoryGameService = require('./src/MemoryGame');
const FastLudoService = require('./src/FastLudoService');

// Active socket management
const activeSockets = new Map(); // socketId -> userId
const userSockets = new Map(); // userId -> socketId

// Import auth middleware
const { authenticateSocket } = require('./src/middleware/auth');

// Initialize game services
const memoryGameService = new MemoryGameService(io);
const fastLudoService = new FastLudoService(io);

// Socket authentication middleware
io.use(authenticateSocket);

// Socket connection handling
io.on('connection', (socket) => {
  const userId = socket.user.id;
  activeSockets.set(socket.id, userId);
  userSockets.set(userId, socket.id);
  
  logger.info(`🔌 Socket connected: ${socket.id} (user: ${userId})`);
  logger.info(`📊 Total active connections: ${activeSockets.size}`);

  // Join user-specific room for notifications
  socket.join(`user:${userId}`);
  logger.info(`🏠 User ${userId} joined room: user:${userId}`);

  // Setup memory game handlers
  memoryGameService.setupSocketHandlers(socket);
  
  // Setup fast ludo handlers
  fastLudoService.setupSocketHandlers(socket);

  // Log all socket events for debugging
  const originalEmit = socket.emit;
  socket.emit = function(event, ...args) {
    if (event !== 'ping' && event !== 'pong') {
      logger.info(`📡 SOCKET EMIT to ${userId}: ${event}`, args.length > 0 ? JSON.stringify(args[0], null, 2) : '');
    }
    return originalEmit.apply(this, [event, ...args]);
  };

  // Catch-all for any other events
  socket.onAny((eventName, ...args) => {
    if (eventName !== 'ping' && eventName !== 'pong') {
      logger.info(`📥 SOCKET EVENT RECEIVED: ${eventName} from user ${userId}`);
      if (args.length > 0) {
        logger.info(`📋 Event data:`, JSON.stringify(args[0], null, 2));
      }
    }
  });

  // Matchmaking events
  socket.on('joinMatchmaking', async (data) => {
    logger.info(`🎯 SOCKET EVENT: joinMatchmaking from user ${userId}`);
    logger.info(`📋 Data received:`, JSON.stringify(data, null, 2));
    
    try {
      const { gameType, maxPlayers, entryFee } = data;
      
      logger.info(`🎮 Matchmaking request: ${gameType} - ${maxPlayers}P - ₹${entryFee}`);
      
      // Get user data
      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: { wallet: true }
      });
      
      if (!user) {
        logger.error(`❌ User ${userId} not found in database`);
        return socket.emit('error', { message: 'User not found' });
      }
      
      logger.info(`👤 User found: ${user.name} (${user.phoneNumber})`);
      
      // Validate user has sufficient balance (skip for free games)
      if (entryFee > 0) {
        const balance = user.wallet ? user.wallet.balance : 0;
        logger.info(`💰 Balance check: ₹${balance} required: ₹${entryFee}`);
        
        if (!user.wallet || user.wallet.balance < entryFee) {
          logger.error(`❌ Insufficient balance: ₹${balance} < ₹${entryFee}`);
          return socket.emit('error', { message: 'Insufficient balance' });
        }
      } else {
        logger.info(`🆓 Free game - skipping balance check`);
      }
      
      logger.info(`📤 Calling matchmakingService.joinQueue...`);
      await matchmakingService.joinQueue(userId, gameType, maxPlayers, entryFee);
      
      logger.info(`✅ Successfully joined queue, emitting matchmakingStatus`);
      socket.emit('matchmakingStatus', { status: 'waiting' });
      
      logger.info(`🎯 User ${userId} (${user.name}) joined matchmaking queue for ${gameType}`);
    } catch (err) {
      logger.error(`❌ Matchmaking join error for user ${userId}:`, err);
      socket.emit('error', { message: err.message });
    }
  });

  socket.on('leaveMatchmaking', async () => {
    logger.info(`🚪 SOCKET EVENT: leaveMatchmaking from user ${userId}`);
    
    try {
      logger.info(`📤 Calling matchmakingService.leaveQueue for user ${userId}...`);
      await matchmakingService.leaveQueue(userId);
      
      logger.info(`✅ Successfully left queue, emitting matchmakingStatus`);
      socket.emit('matchmakingStatus', { status: 'left' });
      
      logger.info(`🚪 User ${userId} left matchmaking queue`);
    } catch (err) {
      logger.error(`❌ Matchmaking leave error for user ${userId}:`, err);
      socket.emit('error', { message: err.message });
    }
  });

  // Game events
  socket.on('joinGameRoom', ({ gameId }) => {
    logger.info(`🎮 SOCKET EVENT: joinGameRoom from user ${userId}`);
    logger.info(`📋 Game ID: ${gameId}`);
    
    socket.join(`game:${gameId}`);
    logger.info(`🏠 User ${userId} joined game room: game:${gameId}`);
  });

  socket.on('rollDice', async ({ gameId }) => {
    try {
      const game = await gameService.getGameById(gameId);
      if (!game || game.status !== 'PLAYING') {
        return socket.emit('error', { message: 'Game not found or not started' });
      }

      const currentPlayer = game.participants[game.currentTurn];
      if (currentPlayer.userId !== userId) {
        return socket.emit('error', { message: 'Not your turn' });
      }

      // Check if dice already rolled this turn
      const gameData = game.gameData || {};
      if (gameData.diceRolled) {
        return socket.emit('error', { message: 'Dice already rolled this turn' });
      }

      // Roll dice
      const diceValue = Math.floor(Math.random() * 6) + 1;
      gameData.diceValue = diceValue;
      gameData.diceRolled = true;
      gameData.lastRollTime = new Date();

      await gameService.updateGameState(gameId, gameData, game.currentTurn);

      // Broadcast dice roll to all players in game
      io.to(`game:${gameId}`).emit('diceRolled', { 
        userId, 
        diceValue,
        currentTurn: game.currentTurn
      });

      logger.info(`User ${userId} rolled dice: ${diceValue} in game ${gameId}`);
    } catch (err) {
      logger.error('Dice roll error:', err);
      socket.emit('error', { message: err.message });
    }
  });

  socket.on('movePiece', async ({ gameId, pieceId }) => {
    try {
      const game = await gameService.getGameById(gameId);
      if (!game || game.status !== 'PLAYING') {
        return socket.emit('error', { message: 'Game not found or not started' });
      }

      const currentPlayer = game.participants[game.currentTurn];
      if (currentPlayer.userId !== userId) {
        return socket.emit('error', { message: 'Not your turn' });
      }

      const gameData = game.gameData || {};
      const diceValue = gameData.diceValue;
      
      if (!diceValue || !gameData.diceRolled) {
        return socket.emit('error', { message: 'Roll the dice first' });
      }

      // Process the move
      const moveResult = await gameService.movePiece(gameId, userId, pieceId, diceValue);
      
      if (!moveResult.success) {
        return socket.emit('error', { message: moveResult.message });
      }

      // Update game state
      const updatedGame = await gameService.getGameById(gameId);
      
      // Broadcast move to all players
      io.to(`game:${gameId}`).emit('pieceMoved', {
        userId,
        pieceId,
        gameState: updatedGame,
        moveResult
      });

      // Check for game completion
      if (updatedGame.status === 'FINISHED') {
        io.to(`game:${gameId}`).emit('gameFinished', {
          winner: updatedGame.winner,
          finalState: updatedGame
        });
        
        // Process winnings
        await gameService.processGameWinnings(gameId);
      }

      logger.info(`User ${userId} moved piece ${pieceId} in game ${gameId}`);
    } catch (err) {
      logger.error('Move piece error:', err);
      socket.emit('error', { message: err.message });
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    logger.info(`🔌 SOCKET EVENT: disconnect from user ${userId}`);
    logger.info(`📤 Cleaning up socket ${socket.id}...`);
    
    activeSockets.delete(socket.id);
    userSockets.delete(userId);
    
    logger.info(`📊 Remaining active connections: ${activeSockets.size}`);
    
    // Remove from matchmaking if in queue
    logger.info(`🧹 Removing user ${userId} from matchmaking queue...`);
    matchmakingService.leaveQueue(userId).catch(err => {
      logger.error(`❌ Error removing user ${userId} from matchmaking on disconnect:`, err);
    });
    
    logger.info(`🔌 Socket disconnected: ${socket.id} (user: ${userId})`);
  });
});

// Matchmaking service callback for game creation
matchmakingService.setGameCreatedCallback((game, players) => {
  logger.info(`🎉 MATCHMAKING CALLBACK: Game created!`);
  logger.info(`🎮 Game ID: ${game.id}`);
  logger.info(`🎯 Game Type: ${game.type}`);
  logger.info(`👥 Players: ${players.length}`);
  
  // Notify all matched players and auto-join them to game rooms
  players.forEach((player, index) => {
    logger.info(`📤 Notifying player ${index + 1}: ${player.name} (${player.id})`);
    
    const socketId = userSockets.get(player.id);
    if (socketId) {
      logger.info(`✅ Socket found for ${player.name}: ${socketId}`);
      
      const matchData = { 
        game,
        playerId: player.id,
        playerName: player.name,
        playerIndex: index,
        message: 'Match found! Joining game...' 
      };
      
      logger.info(`📡 Emitting matchFound to user:${player.id}:`, JSON.stringify(matchData, null, 2));
      io.to(`user:${player.id}`).emit('matchFound', matchData);
      
      // Auto-join the player to the game room
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        socket.join(`game:${game.id}`);
        logger.info(`🏠 Auto-joined ${player.name} to game room: game:${game.id}`);
        
        // Initialize game-specific room joining
        if (game.type === 'MEMORY') {
          memoryGameService.joinRoom(socket, {
            roomId: game.id,
            playerId: player.id,
            playerName: player.name
          });
        } else if (game.type === 'FAST_LUDO') {
          fastLudoService.joinRoom(socket, {
            gameId: game.id,
            playerId: player.id,
            playerName: player.name
          });
        }
      }
    } else {
      logger.error(`❌ No socket found for player ${player.name} (${player.id})`);
    }
  });
  
  // Auto-start games after a short delay
  setTimeout(() => {
    if (game.type === 'MEMORY') {
      logger.info(`🎮 Auto-starting Memory game ${game.id}`);
      memoryGameService.startMemoryGame(null, { roomId: game.id, playerId: players[0].id });
    } else if (game.type === 'FAST_LUDO') {
      logger.info(`🎮 Auto-starting Fast Ludo game ${game.id}`);
      fastLudoService.startGame(null, { gameId: game.id, playerId: players[0].id });
    }
  }, 3000); // Give players 3 seconds to join rooms
  
  logger.info(`🎉 Game ${game.id} created with ${players.length} players - notifications sent!`);
});

// Express middleware
app.use(cors());
app.use(helmet());
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // limit each IP to 200 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
}));
app.use(express.json());

// Routes
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/wallet', require('./src/routes/wallet'));
app.use('/api/matchmaking', require('./src/routes/matchmaking'));
app.use('/api/game', require('./src/routes/game'));
app.use('/api/profile', require('./src/routes/profile'));
app.use('/api/payment', require('./src/routes/payment'));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK',
    timestamp: new Date().toISOString(),
    activeConnections: activeSockets.size,
    uptime: process.uptime()
  });
});

// Debug endpoint to check matchmaking queue
app.get('/debug/queue', async (req, res) => {
  try {
    const queueEntries = await prisma.matchmakingQueue.findMany({
      include: { user: true }
    });
    
    res.json({
      success: true,
      queueCount: queueEntries.length,
      entries: queueEntries.map(entry => ({
        id: entry.id,
        userId: entry.userId,
        userName: entry.user.name,
        gameType: entry.gameType,
        maxPlayers: entry.maxPlayers,
        entryFee: entry.entryFee,
        createdAt: entry.createdAt
      }))
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ 
    success: false, 
    message: 'Internal server error' 
  });
});


const PORT = process.env.PORT || 8080;

// Start server
async function startServer() {
  try {
    // Test database connection first
    await prisma.$connect();
    logger.info('✅ Database connected successfully');
    
    // Test matchmaking service
    logger.info('🎯 Testing matchmaking service...');
    const queueStatus = await matchmakingService.getQueueStatus('test');
    logger.info('✅ Matchmaking service working');
    
    server.listen(PORT, () => {
      logger.info(`🚀 Professional Gaming Platform server running on port ${PORT}`);
      logger.info(`📱 API Base URL: http://localhost:${PORT}/api`);
      logger.info(`🏥 Health Check: http://localhost:${PORT}/health`);
      logger.info(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info(`🎮 Matchmaking running every 3 seconds`);
    });
  } catch (error) {
    logger.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

module.exports = { app, server, io };