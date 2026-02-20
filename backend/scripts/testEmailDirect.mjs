// Direct email test with full error logging
import nodemailer from 'nodemailer';

const config = {
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: 'suleman.shahjahan@gmail.com',
    pass: 'otzagqsxduazvvhi', // NEW App password
  },
};

const transporter = nodemailer.createTransport(config);

async function testEmail() {
  console.log('Testing direct SMTP connection to Gmail...\n');
  console.log('Config:', { host: config.host, port: config.port, user: config.auth.user });
  
  try {
    // Verify connection
    console.log('\n1. Verifying SMTP connection...');
    await transporter.verify();
    console.log('✅ SMTP connection verified');
    
    // Send test email
    console.log('\n2. Sending test email...');
    const info = await transporter.sendMail({
      from: '"Pro Scalp Scanner" <suleman.shahjahan@gmail.com>',
      to: 'suleman.shahjahan@gmail.com',
      subject: '🧪 TEST: READY_TO_BUY Signal - BTCUSDT @ 43250.00',
      text: `Pro Scalp Scanner - Ready to BUY

Symbol: BTCUSDT
Price: 43250.00
TF: 5m
RSI-9: 62.5
VWAP Dist %: 0.25%
EMA200: 43100.00
When: ${new Date().toISOString()}

---
⏱️ Hold 2-4h for optimal R (data: 37-44% win rate at 2-4h vs 7% at 15m)
(Hold 2-4h for optimal R: 37-44% vs 7%)

This is a TEST email from your Pro Scalp Scanner.`,
      html: `
        <div style="font-family:Inter,Segoe UI,Arial,sans-serif;max-width:560px;margin:auto;border:1px solid #eee;border-radius:12px;overflow:hidden">
          <div style="background:#111;color:#fff;padding:14px 16px;font-size:16px"><strong>Pro Scalp Scanner</strong></div>
          <div style="padding:16px">
            <h2 style="margin:0 0 8px 0;font-size:18px">Ready to BUY: BTCUSDT</h2>
            <p style="margin:0 0 12px 0;color:#333">Triggered at <b>43250.00</b>. This email is informational, not financial advice.</p>
            
            <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:12px;margin:12px 0;font-size:13px;color:#166534">
              <strong>⏱️ Hold 2-4h for optimal R (data: 37-44% win rate at 2-4h vs 7% at 15m)</strong>
            </div>
            
            <table style="border-collapse:collapse;width:100%;font-size:14px">
              <tr><td style="padding:6px 10px;color:#666;">Symbol</td><td style="padding:6px 10px;font-weight:600;color:#111;">BTCUSDT</td></tr>
              <tr><td style="padding:6px 10px;color:#666;">Category</td><td style="padding:6px 10px;font-weight:600;color:#111;">Ready to BUY</td></tr>
              <tr><td style="padding:6px 10px;color:#666;">Price</td><td style="padding:6px 10px;font-weight:600;color:#111;">43250.00</td></tr>
              <tr><td style="padding:6px 10px;color:#666;">Timeframe</td><td style="padding:6px 10px;font-weight:600;color:#111;">5m</td></tr>
              <tr><td style="padding:6px 10px;color:#666;">RSI-9</td><td style="padding:6px 10px;font-weight:600;color:#111;">62.50</td></tr>
              <tr><td style="padding:6px 10px;color:#666;">VWAP Dist %</td><td style="padding:6px 10px;font-weight:600;color:#111;">0.25%</td></tr>
              <tr><td style="padding:6px 10px;color:#666;">EMA200</td><td style="padding:6px 10px;font-weight:600;color:#111;">43100.00</td></tr>
            </table>
            
            <p style="margin-top:16px;color:#666;font-size:12px">
              🧪 <strong>TEST EMAIL</strong> - This is a test from your Pro Scalp Scanner
            </p>
          </div>
          <div style="background:#fafafa;color:#888;padding:10px 16px;font-size:12px">You are receiving this because you enabled email alerts.</div>
        </div>
      `
    });
    
    console.log('✅ Email sent successfully!');
    console.log('Message ID:', info.messageId);
    console.log('\n📧 Check your inbox (and spam folder) at: suleman.shahjahan@gmail.com');
    
  } catch (error) {
    console.error('❌ Email failed:', error.message);
    if (error.code) console.error('Error code:', error.code);
    if (error.response) console.error('Server response:', error.response);
    console.error('\n💡 Common fixes:');
    console.error('1. Gmail app password may be expired - create new one at myaccount.google.com/apppasswords');
    console.error('2. Less secure app access needs to be enabled');
    console.error('3. Try a different SMTP provider like SendGrid');
  }
}

testEmail();
