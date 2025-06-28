const logger = require('../config/logger');

// Request timing middleware
const requestTiming = (req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    const method = req.method;
    const url = req.originalUrl;
    const status = res.statusCode;
    
    // Log slow requests (>1000ms)
    if (duration > 1000) {
      logger.warn(`Slow request: ${method} ${url} - ${duration}ms - Status: ${status}`);
    }
    
    // Log all requests in debug mode
    logger.debug(`${method} ${url} - ${duration}ms - Status: ${status}`);
  });
  
  next();
};

// Memory usage monitoring
const memoryMonitor = () => {
  const used = process.memoryUsage();
  const memoryInfo = {
    rss: Math.round(used.rss / 1024 / 1024) + ' MB',
    heapTotal: Math.round(used.heapTotal / 1024 / 1024) + ' MB',
    heapUsed: Math.round(used.heapUsed / 1024 / 1024) + ' MB',
    external: Math.round(used.external / 1024 / 1024) + ' MB'
  };
  
  // Warn if heap usage is high (>500MB)
  if (used.heapUsed > 500 * 1024 * 1024) {
    logger.warn('High memory usage detected:', memoryInfo);
  }
  
  return memoryInfo;
};

// Socket connection limiter
const socketLimiter = (io) => {
  const connectionCounts = new Map();
  const MAX_CONNECTIONS_PER_IP = 5;
  
  io.use((socket, next) => {
    const ip = socket.handshake.address;
    const currentConnections = connectionCounts.get(ip) || 0;
    
    if (currentConnections >= MAX_CONNECTIONS_PER_IP) {
      logger.warn(`Connection limit exceeded for IP: ${ip}`);
      return next(new Error('Too many connections from this IP'));
    }
    
    connectionCounts.set(ip, currentConnections + 1);
    
    socket.on('disconnect', () => {
      const count = connectionCounts.get(ip) || 0;
      if (count <= 1) {
        connectionCounts.delete(ip);
      } else {
        connectionCounts.set(ip, count - 1);
      }
    });
    
    next();
  });
};

// Game state cleanup
const gameStateCleanup = (gameServices) => {
  setInterval(() => {
    const now = Date.now();
    const CLEANUP_THRESHOLD = 30 * 60 * 1000; // 30 minutes
    
    gameServices.forEach(service => {
      if (service.games && typeof service.games.forEach === 'function') {
        service.games.forEach((gameInstance, gameId) => {
          const lastActivity = gameInstance.lastActivity || gameInstance.createdAt || now;
          
          if (now - lastActivity > CLEANUP_THRESHOLD) {
            logger.info(`Cleaning up inactive game: ${gameId}`);
            service.games.delete(gameId);
          }
        });
      }
    });
  }, 10 * 60 * 1000); // Run every 10 minutes
};

module.exports = {
  requestTiming,
  memoryMonitor,
  socketLimiter,
  gameStateCleanup
};