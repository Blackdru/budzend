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

module.exports = router;
