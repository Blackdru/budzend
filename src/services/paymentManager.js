const Razorpay = require('razorpay');
const crypto = require('crypto');
const logger = require('../config/logger');
const prisma = require('../config/database');

class PaymentManager {
  constructor() {
    this.razorpay = null;
    this.initializeRazorpay();
  }

  initializeRazorpay() {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      logger.warn('Razorpay credentials not configured');
      return;
    }

    this.razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
    
    logger.info('Razorpay initialized successfully');
  }

  async createDepositOrder(userId, amount) {
    if (!this.razorpay) {
      throw new Error('Payment gateway not configured');
    }

    if (amount < 10 || amount > 50000) {
      throw new Error('Invalid amount. Must be between ₹10 and ₹50,000');
    }

    try {
      const order = await this.razorpay.orders.create({
        amount: Math.round(amount * 100), // Convert to paise
        currency: 'INR',
        receipt: `deposit_${userId}_${Date.now()}`,
        notes: {
          userId,
          type: 'DEPOSIT'
        }
      });

      // Create pending transaction
      const transaction = await prisma.transaction.create({
        data: {
          userId,
          type: 'DEPOSIT',
          amount,
          status: 'PENDING',
          description: `Wallet deposit of ₹${amount}`,
          razorpayOrderId: order.id
        }
      });

      return {
        success: true,
        order,
        transactionId: transaction.id
      };
    } catch (error) {
      logger.error('Error creating deposit order:', error);
      throw new Error('Failed to create payment order');
    }
  }

  async verifyPayment(razorpayOrderId, razorpayPaymentId, razorpaySignature) {
    if (!this.razorpay) {
      throw new Error('Payment gateway not configured');
    }

    try {
      // Verify signature
      const expectedSignature = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
        .update(razorpayOrderId + '|' + razorpayPaymentId)
        .digest('hex');

      if (expectedSignature !== razorpaySignature) {
        throw new Error('Invalid payment signature');
      }

      // Fetch payment details
      const payment = await this.razorpay.payments.fetch(razorpayPaymentId);
      
      if (payment.status !== 'captured') {
        throw new Error('Payment not captured');
      }

      return {
        success: true,
        payment
      };
    } catch (error) {
      logger.error('Error verifying payment:', error);
      throw error;
    }
  }

  async processDeposit(userId, amount, razorpayOrderId, razorpayPaymentId, razorpaySignature) {
    try {
      // Verify payment first
      await this.verifyPayment(razorpayOrderId, razorpayPaymentId, razorpaySignature);

      // Process in transaction
      const result = await prisma.$transaction(async (tx) => {
        // Find pending transaction
        const transaction = await tx.transaction.findFirst({
          where: {
            userId,
            razorpayOrderId,
            status: 'PENDING',
            type: 'DEPOSIT'
          }
        });

        if (!transaction) {
          throw new Error('Transaction not found or already processed');
        }

        // Update transaction
        await tx.transaction.update({
          where: { id: transaction.id },
          data: {
            status: 'COMPLETED',
            razorpayPaymentId,
            razorpaySignature,
            updatedAt: new Date()
          }
        });

        // Update wallet
        const wallet = await tx.wallet.upsert({
          where: { userId },
          create: { userId, balance: amount },
          update: {
            balance: {
              increment: amount
            }
          }
        });

        return { transaction, wallet };
      });

      logger.info(`Deposit processed: User ${userId}, Amount: ₹${amount}`);
      
      return {
        success: true,
        balance: parseFloat(result.wallet.balance),
        transactionId: result.transaction.id
      };
    } catch (error) {
      logger.error('Error processing deposit:', error);
      throw error;
    }
  }

  async createWithdrawal(userId, amount, bankDetails) {
    if (amount < 100) {
      throw new Error('Minimum withdrawal amount is ₹100');
    }

    if (!bankDetails?.accountNumber || !bankDetails?.ifscCode || !bankDetails?.accountHolderName) {
      throw new Error('Complete bank details required');
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        // Check balance
        const wallet = await tx.wallet.findUnique({
          where: { userId }
        });

        if (!wallet || parseFloat(wallet.balance) < amount) {
          throw new Error('Insufficient balance');
        }

        // Create withdrawal transaction
        const transaction = await tx.transaction.create({
          data: {
            userId,
            type: 'WITHDRAWAL',
            amount,
            status: 'PENDING',
            description: `Withdrawal of ₹${amount}`,
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

        // Deduct from wallet
        await tx.wallet.update({
          where: { userId },
          data: {
            balance: {
              decrement: amount
            }
          }
        });

        return transaction;
      });

      // DEMO ONLY: Auto-approve withdrawal after 30 seconds. In production, integrate with a real payout service and remove this logic.
      this.scheduleWithdrawalProcessing(result.id, userId, amount);

      return {
        success: true,
        transactionId: result.id,
        message: 'Withdrawal request created successfully'
      };
    } catch (error) {
      logger.error('Error creating withdrawal:', error);
      throw error;
    }
  }

  scheduleWithdrawalProcessing(transactionId, userId, amount) {
    // Demo auto-approval after 30 seconds
    setTimeout(async () => {
      try {
        const transaction = await prisma.transaction.findUnique({
          where: { id: transactionId }
        });

        if (!transaction || transaction.status !== 'PENDING') {
          return;
        }

        await prisma.transaction.update({
          where: { id: transactionId },
          data: {
            status: 'COMPLETED',
            description: 'Withdrawal processed (Demo)',
            updatedAt: new Date()
          }
        });

        logger.info(`Withdrawal auto-processed: ${transactionId} for user ${userId}`);
      } catch (error) {
        logger.error(`Error auto-processing withdrawal ${transactionId}:`, error);
        
        // Refund on failure
        try {
          await prisma.$transaction(async (tx) => {
            await tx.transaction.update({
              where: { id: transactionId },
              data: {
                status: 'FAILED',
                description: 'Withdrawal failed - amount refunded'
              }
            });

            await tx.wallet.update({
              where: { userId },
              data: {
                balance: {
                  increment: amount
                }
              }
            });
          });
          
          logger.info(`Withdrawal ${transactionId} failed, amount refunded to user ${userId}`);
        } catch (refundError) {
          logger.error(`Critical: Failed to refund withdrawal ${transactionId}:`, refundError);
        }
      }
    }, 30000);
  }

  async getTransactionHistory(userId, page = 1, limit = 20, type = null) {
    try {
      const where = { userId };
      if (type) {
        where.type = type;
      }

      const [transactions, total] = await Promise.all([
        prisma.transaction.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit
        }),
        prisma.transaction.count({ where })
      ]);

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
      logger.error('Error fetching transaction history:', error);
      throw new Error('Failed to fetch transaction history');
    }
  }

  async getWalletBalance(userId) {
    try {
      const wallet = await prisma.wallet.findUnique({
        where: { userId }
      });

      return wallet ? parseFloat(wallet.balance) : 0;
    } catch (error) {
      logger.error('Error fetching wallet balance:', error);
      throw new Error('Failed to fetch wallet balance');
    }
  }

  verifyWebhookSignature(body, signature) {
    if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
      logger.warn('Webhook secret not configured');
      return false;
    }

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(body)
      .digest('hex');

    return signature === expectedSignature;
  }

  async handleWebhook(event) {
    try {
      switch (event.event) {
        case 'payment.captured':
          await this.handlePaymentCaptured(event.payload.payment.entity);
          break;
        case 'payment.failed':
          await this.handlePaymentFailed(event.payload.payment.entity);
          break;
        default:
          logger.info('Unhandled webhook event:', event.event);
      }
    } catch (error) {
      logger.error('Error handling webhook:', error);
    }
  }

  async handlePaymentCaptured(payment) {
    logger.info('Payment captured via webhook:', payment.id);
    // Additional processing if needed
  }

  async handlePaymentFailed(payment) {
    logger.info('Payment failed via webhook:', payment.id);
    
    // Mark transaction as failed
    try {
      await prisma.transaction.updateMany({
        where: {
          razorpayPaymentId: payment.id,
          status: 'PENDING'
        },
        data: {
          status: 'FAILED',
          description: 'Payment failed'
        }
      });
    } catch (error) {
      logger.error('Error updating failed payment:', error);
    }
  }
}

module.exports = new PaymentManager();