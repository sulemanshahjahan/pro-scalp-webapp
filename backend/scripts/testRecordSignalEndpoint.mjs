// Test the record-signal debug endpoint
const API_BASE = 'https://pro-scalp-backend-production.up.railway.app';

async function test() {
  console.log('Testing /api/debug/record-signal...\n');
  
  try {
    const res = await fetch(`${API_BASE}/api/debug/record-signal`);
    const text = await res.text();
    
    console.log('Status:', res.status);
    console.log('Content-Type:', res.headers.get('content-type'));
    
    if (text.startsWith('<')) {
      console.log('\nHTML response (error page):');
      console.log(text.substring(0, 500));
    } else {
      try {
        const json = JSON.parse(text);
        console.log('\nJSON response:');
        console.log(JSON.stringify(json, null, 2));
      } catch {
        console.log('\nText response:');
        console.log(text);
      }
    }
  } catch (e) {
    console.error('Fetch error:', e.message);
  }
}

test();
