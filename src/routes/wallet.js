const express = require('express');
const router = express.Router();
const walletService = require('../services/walletService');
const { walletSchemas } = require('../validation/schemas');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../config/logger');

// Get wallet balance
router.get('/balance', authenticateToken, async (req, res) => {
  try {
    const balance = await walletService.getWalletBalance(req.user.id);
    res.json({ success: true, balance });
  } catch (err) {
    logger.error('Get wallet balance error:', err);
    res.status(500).json({ success: false, message: 'Failed to get wallet balance' });
  }
});

// Deposit: create Razorpay order
router.post('/deposit', authenticateToken, async (req, res) => {
  try {
    const { error, value } = walletSchemas.deposit.validate(req.body);
    if (error) {
      return res.status(400).json({ success: false, message: error.details[0].message });
    }
    const { amount } = value;
    const result = await walletService.createDepositOrder(req.user.id, amount);
    res.json(result);
  } catch (err) {
    logger.error('Create deposit order error:', err);
    res.status(500).json({ success: false, message: 'Failed to create deposit order' });
  }
});

// Deposit: verify payment
router.post('/deposit/verify', authenticateToken, async (req, res) => {
  try {
    const result = await walletService.verifyDepositPayment(req.user.id, req.body);
    res.json(result);
  } catch (err) {
    logger.error('Verify deposit payment error:', err);
    res.status(400).json({ success: false, message: err.message });
  }
});

// Withdraw
router.post('/withdraw', authenticateToken, async (req, res) => {
  try {
    const { error, value } = walletSchemas.withdraw.validate(req.body);
    if (error) {
      return res.status(400).json({ success: false, message: error.details[0].message });
    }
    const { amount } = value;
    const result = await walletService.processWithdrawal(req.user.id, amount);
    res.json(result);
  } catch (err) {
    logger.error('Process withdrawal error:', err);
    res.status(400).json({ success: false, message: err.message });
  }
});

// Transaction history
router.get('/transactions', authenticateToken, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const result = await walletService.getTransactionHistory(req.user.id, page, limit);
    res.json(result);
  } catch (err) {
    logger.error('Get transaction history error:', err);
    res.status(500).json({ success: false, message: 'Failed to get transaction history' });
  }
});

module.exports = router;
