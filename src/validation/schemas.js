const Joi = require('joi');

const authSchemas = {
  sendOTP: Joi.object({
    phoneNumber: Joi.string()
      .pattern(/^\+?[1-9]\d{1,14}$/)
      .required()
      .messages({
        'string.pattern.base': 'Please provide a valid phone number',
        'any.required': 'Phone number is required'
      })
  }),

  verifyOTP: Joi.object({
    phoneNumber: Joi.string()
      .pattern(/^\+?[1-9]\d{1,14}$/)
      .required(),
    otp: Joi.string()
      .length(6)
      .pattern(/^\d+$/)
      .required()
      .messages({
        'string.length': 'OTP must be 6 digits',
        'string.pattern.base': 'OTP must contain only numbers'
      })
  }),

  updateProfile: Joi.object({
    name: Joi.string().min(2).max(50).optional(),
    email: Joi.string().email().optional()
  })
};

const gameSchemas = {
  joinMatchmaking: Joi.object({
    gameType: Joi.string().valid('CLASSIC_LUDO', 'FAST_LUDO', 'MEMORY').required(),
    maxPlayers: Joi.number().integer().min(2).max(4).required(),
    entryFee: Joi.number().min(0).max(10000).required() // entryFee can be 0 for free games, max 10k
  }),

  rollDice: Joi.object({
    gameId: Joi.string().required()
  }),

  movePiece: Joi.object({
    gameId: Joi.string().required(),
    pieceId: Joi.number().integer().min(0).max(3).required(),
    // Added explicit diceValue, although gameService should manage this
    // It's good for validation, but the server should rely on its own state
    diceValue: Joi.number().integer().min(1).max(6).optional()
  }),

  selectCard: Joi.object({ // Schema for Memory Game
    gameId: Joi.string().required(),
    position: Joi.number().integer().min(0).required()
  })
};

const walletSchemas = {
  deposit: Joi.object({
    amount: Joi.number().positive().min(10).max(50000).required()
  }),

  withdraw: Joi.object({
    amount: Joi.number().positive().min(10).required(),
    bankDetails: Joi.object({
      bankName: Joi.string().required(),
      accountNumber: Joi.string().required(),
      ifscCode: Joi.string().required(),
      accountHolderName: Joi.string().required()
    }).required()
  })
};

module.exports = {
  authSchemas,
  gameSchemas,
  walletSchemas
};