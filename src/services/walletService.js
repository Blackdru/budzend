const Razorpay = require('razorpay');
const crypto = require('crypto');
const prisma = require('../config/database');
const logger = require('../config/logger');

class WalletService {
  constructor() {
    this.razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }

  async getWallet(userId) {
    try {
      let wallet = await prisma.wallet.findUnique({
        where: { userId }
      });

      // Create wallet if it doesn't exist
      if (!wallet) {
        wallet = await prisma.wallet.create({
          data: {
            userId,
            balance: 0
          }
        });
      }

      return wallet;
    } catch (error) {
      logger.error('Get wallet error:', error);
      throw new Error('Failed to get wallet');
    }
  }

  async getWalletBalance(userId) {
    try {
      const wallet = await this.getWallet(userId);
      return parseFloat(wallet.balance);
    } catch (error) {
      logger.error('Get wallet balance error:', error);
      throw new Error('Failed to get wallet balance');
    }
  }

  async createTransaction(userId, type, amount, status, description, razorpayOrderId = null, gameId = null) {
    try {
      return await prisma.transaction.create({
        data: {
          userId,
          type,
          amount: parseFloat(amount),
          status,
          description,
          razorpayOrderId,
          gameId
        }
      });
    } catch (error) {
      logger.error('Create transaction error:', error);
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
        return { success: false, message: 'Transaction not found' };
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

        // Ensure wallet exists
        await tx.wallet.upsert({
          where: { userId },
          create: { userId, balance: 0 },
          update: {}
        });

        // Update wallet balance
        const updatedWallet = await tx.wallet.update({
          where: { userId },
          data: {
            balance: {
              increment: amount
            }
          }
        });

        return { transaction: updatedTransaction, wallet: updatedWallet };
      });

      logger.info(`Deposit completed: User ${userId}, Amount: ${amount}`);

      return {
        success: true,
        message: 'Deposit completed successfully',
        balance: parseFloat(result.wallet.balance),
        transactionId: result.transaction.id
      };
    } catch (error) {
      logger.error('Process deposit error:', error);
      return { success: false, message: 'Failed to process deposit' };
    }
  }

  async createWithdrawalRequest(userId, amount, bankDetails) {
    try {
      const wallet = await this.getWallet(userId);

      if (parseFloat(wallet.balance) < amount) {
        return { success: false, message: 'Insufficient balance' };
      }

      // Create withdrawal transaction and update wallet
      const result = await prisma.$transaction(async (tx) => {
        // Create withdrawal transaction
        const transaction = await tx.transaction.create({
          data: {
            userId,
            type: 'WITHDRAWAL',
            amount,
            status: 'PENDING',
            description: `Wallet withdrawal of ₹${amount} to ${bankDetails.accountNumber}`
          }
        });

        // Deduct from wallet (hold the amount)
        const updatedWallet = await tx.wallet.update({
          where: { userId },
          data: {
            balance: {
              decrement: amount
            }
          }
        });

        return { transaction, wallet: updatedWallet };
      });

      // In production, integrate with payout service here
      // For demo, we'll auto-approve after 5 seconds
      setTimeout(async () => {
        try {
          await prisma.transaction.update({
            where: { id: result.transaction.id },
            data: { status: 'COMPLETED' }
          });
          logger.info(`Withdrawal auto-approved: ${result.transaction.id}`);
        } catch (err) {
          logger.error('Auto-approval error:', err);
        }
      }, 5000);

      logger.info(`Withdrawal request created: User ${userId}, Amount: ${amount}`);

      return {
        success: true,
        message: 'Withdrawal request created successfully',
        transactionId: result.transaction.id
      };
    } catch (error) {
      logger.error('Create withdrawal request error:', error);
      return { success: false, message: 'Failed to create withdrawal request' };
    }
  }

  async deductWallet(userId, amount, type, description, gameId = null) {
    try {
      const wallet = await this.getWallet(userId);

      if (parseFloat(wallet.balance) < amount) {
        return { success: false, message: 'Insufficient balance' };
      }

      const result = await prisma.$transaction(async (tx) => {
        // Create transaction
        const transaction = await tx.transaction.create({
          data: {
            userId,
            type,
            amount,
            status: 'COMPLETED',
            description,
            gameId
          }
        });

        // Deduct from wallet
        const updatedWallet = await tx.wallet.update({
          where: { userId },
          data: {
            balance: {
              decrement: amount
            }
          }
        });

        return { transaction, wallet: updatedWallet };
      });

      return {
        success: true,
        balance: parseFloat(result.wallet.balance),
        transactionId: result.transaction.id
      };
    } catch (error) {
      logger.error('Deduct wallet error:', error);
      return { success: false, message: 'Failed to deduct from wallet' };
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
      logger.error('Deduct game entry error:', error);
      return { success: false, message: 'Failed to deduct game entry fee' };
    }
  }

  async creditWallet(userId, amount, type, gameId = null, description = null) {
    try {
      // Ensure wallet exists
      await this.getWallet(userId);

      const result = await prisma.$transaction(async (tx) => {
        // Create transaction
        const transaction = await tx.transaction.create({
          data: {
            userId,
            type,
            amount,
            status: 'COMPLETED',
            description: description || `${type} of ₹${amount}`,
            gameId
          }
        });

        // Add to wallet
        const updatedWallet = await tx.wallet.update({
          where: { userId },
          data: {
            balance: {
              increment: amount
            }
          }
        });

        return { transaction, wallet: updatedWallet };
      });

      logger.info(`Wallet credited: User ${userId}, Amount: ${amount}, Type: ${type}`);

      return {
        success: true,
        balance: parseFloat(result.wallet.balance),
        transactionId: result.transaction.id
      };
    } catch (error) {
      logger.error('Credit wallet error:', error);
      return { success: false, message: 'Failed to credit wallet' };
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
      logger.error('Get transaction history error:', error);
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
      logger.error('Get wallet stats error:', error);
      throw new Error('Failed to get wallet stats');
    }
  }
}

module.exports = new WalletService();