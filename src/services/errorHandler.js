const logger = require('../config/logger');

class ErrorHandler {
  constructor() {
    this.errorCounts = new Map(); // Track error frequencies
    this.userErrors = new Map(); // Track errors per user
  }

  /**
   * Handle socket errors with proper logging and user notification
   */
  handleSocketError(socket, error, context = {}) {
    const userId = socket.user?.id || 'unknown';
    const socketId = socket.id;
    const errorKey = `${error.name || 'UnknownError'}_${context.action || 'unknown'}`;

    // Increment error count
    this.errorCounts.set(errorKey, (this.errorCounts.get(errorKey) || 0) + 1);

    // Track user-specific errors
    if (!this.userErrors.has(userId)) {
      this.userErrors.set(userId, new Map());
    }
    const userErrorMap = this.userErrors.get(userId);
    userErrorMap.set(errorKey, (userErrorMap.get(errorKey) || 0) + 1);

    // Log the error with context
    logger.error(`❌ Socket Error [${errorKey}] for user ${userId} (socket: ${socketId}):`, {
      error: error.message,
      stack: error.stack,
      context,
      errorCount: this.errorCounts.get(errorKey),
      userErrorCount: userErrorMap.get(errorKey)
    });

    // Determine error severity and response
    const severity = this.determineErrorSeverity(error, userErrorMap.get(errorKey));
    
    switch (severity) {
      case 'low':
        socket.emit('warning', {
          message: 'A minor issue occurred. Please try again.',
          code: errorKey
        });
        break;
      
      case 'medium':
        socket.emit('error', {
          message: 'An error occurred. Please refresh and try again.',
          code: errorKey,
          action: 'refresh'
        });
        break;
      
      case 'high':
        socket.emit('criticalError', {
          message: 'A serious error occurred. Please restart the app.',
          code: errorKey,
          action: 'restart'
        });
        // Consider disconnecting the socket for critical errors
        if (userErrorMap.get(errorKey) > 5) {
          logger.warn(`🚨 User ${userId} has ${userErrorMap.get(errorKey)} ${errorKey} errors. Disconnecting socket.`);
          socket.disconnect(true);
        }
        break;
      
      default:
        socket.emit('error', {
          message: 'An unexpected error occurred.',
          code: errorKey
        });
    }

    return { severity, errorKey, count: this.errorCounts.get(errorKey) };
  }

  /**
   * Handle game-specific errors
   */
  handleGameError(socket, error, gameId, context = {}) {
    const enhancedContext = {
      ...context,
      gameId,
      action: context.action || 'game_operation'
    };

    const result = this.handleSocketError(socket, error, enhancedContext);

    // Additional game-specific error handling
    if (result.severity === 'high' || result.count > 10) {
      // Notify other players in the game about potential issues
      socket.to(`game:${gameId}`).emit('gameWarning', {
        message: 'Another player is experiencing technical difficulties.',
        affectedPlayer: socket.user?.id
      });
    }

    return result;
  }

  /**
   * Handle payment-related errors with special care
   */
  handlePaymentError(socket, error, context = {}) {
    const enhancedContext = {
      ...context,
      action: context.action || 'payment_operation',
      sensitive: true
    };

    // Payment errors are always treated as high severity
    const userId = socket.user?.id || 'unknown';
    
    logger.error(`💳 Payment Error for user ${userId}:`, {
      error: error.message,
      context: enhancedContext,
      timestamp: new Date().toISOString()
    });

    socket.emit('paymentError', {
      message: 'Payment processing failed. Please try again or contact support.',
      code: 'PAYMENT_ERROR',
      supportContact: true
    });

    return { severity: 'high', errorKey: 'PAYMENT_ERROR', requiresSupport: true };
  }

  /**
   * Determine error severity based on error type and frequency
   */
  determineErrorSeverity(error, userErrorCount = 1) {
    // Critical system errors
    if (error.name === 'DatabaseError' || error.message.includes('ECONNREFUSED')) {
      return 'high';
    }

    // Authentication/authorization errors
    if (error.name === 'UnauthorizedError' || error.message.includes('token')) {
      return 'high';
    }

    // Payment-related errors
    if (error.message.includes('payment') || error.message.includes('wallet')) {
      return 'high';
    }

    // Frequent errors from same user
    if (userErrorCount > 3) {
      return 'high';
    } else if (userErrorCount > 1) {
      return 'medium';
    }

    // Validation errors
    if (error.name === 'ValidationError' || error.message.includes('validation')) {
      return 'low';
    }

    // Default to medium severity
    return 'medium';
  }

  /**
   * Handle matchmaking errors
   */
  handleMatchmakingError(socket, error, context = {}) {
    const enhancedContext = {
      ...context,
      action: 'matchmaking'
    };

    const result = this.handleSocketError(socket, error, enhancedContext);

    // Specific matchmaking error responses
    if (error.message.includes('Insufficient balance')) {
      socket.emit('matchmakingError', {
        message: 'Insufficient balance to join this game. Please add funds to your wallet.',
        code: 'INSUFFICIENT_BALANCE',
        action: 'add_funds'
      });
    } else if (error.message.includes('already in queue')) {
      socket.emit('matchmakingError', {
        message: 'You are already in a matchmaking queue.',
        code: 'ALREADY_IN_QUEUE',
        action: 'wait_or_leave'
      });
    } else {
      socket.emit('matchmakingError', {
        message: 'Failed to join matchmaking. Please try again.',
        code: 'MATCHMAKING_FAILED'
      });
    }

    return result;
  }

  /**
   * Get error statistics
   */
  getErrorStats() {
    const totalErrors = Array.from(this.errorCounts.values()).reduce((sum, count) => sum + count, 0);
    const topErrors = Array.from(this.errorCounts.entries())
      .sort(([,a], [,b]) => b - a)
      .slice(0, 10);

    return {
      totalErrors,
      uniqueErrorTypes: this.errorCounts.size,
      topErrors: topErrors.map(([error, count]) => ({ error, count })),
      affectedUsers: this.userErrors.size
    };
  }

  /**
   * Clean up old error data (call periodically)
   */
  cleanup() {
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);

    // In a production system, you'd want to store timestamps with errors
    // For now, we'll just clear data if it gets too large
    if (this.errorCounts.size > 1000) {
      this.errorCounts.clear();
      logger.info('🧹 Cleared error counts due to size limit');
    }

    if (this.userErrors.size > 500) {
      this.userErrors.clear();
      logger.info('🧹 Cleared user error data due to size limit');
    }
  }

  /**
   * Create a standardized error response
   */
  createErrorResponse(message, code, action = null, details = null) {
    return {
      success: false,
      message,
      code,
      action,
      details,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Wrap async functions with error handling
   */
  wrapAsync(fn, context = {}) {
    return async (...args) => {
      try {
        return await fn(...args);
      } catch (error) {
        // If first argument is a socket, handle as socket error
        if (args[0] && args[0].emit && args[0].user) {
          this.handleSocketError(args[0], error, context);
        } else {
          logger.error(`❌ Async function error:`, { error: error.message, context });
        }
        throw error;
      }
    };
  }
}

module.exports = new ErrorHandler();