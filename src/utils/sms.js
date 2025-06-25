const fetch = require('node-fetch');

// Send OTP via renflair.in SMS API
async function sendOtpViaRenflair(apiKey, phone, otp) {
  const url = `https://sms.renflair.in/V1.php?API=${apiKey}&PHONE=${phone}&OTP=${otp}`;
  try {
    const response = await fetch(url);
    const data = await response.json();
    return data;
  } catch (error) {
    return { success: false, message: error.message };
  }
}

module.exports = { sendOtpViaRenflair };
