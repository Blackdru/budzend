const express = require('express');
const router = express.Router();
const authService = require('../services/authService');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../config/logger');
const Joi = require('joi');

// Validation schemas
const sendOTPSchema = Joi.object({
  phoneNumber: Joi.string()
    .pattern(/^\+91[6-9]\d{9}$/)
    .required()
    .messages({
      'string.pattern.base': 'Please enter a valid Indian mobile number with +91 prefix'
    })
});

const verifyOTPSchema = Joi.object({
  phoneNumber: Joi.string()
    .pattern(/^\+91[6-9]\d{9}$/)
    .required(),
  otp: Joi.string()
    .length(6)
    .pattern(/^\d+$/)
    .required()
    .messages({
      'string.length': 'OTP must be 6 digits',
      'string.pattern.base': 'OTP must contain only numbers'
    })
});

const updateProfileSchema = Joi.object({
  name: Joi.string().min(2).max(50).optional(),
  email: Joi.string().email().optional(),
  avatar: Joi.string().uri().optional()
});

// Send OTP
router.post('/send-otp', async (req, res) => {
  try {
    const { error, value } = sendOTPSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ 
        success: false, 
        message: error.details[0].message 
      });
    }

    const { phoneNumber } = value;
    
    // Rate limiting check - max 3 OTPs per phone number per hour
    const recentOTPs = await require('../config/database').oTPVerification.count({
      where: {
        phoneNumber,
        createdAt: {
          gte: new Date(Date.now() - 60 * 60 * 1000) // Last hour
        }
      }
    });

    if (recentOTPs >= 3) {
      return res.status(429).json({
        success: false,
        message: 'Too many OTP requests. Please try again after an hour.'
      });
    }

    const result = await authService.sendOTP(phoneNumber);
    res.json(result);
  } catch (err) {
    logger.error('Send OTP error:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to send OTP. Please try again.' 
    });
  }
});

// Verify OTP and login/register
router.post('/verify-otp', async (req, res) => {
  try {
    const { error, value } = verifyOTPSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ 
        success: false, 
        message: error.details[0].message 
      });
    }

    const { phoneNumber, otp } = value;
    const result = await authService.verifyOTP(phoneNumber, otp);
    
    res.json(result);
  } catch (err) {
    logger.error('Verify OTP error:', err);
    res.status(400).json({ 
      success: false, 
      message: err.message || 'Invalid OTP. Please try again.' 
    });
  }
});

// Get current user profile
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await require('../config/database').user.findUnique({
      where: { id: userId },
      include: { 
        wallet: true,
        _count: {
          select: {
            gameParticipations: true
          }
        }
      }
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      user: {
        id: user.id,
        phoneNumber: user.phoneNumber,
        name: user.name,
        email: user.email,
        avatar: user.avatar,
        isVerified: user.isVerified,
        createdAt: user.createdAt,
        wallet: user.wallet,
        gamesPlayed: user._count.gameParticipations
      }
    });
  } catch (err) {
    logger.error('Get profile error:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch profile'
    });
  }
});

// Update user profile
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const { error, value } = updateProfileSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ 
        success: false, 
        message: error.details[0].message 
      });
    }

    const userId = req.user.id;
    const result = await authService.updateProfile(userId, value);
    
    res.json(result);
  } catch (err) {
    logger.error('Update profile error:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to update profile'
    });
  }
});

// Refresh token
router.post('/refresh-token', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await require('../config/database').user.findUnique({
      where: { id: userId },
      include: { wallet: true }
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Generate new token
    const jwt = require('jsonwebtoken');
    const token = jwt.sign(
      { userId: user.id, phoneNumber: user.phoneNumber },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        phoneNumber: user.phoneNumber,
        name: user.name,
        email: user.email,
        avatar: user.avatar,
        wallet: user.wallet
      }
    });
  } catch (err) {
    logger.error('Refresh token error:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to refresh token'
    });
  }
});

// Logout (optional - mainly for clearing client-side data)
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    // In a more complex setup, you might want to blacklist the token
    // For now, we'll just return success
    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (err) {
    logger.error('Logout error:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to logout'
    });
  }
});

module.exports = router;