const jwt = require('jsonwebtoken');
const prisma = require('../config/database');
const logger = require('../config/logger');
const { sendOtpViaRenflair } = require('../utils/sms');
const fetch = require('node-fetch');


class AuthService {
  constructor() {}

  generateOTP() {
    // For development, use a fixed OTP for testing
    if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
      return '123456'; // Fixed OTP for development
    }
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  async sendOTP(phoneNumber) {
    try {
      // Validate phone number format
      if (!phoneNumber || !phoneNumber.match(/^\+91[6-9]\d{9}$/)) {
        logger.warn(`Invalid phone number format for sendOTP: ${phoneNumber}`);
        throw new Error('Invalid phone number format');
      }

      // Clean up expired OTPs
      await prisma.oTPVerification.deleteMany({
        where: {
          phoneNumber,
          expiresAt: { lt: new Date() }
        }
      });
      logger.debug(`Cleaned up expired OTPs for ${phoneNumber}`);

      // Generate new OTP
      const otp = this.generateOTP();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      // Save OTP to database first
      const otpRecord = await prisma.oTPVerification.create({
        data: {
          phoneNumber,
          otp,
          expiresAt
        }
      });

      logger.info(`OTP record created for ${phoneNumber}: ${otpRecord.id}`);

      // Send OTP via renflair SMS API
      const apiKey = process.env.RENFLAIR_API_KEY;
      
      if (!apiKey) {
        logger.error('RENFLAIR_API_KEY not configured. SMS sending skipped.');
        // Don't throw error here - OTP is saved in DB, user can still verify
        return { 
          success: true, 
          message: 'OTP generated successfully. SMS service is not configured.',
          warning: 'SMS service is currently unavailable or misconfigured'
        };
      }

      let resp;
      try {
        resp = await sendOtpViaRenflair(apiKey, phoneNumber, otp);
      } catch (smsError) {
        logger.error(`Error calling Renflair SMS API for ${phoneNumber}:`, smsError);
        return { 
          success: true, 
          message: 'OTP generated successfully. Failed to send SMS.',
          warning: 'SMS service encountered an error'
        };
      }
      
      if (resp && resp.success) {
        logger.info(`OTP sent successfully to ${phoneNumber}`);
        return { success: true, message: 'OTP sent successfully' };
      } else {
        logger.error(`Failed to send OTP to ${phoneNumber} (Renflair response):`, resp);
        // Don't throw error here - OTP is saved in DB, user can still verify
        return { 
          success: true, 
          message: 'OTP generated successfully. If you don\'t receive SMS, please try again.',
          warning: 'SMS service may be temporarily unavailable'
        };
      }
    } catch (error) {
      logger.error('Send OTP error:', error);
      throw new Error(error.message || 'Failed to send OTP');
    }
  }

  async verifyOTP(phoneNumber, otp) {
    try {
      // Validate inputs
      if (!phoneNumber || !otp) {
        logger.warn('Phone number or OTP missing for verification');
        throw new Error('Phone number and OTP are required');
      }

      if (!phoneNumber.match(/^\+91[6-9]\d{9}$/)) {
        logger.warn(`Invalid phone number format for verifyOTP: ${phoneNumber}`);
        throw new Error('Invalid phone number format');
      }

      if (!otp.match(/^\d{6}$/)) {
        logger.warn(`Invalid OTP format for ${phoneNumber}: ${otp}`);
        throw new Error('OTP must be 6 digits');
      }

      logger.info(`Verifying OTP for ${phoneNumber}`); // Removed OTP from log for security

      // Find the most recent valid OTP
      const otpRecord = await prisma.oTPVerification.findFirst({
        where: {
          phoneNumber,
          otp,
          verified: false,
          expiresAt: { gt: new Date() }
        },
        orderBy: { createdAt: 'desc' } // Crucial: ensure we get the latest unverified OTP
      });

      if (!otpRecord) {
        // Check if OTP exists but is expired or already verified
        const anyOtpRecord = await prisma.oTPVerification.findFirst({
          where: { phoneNumber, otp },
          orderBy: { createdAt: 'desc' }
        });

        if (anyOtpRecord) {
          if (anyOtpRecord.verified) {
            logger.warn(`Attempt to use already verified OTP for ${phoneNumber}`);
            throw new Error('OTP already used');
          } else if (anyOtpRecord.expiresAt < new Date()) {
            logger.warn(`Attempt to use expired OTP for ${phoneNumber}`);
            throw new Error('OTP expired. Please request a new one');
          }
        }
        logger.warn(`Invalid OTP provided for ${phoneNumber}`);
        throw new Error('Invalid OTP');
      }

      logger.info(`Valid OTP found for ${phoneNumber}, creating/updating user`);

      // Mark OTP as verified
      await prisma.oTPVerification.update({
        where: { id: otpRecord.id },
        data: { verified: true }
      });
      logger.debug(`OTP record ${otpRecord.id} marked as verified.`);

      // Find or create user
      let user = await prisma.user.findUnique({
        where: { phoneNumber },
        include: { wallet: true }
      });

      if (!user) {
        logger.info(`Creating new user for ${phoneNumber}`);
        // Create new user with wallet
        user = await prisma.user.create({
          data: {
            phoneNumber,
            isVerified: true,
            // Default name/email can be set here or updated later
            name: `User_${phoneNumber.substring(phoneNumber.length - 4)}`, // Example default name
            wallet: {
              create: {
                balance: 0
              }
            }
          },
          include: { wallet: true }
        });
        logger.info(`New user created: ${user.id}`);
      } else {
        logger.info(`Updating existing user: ${user.id}`);
        // Update verification status if not already verified
        if (!user.isVerified) {
          user = await prisma.user.update({
            where: { id: user.id },
            data: { isVerified: true },
            include: { wallet: true }
          });
        }
      }

      // Validate JWT configuration
      if (!process.env.JWT_SECRET) {
        logger.error('JWT_SECRET not configured. Authentication service cannot generate tokens.');
        throw new Error('Authentication service not configured');
      }

      // Generate JWT token
      const token = jwt.sign(
        { userId: user.id, phoneNumber: user.phoneNumber },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
      );

      logger.info(`Authentication successful and token generated for user: ${user.id}`);

      return {
        success: true,
        token,
        user: {
          id: user.id,
          phoneNumber: user.phoneNumber,
          name: user.name,
          email: user.email,
          avatar: user.avatar,
          isVerified: user.isVerified,
          wallet: user.wallet
        }
      };
    } catch (error) {
      logger.error('Verify OTP error:', error);
      throw error; // Re-throw for higher-level error handling
    }
  }

  async updateProfile(userId, profileData) {
    try {
      logger.info(`Updating profile for user ${userId}`);
      const user = await prisma.user.update({
        where: { id: userId },
        data: profileData,
        include: { wallet: true }
      });
      logger.info(`Profile updated for user ${userId}`);
      return {
        success: true,
        user: {
          id: user.id,
          phoneNumber: user.phoneNumber,
          name: user.name,
          email: user.email,
          avatar: user.avatar,
          wallet: user.wallet
        }
      };
    } catch (error) {
      logger.error(`Update profile error for user ${userId}:`, error);
      throw new Error('Failed to update profile');
    }
  }
}

module.exports = new AuthService();
