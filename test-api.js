const fetch = require('node-fetch');

const API_BASE = 'https://test.fivlog.space/api';
const TEST_PHONE = '+919133263911';

async function testAPI() {
  console.log('🧪 Testing Budzee API...\n');

  try {
    // Test 1: Health check
    console.log('1. Testing health endpoint...');
    const healthResponse = await fetch('https://test.fivlog.space/health');
    const healthData = await healthResponse.json();
    console.log('✅ Health check:', healthData);

    // Test 2: Send OTP
    console.log('\n2. Testing send OTP...');
    const otpResponse = await fetch(`${API_BASE}/auth/send-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber: TEST_PHONE })
    });
    
    const otpData = await otpResponse.json();
    console.log('✅ Send OTP response:', otpData);

    if (otpData.success) {
      // Test 3: Verify OTP (using development OTP: 123456)
      console.log('\n3. Testing verify OTP...');
      const verifyResponse = await fetch(`${API_BASE}/auth/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          phoneNumber: TEST_PHONE, 
          otp: '123456' // Development OTP
        })
      });
      
      const verifyData = await verifyResponse.json();
      console.log('✅ Verify OTP response:', verifyData);

      if (verifyData.success) {
        // Test 4: Get profile
        console.log('\n4. Testing get profile...');
        const profileResponse = await fetch(`${API_BASE}/auth/profile`, {
          headers: { 'Authorization': `Bearer ${verifyData.token}` }
        });
        
        const profileData = await profileResponse.json();
        console.log('✅ Profile response:', profileData);
      }
    }

    console.log('\n🎉 All tests completed!');
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

// Run tests
testAPI();