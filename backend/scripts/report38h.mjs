#!/usr/bin/env node
const API = 'https://pro-scalp-backend-production.up.railway.app';

async function fetchOutcomes(horizonMin) {
  const url = `${API}/api/outcomes?days=2&horizonMin=${horizonMin}&source=signals&limit=1000`;
  const res = await fetch(url);
  return res.json();
}

async function fetchSignals() {
  const url = `${API}/api/signals?days=2&limit=1000`;
  const res = await fetch(url);
  return res.json();
}

async function main() {
  console.log('📊 38-Hour Performance Report');
  console.log('=============================');
  console.log('Filters: READY_VWAP_MAX_PCT=0.50, READY_UPPER_WICK_MAX=0.50, READY_BODY_MIN_PCT=0.004');
  console.log('         RSI_READY_MAX=80, OUTCOME_EXPIRE_AFTER_15M=false');
  console.log('');
  
  // Get signals
  const signalsData = await fetchSignals();
  const signals = signalsData.rows || [];
  console.log(`📡 Signals Generated: ${signals.length}`);
  
  const byCategory = {};
  for (const s of signals) {
    byCategory[s.category] = (byCategory[s.category] || 0) + 1;
  }
  for (const [cat, count] of Object.entries(byCategory)) {
    console.log(`   ${cat}: ${count}`);
  }
  console.log('');
  
  const horizons = [15, 30, 60, 120, 240];
  const results = {};
  
  for (const h of horizons) {
    const data = await fetchOutcomes(h);
    const rows = data.rows || [];
    
    // Only count completed outcomes
    const completed = rows.filter(r => r.outcomeState === 'COMPLETE' && r.result !== 'NONE');
    
    const win = completed.filter(r => r.result === 'WIN').length;
    const loss = completed.filter(r => r.result === 'LOSS').length;
    const flat = completed.filter(r => r.result === 'FLAT').length;
    const total = completed.length;
    
    const netR = completed.reduce((sum, r) => sum + (r.rClose || 0), 0);
    const avgR = total > 0 ? netR / total : 0;
    
    const avgMfe = total > 0 ? completed.reduce((sum, r) => sum + (r.mfePct || 0), 0) / total : 0;
    const avgMae = total > 0 ? completed.reduce((sum, r) => sum + (r.maePct || 0), 0) / total : 0;
    
    results[h] = { total, win, loss, flat, netR, avgR, avgMfe, avgMae };
  }
  
  console.log('📈 Outcome Performance by Horizon');
  console.log('==================================');
  
  for (const h of horizons) {
    const r = results[h];
    if (r.total === 0) {
      console.log(`${h}m: No completed outcomes yet`);
      continue;
    }
    
    const winRate = (r.win / r.total * 100).toFixed(1);
    const stopRate = (r.loss / r.total * 100).toFixed(1);
    const flatRate = (r.flat / r.total * 100).toFixed(1);
    
    console.log(`${h}m Horizon (${r.total} completed):`);
    console.log(`  Win Rate: ${winRate}% (${r.win}/${r.total})`);
    console.log(`  Stop Rate: ${stopRate}% (${r.loss}/${r.total})`);
    console.log(`  Flat Rate: ${flatRate}% (${r.flat}/${r.total})`);
    console.log(`  Net R: ${r.netR >= 0 ? '+' : ''}${r.netR.toFixed(2)}R`);
    console.log(`  Avg R: ${r.avgR >= 0 ? '+' : ''}${r.avgR.toFixed(2)}R`);
    console.log(`  Avg Max Up: +${(r.avgMfe * 100).toFixed(2)}%`);
    console.log(`  Avg Max Down: ${(r.avgMae * 100).toFixed(2)}%`);
    console.log('');
  }
  
  // Best horizon analysis
  console.log('🎯 Best Performing Horizon');
  console.log('===========================');
  const validResults = Object.entries(results)
    .filter(([_, r]) => r.total >= 3)
    .sort((a, b) => b[1].avgR - a[1].avgR);
  
  if (validResults.length > 0) {
    const [bestH, bestR] = validResults[0];
    console.log(`${bestH}m has best avg R: ${bestR.avgR >= 0 ? '+' : ''}${bestR.avgR.toFixed(2)}R (${bestR.win}/${bestR.total} wins)`);
  }
  
  // Summary
  console.log('');
  console.log('📊 OVERALL SUMMARY');
  console.log('==================');
  const allCompleted = Object.values(results).reduce((sum, r) => sum + r.total, 0);
  const allWin = Object.values(results).reduce((sum, r) => sum + r.win, 0);
  const allLoss = Object.values(results).reduce((sum, r) => sum + r.loss, 0);
  const allFlat = Object.values(results).reduce((sum, r) => sum + r.flat, 0);
  const allNetR = Object.values(results).reduce((sum, r) => sum + r.netR, 0);
  
  if (allCompleted > 0) {
    console.log(`Total Outcomes: ${allCompleted} (${signals.length} signals × 5 horizons)`);
    console.log(`Overall Win Rate: ${(allWin/allCompleted*100).toFixed(1)}%`);
    console.log(`Overall Stop Rate: ${(allLoss/allCompleted*100).toFixed(1)}%`);
    console.log(`Overall Flat Rate: ${(allFlat/allCompleted*100).toFixed(1)}%`);
    console.log(`Total Net R: ${allNetR >= 0 ? '+' : ''}${allNetR.toFixed(2)}R`);
    console.log(`Avg R per outcome: ${(allNetR/allCompleted).toFixed(2)}R`);
  }
}

main().catch(console.error);
