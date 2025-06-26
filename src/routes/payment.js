const express = require('express');
const router = express.Router();
const Razorpay = require('razorpay');
const crypto = require('crypto');
const { authenticateToken } = require('../middleware/auth');
const walletService = require('../services/walletService');
const logger = require('../config/logger');

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Create order for deposit
router.post('/create-deposit-order', authenticateToken, async (req, res) => {
  try {
    const { amount } = req.body;
    const userId = req.user.id;

    if (!amount || amount < 10) {
      return res.status(400).json({
        success: false,
        message: 'Minimum deposit amount is ₹10'
      });
    }

    if (amount > 50000) {
      return res.status(400).json({
        success: false,
        message: 'Maximum deposit amount is ₹50,000'
      });
    }

    // Create Razorpay order
    const order = await razorpay.orders.create({
      amount: amount * 100, // amount in paise
      currency: 'INR',
      receipt: `deposit_${userId}_${Date.now()}`,
      notes: {
        userId,
        type: 'DEPOSIT'
      }
    });

    // Create transaction record
    const transaction = await walletService.createTransaction(
      userId,
      'DEPOSIT',
      amount,
      'PENDING',
      `Wallet deposit of ₹${amount}`,
      order.id
    );

    res.json({
      success: true,
      order,
      transactionId: transaction.id
    });

  } catch (error) {
    logger.error('Create deposit order error:', error);
    if (error && error.error && error.error.description) {
      // Razorpay error
      return res.status(500).json({
        success: false,
        message: error.error.description
      });
    }
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to create deposit order'
    });
  }
});

// Verify deposit payment
router.post('/verify-deposit', authenticateToken, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, amount } = req.body;
    const userId = req.user.id;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: 'Missing payment details'
      });
    }

    // Verify signature
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + '|' + razorpay_payment_id)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment signature'
      });
    }

    // Get payment details from Razorpay
    const payment = await razorpay.payments.fetch(razorpay_payment_id);
    
    if (payment.status !== 'captured') {
      return res.status(400).json({
        success: false,
        message: 'Payment not captured'
      });
    }

    // Process the deposit
    const result = await walletService.processDeposit(
      userId,
      amount,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    );

    if (result.success) {
      res.json({
        success: true,
        message: 'Deposit successful',
        balance: result.balance,
        transactionId: result.transactionId
      });
    } else {
      res.status(400).json({
        success: false,
        message: result.message
      });
    }

  } catch (error) {
    logger.error('Verify deposit error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify deposit'
    });
  }
});

// Create withdrawal request
router.post('/create-withdrawal', authenticateToken, async (req, res) => {
  try {
    const { amount, bankDetails } = req.body;
    const userId = req.user.id;

    if (!amount || amount < 100) {
      return res.status(400).json({
        success: false,
        message: 'Minimum withdrawal amount is ₹100'
      });
    }

    if (!bankDetails || !bankDetails.accountNumber || !bankDetails.ifscCode || !bankDetails.accountHolderName) {
      return res.status(400).json({
        success: false,
        message: 'Bank details are required for withdrawal'
      });
    }

    // Check wallet balance
    const wallet = await walletService.getWallet(userId);
    if (!wallet || wallet.balance < amount) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient balance'
      });
    }

    // Create withdrawal request
    const result = await walletService.createWithdrawalRequest(userId, amount, bankDetails);

    if (result.success) {
      res.json({
        success: true,
        message: 'Withdrawal request created successfully',
        transactionId: result.transactionId,
        estimatedProcessingTime: '2-3 business days'
      });
    } else {
      res.status(400).json({
        success: false,
        message: result.message
      });
    }

  } catch (error) {
    logger.error('Create withdrawal error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create withdrawal request'
    });
  }
});

// Get payment history
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const type = req.query.type; // Optional filter by transaction type

    const history = await walletService.getTransactionHistory(userId, page, limit, type);

    res.json({
      success: true,
      ...history
    });

  } catch (error) {
    logger.error('Get payment history error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payment history'
    });
  }
});

// Get wallet balance
router.get('/balance', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const wallet = await walletService.getWallet(userId);

    res.json({
      success: true,
      balance: wallet ? wallet.balance : 0
    });

  } catch (error) {
    logger.error('Get balance error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch balance'
    });
  }
});

// Get Razorpay key for frontend
router.get('/razorpay-key', (req, res) => {
  res.json({
    success: true,
    key: process.env.RAZORPAY_KEY_ID
  });
});

// Webhook for payment status updates (for future use)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const body = req.body.toString();

    // Verify webhook signature
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(body)
      .digest('hex');

    if (signature === expectedSignature) {
      const event = JSON.parse(body);
      
      // Handle different webhook events
      switch (event.event) {
        case 'payment.captured':
          // Handle successful payment
          logger.info('Payment captured:', event.payload.payment.entity.id);
          break;
        case 'payment.failed':
          // Handle failed payment
          logger.info('Payment failed:', event.payload.payment.entity.id);
          break;
        default:
          logger.info('Unhandled webhook event:', event.event);
      }

      res.status(200).json({ status: 'ok' });
    } else {
      res.status(400).json({ status: 'invalid signature' });
    }

  } catch (error) {
    logger.error('Webhook error:', error);
    res.status(500).json({ status: 'error' });
  }
});

module.exports = router;