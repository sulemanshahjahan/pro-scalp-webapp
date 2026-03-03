// Run this in browser console to check BNB signal details
fetch('https://pro-scalp-backend-production.up.railway.app/api/debug/delayed-entry/3095')
  .then(r => r.json())
  .then(data => {
    console.log('BNB Signal Status:', data.record?.status);
    console.log('Reference Price:', data.record?.referencePrice);
    console.log('Target Confirm:', data.record?.targetConfirmPrice);
    console.log('Confirmed Price:', data.record?.confirmedPrice);
    console.log('Confirmed Stop:', data.record?.confirmedStopPrice);
    console.log('Confirmed TP1:', data.record?.confirmedTp1Price);
    console.log('Confirmed TP2:', data.record?.confirmedTp2Price);
  });
