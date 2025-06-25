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
    gameType: Joi.string().valid('LUDO').default('LUDO'),
    maxPlayers: Joi.number().valid(2, 4).required(),
    entryFee: Joi.number().positive().required()
  }),

  movePiece: Joi.object({
    gameId: Joi.string().required(),
    pieceId: Joi.number().integer().min(0).max(3).required()
  })
};

const walletSchemas = {
  deposit: Joi.object({
    amount: Joi.number().positive().min(10).max(50000).required()
  }),

  withdraw: Joi.object({
    amount: Joi.number().positive().min(10).required()
  })
};

module.exports = {
  authSchemas,
  gameSchemas,
  walletSchemas
};