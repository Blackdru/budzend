const jwt = require('jsonwebtoken');
const prisma = require('../config/database');
const logger = require('../config/logger');
const { sendOtpViaRenflair } = require('../utils/sms');
const fetch = require('node-fetch');


class AuthService {
  constructor() {}

  generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  async sendOTP(phoneNumber) {
    try {
      // Clean up expired OTPs
      await prisma.oTPVerification.deleteMany({
        where: {
          phoneNumber,
          expiresAt: { lt: new Date() }
        }
      });

      // Generate new OTP
      const otp = this.generateOTP();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      // Save OTP to database
      await prisma.oTPVerification.create({
        data: {
          phoneNumber,
          otp,
          expiresAt
        }
      });

      // Send OTP via renflair SMS API
      const apiKey = process.env.RENFLAIR_API_KEY;
      const resp = await sendOtpViaRenflair(apiKey, phoneNumber, otp);
      if (resp && resp.success) {
        logger.info(`OTP sent to ${phoneNumber} via renflair`);
      } else {
        logger.error(`Failed to send OTP to ${phoneNumber} via renflair: ${resp && resp.message}`);
        throw new Error('Failed to send OTP via SMS');
      }

      return { success: true, message: 'OTP sent successfully' };
    } catch (error) {
      logger.error('Send OTP error:', error);
      throw new Error('Failed to send OTP');
    }
  }

  async verifyOTP(phoneNumber, otp) {
    try {
      // Find valid OTP
      const otpRecord = await prisma.oTPVerification.findFirst({
        where: {
          phoneNumber,
          otp,
          verified: false,
          expiresAt: { gt: new Date() }
        }
      });

      if (!otpRecord) {
        throw new Error('Invalid or expired OTP');
      }

      // Mark OTP as verified
      await prisma.oTPVerification.update({
        where: { id: otpRecord.id },
        data: { verified: true }
      });

      // Find or create user
      let user = await prisma.user.findUnique({
        where: { phoneNumber },
        include: { wallet: true }
      });

      if (!user) {
        // Create new user with wallet
        user = await prisma.user.create({
          data: {
            phoneNumber,
            isVerified: true,
            wallet: {
              create: {
                balance: 0
              }
            }
          },
          include: { wallet: true }
        });
      } else {
        // Update verification status
        user = await prisma.user.update({
          where: { id: user.id },
          data: { isVerified: true },
          include: { wallet: true }
        });
      }

      // Generate JWT token
      const token = jwt.sign(
        { userId: user.id, phoneNumber: user.phoneNumber },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN }
      );

      return {
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
      };
    } catch (error) {
      logger.error('Verify OTP error:', error);
      throw error;
    }
  }

  async updateProfile(userId, profileData) {
    try {
      const user = await prisma.user.update({
        where: { id: userId },
        data: profileData,
        include: { wallet: true }
      });

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
      logger.error('Update profile error:', error);
      throw new Error('Failed to update profile');
    }
  }
}

module.exports = new AuthService();