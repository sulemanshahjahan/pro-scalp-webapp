// Test email via Railway API and check for errors
const API_BASE = 'https://pro-scalp-backend-production.up.railway.app';

async function testEmail() {
  console.log('Sending test email via Railway backend...\n');
  
  try {
    const res = await fetch(`${API_BASE}/api/debug/email`);
    const data = await res.json();
    
    console.log('Status:', res.status);
    console.log('Response:', JSON.stringify(data, null, 2));
    
    if (data.ok) {
      console.log('\n✅ Backend says email sent successfully');
      console.log('\n📧 CHECK YOUR INBOX NOW:');
      console.log('   suleman.shahjahan@gmail.com');
      console.log('\n   Also check SPAM folder!');
      console.log('\n⏳ Email should arrive within 30 seconds...');
      
      // Wait and prompt
      console.log('\n   Did you receive the email? (y/n)');
    } else {
      console.log('\n❌ Backend failed to send:', data.error);
      if (data.stack) {
        console.log('\nStack trace:', data.stack);
      }
    }
  } catch (e) {
    console.error('❌ Request failed:', e.message);
  }
}

testEmail();
