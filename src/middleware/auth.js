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
    const token = socket.handshake.auth.token;
    
    if (!token) {
      return next(new Error('Authentication error: No token provided'));
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: { wallet: true }
    });

    if (!user) {
      return next(new Error('Authentication error: Invalid token'));
    }

    socket.user = user;
    next();
  } catch (error) {
    logger.error('Socket authentication error:', error);
    next(new Error('Authentication error: Invalid token'));
  }
};

module.exports = {
  authenticateToken,
  authenticateSocket
};