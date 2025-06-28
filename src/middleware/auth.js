const jwt = require('jsonwebtoken');
const prisma = require('../config/database');
const logger = require('../config/logger');

const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      logger.warn('Auth Token: No token provided for HTTP request');
      return res.status(401).json({ success: false, message: 'Access token required' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Verify user exists and is active
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        name: true,
        phoneNumber: true,
        email: true,
        createdAt: true,
        updatedAt: true,
        wallet: true
      }
    });

    if (!user) {
      logger.warn(`Auth Token: User ${decoded.userId} not found or inactive`);
      return res.status(401).json({ success: false, message: 'Invalid token' });
    }

    // Ensure user has a name, use phone number as fallback
    if (!user.name || user.name.trim() === '') {
      logger.warn(`⚠️ HTTP AUTH: User ${user.id} has no name, using phone number as fallback`);
      user.name = user.phoneNumber || `User${user.id.slice(-4)}`;
    }

    req.user = user;
    logger.debug(`Auth Token: User ${user.id} (${user.name}) authenticated for HTTP request.`);
    next();
  } catch (error) {
    logger.error('Auth Token: Authentication error:', error);
    // Explicitly check for specific JWT errors for more granular responses
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Token expired. Please log in again.' });
    }
    if (error.name === 'JsonWebTokenError') {
      return res.status(403).json({ success: false, message: 'Invalid token.' });
    }
    return res.status(500).json({ success: false, message: 'Authentication failed due to server error.' });
  }
};

const authenticateSocket = async (socket, next) => {
  try {
    logger.info(`🔐 SOCKET AUTH: Authenticating socket ${socket.id}`);
    
    const token = socket.handshake.auth.token;
    
    if (!token) {
      logger.warn(`❌ SOCKET AUTH: No token provided for socket ${socket.id}`);
      return next(new Error('Authentication error: No token provided')); // This error will be caught by io.use's callback
    }

    logger.debug(`🎫 SOCKET AUTH: Token received for socket ${socket.id}`);
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    logger.debug(`✅ SOCKET AUTH: Token decoded successfully for user ${decoded.userId}`);
    
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        name: true,
        phoneNumber: true,
        email: true,
        createdAt: true,
        updatedAt: true,
        wallet: true
      }
    });

    if (!user) {
      logger.warn(`❌ SOCKET AUTH: User ${decoded.userId} not found in database`);
      return next(new Error('Authentication error: Invalid user')); // This error will be caught by io.use's callback
    }

    // Ensure user has a name, use phone number as fallback
    if (!user.name || user.name.trim() === '') {
      logger.warn(`⚠️ SOCKET AUTH: User ${user.id} has no name, using phone number as fallback`);
      user.name = user.phoneNumber || `User${user.id.slice(-4)}`;
    }

    logger.info(`👤 SOCKET AUTH: User authenticated - ${user.name} (${user.phoneNumber}) (ID: ${user.id})`);
    logger.debug(`💰 SOCKET AUTH: User balance - ₹${user.wallet ? user.wallet.balance : 0}`);

    socket.user = user; // Attach user object to socket
    next(); // Authentication successful, proceed with connection
  } catch (error) {
    logger.error(`❌ SOCKET AUTH ERROR for socket ${socket.id}:`, error);
    // Important: For socket.io middleware, call next(error) to reject the connection.
    // The server.js io.use block will handle what to do with this error (e.g., disconnect).
    if (error.name === 'TokenExpiredError') {
      return next(new Error('Authentication error: Token expired'));
    }
    if (error.name === 'JsonWebTokenError') {
      return next(new Error('Authentication error: Invalid token'));
    }
    next(new Error('Authentication error: Internal server problem'));
  }
};

module.exports = {
  authenticateToken,
  authenticateSocket
};
