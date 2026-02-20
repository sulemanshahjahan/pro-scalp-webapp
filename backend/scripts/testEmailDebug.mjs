// Test email debug endpoint
const API_BASE = 'https://pro-scalp-backend-production.up.railway.app';

async function testEmail() {
  console.log('Testing email configuration...\n');
  
  try {
    const res = await fetch(`${API_BASE}/api/debug/email`);
    const data = await res.json();
    
    console.log('Status:', res.status);
    console.log('Response:', JSON.stringify(data, null, 2));
    
    if (!data.ok) {
      console.log('\n❌ EMAIL NOT WORKING');
      if (data.config) {
        console.log('\nCurrent config:');
        console.log('  EMAIL_ENABLED:', data.config.enabled);
        console.log('  SMTP_HOST:', data.config.smtpHost);
        console.log('  SMTP_PORT:', data.config.smtpPort);
        console.log('  SMTP_USER:', data.config.smtpUser);
        console.log('  SMTP_PASS set:', data.config.smtpPassSet);
        console.log('  ALERT_EMAILS:', data.config.alertEmails);
        console.log('  isEmailEnabled():', data.config.isEnabled);
      }
      if (data.hint) {
        console.log('\n💡 Hint:', data.hint);
      }
    } else {
      console.log('\n✅ Email sent! Check your inbox.');
    }
  } catch (e) {
    console.error('Error:', e.message);
  }
}

testEmail();
