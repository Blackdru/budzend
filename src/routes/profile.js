const express = require('express');
const router = express.Router();
const prisma = require('../config/database');
const { authSchemas } = require('../validation/schemas');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../config/logger');

// Get user profile
router.get('/', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { wallet: true }
    });
    res.json({ success: true, user });
  } catch (err) {
    logger.error('Get profile error:', err);
    res.status(500).json({ success: false, message: 'Failed to get profile' });
  }
});

// Update user profile
router.put('/', authenticateToken, async (req, res) => {
  try {
    const { error, value } = authSchemas.updateProfile.validate(req.body);
    if (error) {
      return res.status(400).json({ success: false, message: error.details[0].message });
    }
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: value,
      include: { wallet: true }
    });
    res.json({ success: true, user });
  } catch (err) {
    logger.error('Update profile error:', err);
    res.status(500).json({ success: false, message: 'Failed to update profile' });
  }
});

// Get referral data
router.get('/referral', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { referralCode: true }
    });

    if (!user.referralCode) {
      // Generate referral code if not exists
      const referralCode = generateReferralCode();
      await prisma.user.update({
        where: { id: req.user.id },
        data: { referralCode }
      });
      user.referralCode = referralCode;
    }

    // Get referral stats
    const referredUsers = await prisma.user.findMany({
      where: { referredBy: req.user.id },
      select: {
        id: true,
        name: true,
        createdAt: true
      }
    });

    // Calculate earnings from referrals
    const referralEarnings = await prisma.walletTransaction.findMany({
      where: {
        userId: req.user.id,
        type: 'REFERRAL_BONUS'
      }
    });

    const totalEarnings = referralEarnings.reduce((sum, transaction) => sum + transaction.amount, 0);
    const pendingEarnings = 0; // Calculate pending earnings if needed

    const stats = {
      totalReferrals: referredUsers.length,
      totalEarnings,
      pendingEarnings,
      referredUsers: referredUsers.map(user => ({
        name: user.name,
        joinedAt: user.createdAt,
        earnings: 25 // Fixed referral bonus amount
      }))
    };

    res.json({
      success: true,
      referralCode: user.referralCode,
      stats
    });
  } catch (err) {
    logger.error('Get referral data error:', err);
    res.status(500).json({ success: false, message: 'Failed to get referral data' });
  }
});

// Apply referral code during signup
router.post('/apply-referral', authenticateToken, async (req, res) => {
  try {
    const { referralCode } = req.body;
    
    if (!referralCode) {
      return res.status(400).json({ success: false, message: 'Referral code is required' });
    }

    // Check if user already has a referrer
    const currentUser = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { referredBy: true }
    });

    if (currentUser.referredBy) {
      return res.status(400).json({ success: false, message: 'You have already used a referral code' });
    }

    // Find the referrer
    const referrer = await prisma.user.findUnique({
      where: { referralCode },
      select: { id: true, name: true }
    });

    if (!referrer) {
      return res.status(400).json({ success: false, message: 'Invalid referral code' });
    }

    if (referrer.id === req.user.id) {
      return res.status(400).json({ success: false, message: 'You cannot use your own referral code' });
    }

    // Apply referral in transaction
    await prisma.$transaction(async (tx) => {
      // Update user with referrer
      await tx.user.update({
        where: { id: req.user.id },
        data: { referredBy: referrer.id }
      });

      // Give bonus to new user (₹50)
      await tx.walletTransaction.create({
        data: {
          userId: req.user.id,
          amount: 50,
          type: 'REFERRAL_SIGNUP_BONUS',
          description: `Signup bonus for using referral code ${referralCode}`,
          status: 'COMPLETED'
        }
      });

      // Update new user's wallet
      await tx.wallet.update({
        where: { userId: req.user.id },
        data: { balance: { increment: 50 } }
      });

      // Give bonus to referrer (₹25)
      await tx.walletTransaction.create({
        data: {
          userId: referrer.id,
          amount: 25,
          type: 'REFERRAL_BONUS',
          description: `Referral bonus for inviting new user`,
          status: 'COMPLETED'
        }
      });

      // Update referrer's wallet
      await tx.wallet.update({
        where: { userId: referrer.id },
        data: { balance: { increment: 25 } }
      });
    });

    res.json({
      success: true,
      message: 'Referral code applied successfully! ₹50 bonus added to your wallet.',
      bonusAmount: 50
    });
  } catch (err) {
    logger.error('Apply referral code error:', err);
    res.status(500).json({ success: false, message: 'Failed to apply referral code' });
  }
});

// Helper function to generate referral code
function generateReferralCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

module.exports = router;