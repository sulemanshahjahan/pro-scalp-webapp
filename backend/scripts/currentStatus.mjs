#!/usr/bin/env node
const API = 'https://pro-scalp-backend-production.up.railway.app';

async function fetchJson(path) {
  const res = await fetch(`${API}${path}`);
  return res.json();
}

async function main() {
  console.log('📊 CURRENT STATUS (Last 24 Hours)');
  console.log('==================================\n');
  
  // Get recent signals
  const signals = await fetchJson('/api/signals?hours=24&limit=100');
  const recentSignals = signals.rows || [];
  
  console.log(`📡 Total Signals (24h): ${recentSignals.length}`);
  
  const byCat = {};
  for (const s of recentSignals) {
    byCat[s.category] = (byCat[s.category] || 0) + 1;
  }
  for (const [cat, count] of Object.entries(byCat).sort((a,b) => b[1] - a[1])) {
    console.log(`   ${cat}: ${count}`);
  }
  
  // Show last 5 signals with details
  console.log('\n🕐 Last 5 Signals:');
  console.log('------------------');
  for (const s of recentSignals.slice(0, 5)) {
    const time = new Date(Number(s.time)).toISOString().replace('T', ' ').slice(0, 19);
    const price = s.price?.toFixed(6) || 'N/A';
    const vwap = s.deltaVwapPct?.toFixed(2) || 'N/A';
    const rsi = s.rsi9?.toFixed(1) || 'N/A';
    console.log(`${time} UTC | ${s.symbol} | ${s.category} | $${price} | VWAP:${vwap}% | RSI:${rsi}`);
  }
  
  // Get outcomes by horizon
  console.log('\n📈 Outcome Summary (24h):');
  console.log('-------------------------');
  
  const horizons = [15, 30, 60, 120, 240];
  for (const h of horizons) {
    const outcomes = await fetchJson(`/api/outcomes?hours=24&horizonMin=${h}&source=signals&limit=1000`);
    const rows = outcomes.rows || [];
    const completed = rows.filter(r => r.outcomeState === 'COMPLETE' && r.result !== 'NONE');
    
    if (completed.length === 0) {
      console.log(`${h}m: No completed outcomes`);
      continue;
    }
    
    const win = completed.filter(r => r.result === 'WIN').length;
    const loss = completed.filter(r => r.result === 'LOSS').length;
    const flat = completed.filter(r => r.result === 'FLAT').length;
    const netR = completed.reduce((sum, r) => sum + (r.rClose || 0), 0);
    
    const winRate = (win / completed.length * 100).toFixed(0);
    const stopRate = (loss / completed.length * 100).toFixed(0);
    
    console.log(`${h}m: ${win}/${completed.length} wins (${winRate}%) | ${loss} stops (${stopRate}%) | Net: ${netR >= 0 ? '+' : ''}${netR.toFixed(2)}R`);
  }
  
  // Market conditions
  console.log('\n🌍 Current Market Conditions:');
  console.log('-----------------------------');
  try {
    const market = await fetchJson('/api/market/btc');
    console.log(`BTC 15m: $${market.close15m?.toFixed(2) || 'N/A'}`);
    console.log(`BTC Regime: ${market.regime || 'N/A'}`);
    console.log(`BTC Trend: ${market.trend15m || 'N/A'}`);
  } catch {
    console.log('Market data unavailable');
  }
  
  // Last scan info
  console.log('\n🔄 Last Scan:');
  console.log('-------------');
  try {
    const scans = await fetchJson('/api/scan-runs?hours=1&limit=1');
    if (scans.length > 0) {
      const scan = scans[0];
      const scanTime = new Date(scan.startedAt).toISOString().replace('T', ' ').slice(0, 19);
      console.log(`Time: ${scanTime} UTC`);
      console.log(`Symbols: ${scan.processedSymbols} | Precheck Passed: ${scan.precheckPassed}`);
      console.log(`Signals: WATCH:${scan.signalsByCategory?.WATCH || 0} | EARLY:${scan.signalsByCategory?.EARLY_READY || 0} | READY:${scan.signalsByCategory?.READY_TO_BUY || 0} | BEST:${scan.signalsByCategory?.BEST_ENTRY || 0}`);
      console.log(`Ready Candidates: ${scan.gateStats?.readyCandidates || 0}`);
    } else {
      console.log('No recent scans');
    }
  } catch {
    console.log('Scan data unavailable');
  }
}

main().catch(console.error);
