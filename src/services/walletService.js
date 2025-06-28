const Razorpay = require('razorpay');
const crypto = require('crypto');
const prisma = require('../config/database');
const logger = require('../config/logger');

class WalletService {
  constructor() {
    // Ensure Razorpay keys are loaded from environment variables
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      logger.error('RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET not configured. Razorpay functionalities will be unavailable.');
      this.razorpay = null; // Set to null to indicate it's not configured
    } else {
      this.razorpay = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
      });
      logger.info('Razorpay instance initialized.');
    }
  }

  async getWallet(userId) {
    try {
      let wallet = await prisma.wallet.findUnique({
        where: { userId }
      });

      // Create wallet if it doesn't exist
      if (!wallet) {
        logger.info(`Creating new wallet for user ${userId}`);
        wallet = await prisma.wallet.create({
          data: {
            userId,
            balance: 0 // Initialize balance to 0
          }
        });
      }

      return wallet;
    } catch (error) {
      logger.error(`Get wallet error for user ${userId}:`, error);
      throw new Error('Failed to get wallet');
    }
  }

  async getWalletBalance(userId) {
    try {
      const wallet = await this.getWallet(userId);
      return parseFloat(wallet.balance); // Ensure balance is returned as a float
    } catch (error) {
      logger.error(`Get wallet balance error for user ${userId}:`, error);
      throw new Error('Failed to get wallet balance');
    }
  }

  async createTransaction(userId, type, amount, status, description, razorpayOrderId = null, gameId = null) {
    try {
      // Ensure amount is a number for Prisma
      const numericAmount = parseFloat(amount);
      if (isNaN(numericAmount)) {
        logger.error(`Invalid amount for transaction: ${amount}`);
        throw new Error('Invalid amount for transaction');
      }

      return await prisma.transaction.create({
        data: {
          userId,
          type,
          amount: numericAmount,
          status,
          description,
          razorpayOrderId,
          gameId
        }
      });
    } catch (error) {
      logger.error(`Create transaction error for user ${userId}:`, error);
      throw new Error('Failed to create transaction');
    }
  }

  async processDeposit(userId, amount, razorpayOrderId, razorpayPaymentId, razorpaySignature) {
    try {
      // Find pending transaction
      const transaction = await prisma.transaction.findFirst({
        where: {
          userId,
          razorpayOrderId,
          status: 'PENDING',
          type: 'DEPOSIT'
        }
      });

      if (!transaction) {
        logger.warn(`Deposit transaction not found or already processed for user ${userId}, order ${razorpayOrderId}`);
        return { success: false, message: 'Transaction not found or already processed' };
      }

      // Verify payment signature (crucial for security)
      if (this.razorpay) {
        const generatedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
                                       .update(razorpayOrderId + "|" + razorpayPaymentId)
                                       .digest('hex');
        if (generatedSignature !== razorpaySignature) {
          logger.error(`Razorpay signature mismatch for user ${userId}, order ${razorpayOrderId}`);
          // Update transaction to FAILED if signature doesn't match
          await prisma.transaction.update({
            where: { id: transaction.id },
            data: { status: 'FAILED', description: 'Signature verification failed' }
          });
          return { success: false, message: 'Payment verification failed' };
        }
      } else {
        logger.warn('Razorpay not configured. Skipping signature verification for deposit.');
      }

      // Update transaction and wallet in a database transaction
      const result = await prisma.$transaction(async (tx) => {
        // Update transaction status
        const updatedTransaction = await tx.transaction.update({
          where: { id: transaction.id },
          data: {
            status: 'COMPLETED',
            razorpayPaymentId,
            razorpaySignature
          }
        });

        // Ensure wallet exists before updating balance
        await tx.wallet.upsert({
          where: { userId },
          create: { userId, balance: 0 }, // Create with 0 if not exists
          update: {} // No update needed if it exists
        });

        // Update wallet balance (ensure amount is number)
        const updatedWallet = await tx.wallet.update({
          where: { userId },
          data: {
            balance: {
              increment: parseFloat(amount)
            }
          }
        });

        return { transaction: updatedTransaction, wallet: updatedWallet };
      });

      logger.info(`Deposit completed: User ${userId}, Amount: ${amount}, Transaction ID: ${result.transaction.id}`);

      return {
        success: true,
        message: 'Deposit completed successfully',
        balance: parseFloat(result.wallet.balance),
        transactionId: result.transaction.id
      };
    } catch (error) {
      logger.error(`Process deposit error for user ${userId}, order ${razorpayOrderId}:`, error);
      return { success: false, message: 'Failed to process deposit' };
    }
  }

  async createWithdrawalRequest(userId, amount, bankDetails) {
    try {
      const numericAmount = parseFloat(amount);
      if (isNaN(numericAmount) || numericAmount <= 0) {
        throw new Error('Invalid withdrawal amount');
      }

      // Validate bank details
      if (!bankDetails || !bankDetails.accountNumber || !bankDetails.ifscCode || !bankDetails.accountHolderName) {
        throw new Error('Complete bank details are required');
      }

      // Minimum withdrawal amount check
      if (numericAmount < 100) {
        throw new Error('Minimum withdrawal amount is ₹100');
      }

      const wallet = await this.getWallet(userId);

      if (parseFloat(wallet.balance) < numericAmount) {
        logger.warn(`Insufficient balance for withdrawal: User ${userId}, Has: ${wallet.balance}, Wants: ${numericAmount}`);
        return { success: false, message: 'Insufficient balance' };
      }

      // Create withdrawal transaction and update wallet
      const result = await prisma.$transaction(async (tx) => {
        // Create withdrawal transaction
        const transaction = await tx.transaction.create({
          data: {
            userId,
            type: 'WITHDRAWAL',
            amount: numericAmount,
            status: 'PENDING',
            description: `Wallet withdrawal of ₹${numericAmount} to A/C: ${bankDetails.accountNumber.slice(-4)}, IFSC: ${bankDetails.ifscCode}`,
            metadata: {
              bankDetails: {
                accountNumber: bankDetails.accountNumber,
                ifscCode: bankDetails.ifscCode,
                accountHolderName: bankDetails.accountHolderName,
                bankName: bankDetails.bankName || 'Not specified'
              },
              requestedAt: new Date().toISOString()
            }
          }
        });

        // Deduct from wallet (hold the amount)
        const updatedWallet = await tx.wallet.update({
          where: { userId },
          data: {
            balance: {
              decrement: numericAmount
            }
          }
        });

        return { transaction, wallet: updatedWallet };
      });

      // In production, integrate with payout service here
      // For demo, we'll auto-approve after 30 seconds with proper error handling
      logger.info(`Withdrawal request created: User ${userId}, Amount: ${numericAmount}, Transaction ID: ${result.transaction.id}. Auto-approving in 30s.`);
      
      setTimeout(async () => {
        try {
          // Check if transaction still exists and is pending
          const existingTransaction = await prisma.transaction.findUnique({
            where: { id: result.transaction.id }
          });

          if (!existingTransaction || existingTransaction.status !== 'PENDING') {
            logger.info(`Transaction ${result.transaction.id} no longer pending, skipping auto-approval`);
            return;
          }

          const approvedTransaction = await prisma.transaction.update({
            where: { id: result.transaction.id },
            data: { 
              status: 'COMPLETED', 
              description: 'Withdrawal auto-approved (Demo)',
              updatedAt: new Date()
            }
          });
          logger.info(`Withdrawal auto-approved: ${approvedTransaction.id} for user ${userId}`);
          
          // PRODUCTION: Emit socket event to notify user of approval (implement in production environment)
          // io.to(`user:${userId}`).emit('withdrawalApproved', { transactionId: result.transaction.id });
          
        } catch (err) {
          logger.error(`Auto-approval error for transaction ${result.transaction.id}:`, err);
          
          // Mark transaction as failed and refund the amount
          try {
            await prisma.$transaction(async (tx) => {
              await tx.transaction.update({
                where: { id: result.transaction.id },
                data: { 
                  status: 'FAILED', 
                  description: 'Withdrawal failed during processing - amount refunded',
                  updatedAt: new Date()
                }
              });

              // Refund the amount back to wallet
              await tx.wallet.update({
                where: { userId },
                data: {
                  balance: {
                    increment: numericAmount
                  }
                }
              });
            });
            logger.info(`Withdrawal ${result.transaction.id} failed, amount refunded to user ${userId}`);
          } catch (refundErr) {
            logger.error(`Critical error: Failed to refund withdrawal ${result.transaction.id}:`, refundErr);
            // This requires manual intervention
          }
        }
      }, 30000); // 30 seconds delay

      return {
        success: true,
        message: 'Withdrawal request created successfully, pending approval',
        transactionId: result.transaction.id,
        estimatedProcessingTime: '30 seconds (Demo mode)'
      };
    } catch (error) {
      logger.error(`Create withdrawal request error for user ${userId}:`, error);
      return { success: false, message: error.message || 'Failed to create withdrawal request' };
    }
  }

  async deductWallet(userId, amount, type, description, gameId = null) {
    try {
      const numericAmount = parseFloat(amount);
      if (isNaN(numericAmount) || numericAmount <= 0) {
        throw new Error('Invalid amount for deduction');
      }

      const wallet = await this.getWallet(userId);

      if (parseFloat(wallet.balance) < numericAmount) {
        logger.warn(`Insufficient balance for deduction: User ${userId}, Type: ${type}, Has: ${wallet.balance}, Wants: ${numericAmount}`);
        return { success: false, message: 'Insufficient balance' };
      }

      const result = await prisma.$transaction(async (tx) => {
        // Create transaction
        const transaction = await tx.transaction.create({
          data: {
            userId,
            type,
            amount: numericAmount,
            status: 'COMPLETED', // Deductions are typically completed immediately
            description,
            gameId
          }
        });

        // Deduct from wallet
        const updatedWallet = await tx.wallet.update({
          where: { userId },
          data: {
            balance: {
              decrement: numericAmount
            }
          }
        });

        return { transaction, wallet: updatedWallet };
      });

      logger.info(`Wallet deducted: User ${userId}, Amount: ${numericAmount}, Type: ${type}, TransId: ${result.transaction.id}`);

      return {
        success: true,
        balance: parseFloat(result.wallet.balance),
        transactionId: result.transaction.id
      };
    } catch (error) {
      logger.error(`Deduct wallet error for user ${userId}, type ${type}:`, error);
      return { success: false, message: error.message || 'Failed to deduct from wallet' };
    }
  }

  async deductGameEntry(userId, amount, gameId) {
    try {
      return await this.deductWallet(
        userId, 
        amount, 
        'GAME_ENTRY', 
        `Game entry fee for game ${gameId}`, 
        gameId
      );
    } catch (error) {
      logger.error(`Deduct game entry error for user ${userId}, game ${gameId}:`, error);
      // Re-throw for matchmaking service to handle, e.g., if insufficient balance.
      throw error; 
    }
  }

  async creditWallet(userId, amount, type, gameId = null, description = null) {
    try {
      const numericAmount = parseFloat(amount);
      if (isNaN(numericAmount) || numericAmount <= 0) {
        throw new Error('Invalid amount for credit');
      }

      // Ensure wallet exists (upsert can handle this)
      await this.getWallet(userId);

      const result = await prisma.$transaction(async (tx) => {
        // Create transaction
        const transaction = await tx.transaction.create({
          data: {
            userId,
            type,
            amount: numericAmount,
            status: 'COMPLETED', // Credits are typically completed immediately
            description: description || `${type} of ₹${numericAmount}`,
            gameId
          }
        });

        // Add to wallet
        const updatedWallet = await tx.wallet.update({
          where: { userId },
          data: {
            balance: {
              increment: numericAmount
            }
          }
        });

        return { transaction, wallet: updatedWallet };
      });

      logger.info(`Wallet credited: User ${userId}, Amount: ${numericAmount}, Type: ${type}, TransId: ${result.transaction.id}`);

      return {
        success: true,
        balance: parseFloat(result.wallet.balance),
        transactionId: result.transaction.id
      };
    } catch (error) {
      logger.error(`Credit wallet error for user ${userId}, type ${type}:`, error);
      throw error; // Re-throw for higher-level error handling
    }
  }

  async getTransactionHistory(userId, page = 1, limit = 20, type = null) {
    try {
      const whereClause = { userId };
      if (type) {
        whereClause.type = type;
      }

      const transactions = await prisma.transaction.findMany({
        where: whereClause,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit
      });

      const total = await prisma.transaction.count({
        where: whereClause
      });

      return {
        transactions: transactions.map(t => ({
          ...t,
          amount: parseFloat(t.amount)
        })),
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      };
    } catch (error) {
      logger.error(`Get transaction history error for user ${userId}:`, error);
      throw new Error('Failed to get transaction history');
    }
  }

  async getWalletStats(userId) {
    try {
      const stats = await prisma.transaction.groupBy({
        by: ['type'],
        where: { userId, status: 'COMPLETED' },
        _sum: { amount: true },
        _count: { id: true }
      });

      const wallet = await this.getWallet(userId);

      const formattedStats = {
        currentBalance: parseFloat(wallet.balance),
        totalDeposits: 0,
        totalWithdrawals: 0,
        totalGameEntries: 0,
        totalWinnings: 0,
        transactionCounts: {}
      };

      stats.forEach(stat => {
        const amount = parseFloat(stat._sum.amount || 0);
        const count = stat._count.id;

        formattedStats.transactionCounts[stat.type] = count;

        switch (stat.type) {
          case 'DEPOSIT':
            formattedStats.totalDeposits = amount;
            break;
          case 'WITHDRAWAL':
            formattedStats.totalWithdrawals = amount;
            break;
          case 'GAME_ENTRY':
            formattedStats.totalGameEntries = amount;
            break;
          case 'GAME_WINNING':
            formattedStats.totalWinnings = amount;
            break;
        }
      });

      return formattedStats;
    } catch (error) {
      logger.error(`Get wallet stats error for user ${userId}:`, error);
      throw new Error('Failed to get wallet stats');
    }
  }
}

module.exports = new WalletService();
