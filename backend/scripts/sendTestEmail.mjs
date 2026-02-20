// Send test email for READY_TO_BUY
// Usage: node sendTestEmail.mjs

const API_BASE = process.env.API_BASE || 'https://pro-scalp-backend-production.up.railway.app';

async function sendTestEmail() {
  try {
    console.log('Sending test email for READY_TO_BUY...');
    console.log(`API: ${API_BASE}/api/debug/email`);
    
    const response = await fetch(`${API_BASE}/api/debug/email`);
    const data = await response.json();
    
    if (data.ok) {
      console.log('✅ Test email sent successfully!');
      console.log('Signal:', data.sent);
    } else {
      console.error('❌ Failed:', data.error);
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.log('\nMake sure your backend is running and accessible.');
  }
}

// Also create a direct test via emailNotify if running locally
async function sendDirectTest() {
  console.log('\n--- DIRECT TEST (if running in backend context) ---');
  
  try {
    // Dynamic import for ES module
    const { emailNotify } = await import('../src/emailNotifier.js');
    
    const testSignal = {
      symbol: 'BTCUSDT',
      category: 'READY_TO_BUY',
      price: 43250.00,
      rsi9: 62.5,
      vwapDistancePct: 0.25,
      ema200: 43100.00,
      volume: 150000000,
      chartUrl: 'https://www.tradingview.com/chart/?symbol=BINANCE:BTCUSDT'
    };
    
    console.log('Sending READY_TO_BUY test email...');
    await emailNotify(undefined, testSignal);
    console.log('✅ Test email sent!');
    
  } catch (e) {
    console.log('Direct test skipped (not in backend context)');
    console.log('Use the API endpoint instead.');
  }
}

// Run API test
await sendTestEmail();

// Try direct test
await sendDirectTest();
