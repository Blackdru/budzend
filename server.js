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
  
  logger.info(`Socket connected: ${socket.id} (user: ${userId})`);

  // Join user-specific room for notifications
  socket.join(`user:${userId}`);

  // Setup memory game handlers
  memoryGameService.setupSocketHandlers(socket);
  
  // Setup fast ludo handlers
  fastLudoService.setupSocketHandlers(socket);

  // Matchmaking events
  socket.on('joinMatchmaking', async (data) => {
    try {
      const { gameType, maxPlayers, entryFee } = data;
      
      // Validate user has sufficient balance
      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: { wallet: true }
      });
      
      if (!user.wallet || user.wallet.balance < entryFee) {
        return socket.emit('error', { message: 'Insufficient balance' });
      }
      
      await matchmakingService.joinQueue(userId, gameType, maxPlayers, entryFee);
      socket.emit('matchmakingStatus', { status: 'waiting' });
      
      logger.info(`User ${userId} joined matchmaking queue`);
    } catch (err) {
      logger.error('Matchmaking join error:', err);
      socket.emit('error', { message: err.message });
    }
  });

  socket.on('leaveMatchmaking', async () => {
    try {
      await matchmakingService.leaveQueue(userId);
      socket.emit('matchmakingStatus', { status: 'left' });
      
      logger.info(`User ${userId} left matchmaking queue`);
    } catch (err) {
      logger.error('Matchmaking leave error:', err);
      socket.emit('error', { message: err.message });
    }
  });

  // Game events
  socket.on('joinGameRoom', ({ gameId }) => {
    socket.join(`game:${gameId}`);
    logger.info(`User ${userId} joined game room: ${gameId}`);
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
    activeSockets.delete(socket.id);
    userSockets.delete(userId);
    
    // Remove from matchmaking if in queue
    matchmakingService.leaveQueue(userId).catch(err => {
      logger.error('Error removing user from matchmaking on disconnect:', err);
    });
    
    logger.info(`Socket disconnected: ${socket.id} (user: ${userId})`);
  });
});

// Matchmaking service callback for game creation
matchmakingService.setGameCreatedCallback((game, players) => {
  // Notify all matched players
  players.forEach(player => {
    const socketId = userSockets.get(player.id);
    if (socketId) {
      io.to(`user:${player.id}`).emit('matchFound', { 
        game,
        message: 'Match found! Joining game...' 
      });
    }
  });
  
  logger.info(`Game ${game.id} created with ${players.length} players`);
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
    
    server.listen(PORT, () => {
      logger.info(`🚀 Professional Gaming Platform server running on port ${PORT}`);
      logger.info(`📱 API Base URL: http://localhost:${PORT}/api`);
      logger.info(`🏥 Health Check: http://localhost:${PORT}/health`);
      logger.info(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
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