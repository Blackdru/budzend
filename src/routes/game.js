const express = require('express');
const router = express.Router();
const gameService = require('../services/gameService');
const { gameSchemas } = require('../validation/schemas');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../config/logger');

// Get current/active game for user
router.get('/active', authenticateToken, async (req, res) => {
  try {
    const game = await gameService.getUserActiveGame(req.user.id);
    res.json({ success: true, game });
  } catch (err) {
    logger.error('Get active game error:', err);
    res.status(500).json({ success: false, message: 'Failed to get active game' });
  }
});

// Get game by ID
router.get('/:gameId', authenticateToken, async (req, res) => {
  try {
    const game = await gameService.getGameById(req.params.gameId);
    res.json({ success: true, game });
  } catch (err) {
    logger.error('Get game by ID error:', err);
    res.status(500).json({ success: false, message: 'Failed to get game' });
  }
});

// Get game history
router.get('/history/list', authenticateToken, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const result = await gameService.getGameHistory(req.user.id, page, limit);
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('Get game history error:', err);
    res.status(500).json({ success: false, message: 'Failed to get game history' });
  }
});

module.exports = router;
