const express = require('express');
const router = express.Router();
const matchmakingService = require('../services/matchmakingService');
const { gameSchemas } = require('../validation/schemas');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../config/logger');

// Join matchmaking queue
router.post('/join', authenticateToken, async (req, res) => {
  try {
    const { error, value } = gameSchemas.joinMatchmaking.validate(req.body);
    if (error) {
      return res.status(400).json({ success: false, message: error.details[0].message });
    }
    const { gameType, maxPlayers, entryFee } = value;
    const result = await matchmakingService.joinQueue(req.user.id, gameType, maxPlayers, entryFee);
    res.json(result);
  } catch (err) {
    logger.error('Join matchmaking queue error:', err);
    res.status(400).json({ success: false, message: err.message });
  }
});

// Leave matchmaking queue
router.post('/leave', authenticateToken, async (req, res) => {
  try {
    const result = await matchmakingService.leaveQueue(req.user.id);
    res.json(result);
  } catch (err) {
    logger.error('Leave matchmaking queue error:', err);
    res.status(400).json({ success: false, message: err.message });
  }
});

// Get queue status
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const result = await matchmakingService.getQueueStatus(req.user.id);
    res.json(result);
  } catch (err) {
    logger.error('Get queue status error:', err);
    res.status(500).json({ success: false, message: 'Failed to get queue status' });
  }
});

module.exports = router;
