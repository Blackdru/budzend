const jwt = require('jsonwebtoken');
const prisma = require('../config/database');
const logger = require('../config/logger');

const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ success: false, message: 'Access token required' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Verify user exists and is active
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: { wallet: true }
    });

    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid token' });
    }

    req.user = user;
    next();
  } catch (error) {
    logger.error('Authentication error:', error);
    return res.status(403).json({ success: false, message: 'Invalid or expired token' });
  }
};

const authenticateSocket = async (socket, next) => {
  try {
    logger.info(`🔐 SOCKET AUTH: Authenticating socket ${socket.id}`);
    
    const token = socket.handshake.auth.token;
    
    if (!token) {
      logger.error(`❌ SOCKET AUTH: No token provided for socket ${socket.id}`);
      return next(new Error('Authentication error: No token provided'));
    }

    logger.info(`🎫 SOCKET AUTH: Token received for socket ${socket.id}`);
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    logger.info(`✅ SOCKET AUTH: Token decoded successfully for user ${decoded.userId}`);
    
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: { wallet: true }
    });

    if (!user) {
      logger.error(`❌ SOCKET AUTH: User ${decoded.userId} not found in database`);
      return next(new Error('Authentication error: Invalid token'));
    }

    logger.info(`👤 SOCKET AUTH: User authenticated - ${user.name} (${user.phoneNumber})`);
    logger.info(`💰 SOCKET AUTH: User balance - ₹${user.wallet ? user.wallet.balance : 0}`);

    socket.user = user;
    logger.info(`✅ SOCKET AUTH: Authentication successful for socket ${socket.id}`);
    next();
  } catch (error) {
    logger.error(`❌ SOCKET AUTH ERROR for socket ${socket.id}:`, error);
    next(new Error('Authentication error: Invalid token'));
  }
};

module.exports = {
  authenticateToken,
  authenticateSocket
};