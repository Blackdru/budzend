const fetch = require('node-fetch');

// Send OTP via renflair.in SMS API
async function sendOtpViaRenflair(apiKey, phone, otp) {
  // Clean phone number - remove +91 prefix for API
  const cleanPhone = phone.replace('+91', '');
  
  const url = `https://sms.renflair.in/V1.php?API=${apiKey}&PHONE=${cleanPhone}&OTP=${otp}`;
  
  try {
    console.log('Sending OTP to:', cleanPhone, 'with OTP:', otp);
    console.log('SMS API URL:', url);
    
    const response = await fetch(url, {
      method: 'GET',
      timeout: 10000, // 10 second timeout
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const textResponse = await response.text();
    console.log('SMS API Response:', textResponse);
    
    // Try to parse as JSON, if it fails, treat as success if response contains success indicators
    try {
      const data = JSON.parse(textResponse);
      return data;
    } catch (parseError) {
      // If response contains success indicators, treat as success
      if (textResponse.toLowerCase().includes('success') || 
          textResponse.toLowerCase().includes('sent') ||
          textResponse.includes('200')) {
        return { success: true, message: 'OTP sent successfully', response: textResponse };
      } else {
        return { success: false, message: textResponse || 'Failed to send OTP' };
      }
    }
  } catch (error) {
    console.error('SMS API Error:', error);
    return { success: false, message: error.message };
  }
}

module.exports = { sendOtpViaRenflair };
