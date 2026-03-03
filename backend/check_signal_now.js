// Run in browser console
const signalId = 3095; // BNB signal

fetch(`https://pro-scalp-backend-production.up.railway.app/api/debug/delayed-entry/${signalId}`)
  .then(r => r.json())
  .then(d => {
    console.log('=== DELAYED ENTRY ===');
    console.log('Status:', d.record?.status);
    console.log('Confirmed Price:', d.record?.confirmedPrice);
    console.log('Confirmed TP2:', d.record?.confirmedTp2Price);
    
    console.log('\n=== EXTENDED OUTCOME ===');
    console.log('Status:', d.extendedOutcome?.status);
    console.log('Entry:', d.extendedOutcome?.entryPrice);
    console.log('TP2:', d.extendedOutcome?.tp2Price);
    
    // Check if it should have hit TP2
    const currentPrice = 646.26; // From your chart
    const tp2Price = d.record?.confirmedTp2Price || d.extendedOutcome?.tp2Price;
    console.log('\n=== ANALYSIS ===');
    console.log('Current Price:', currentPrice);
    console.log('TP2 Level:', tp2Price);
    console.log('Should be WIN_TP2:', currentPrice >= tp2Price ? 'YES!' : 'NO');
  });
