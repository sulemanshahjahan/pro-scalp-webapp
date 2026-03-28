/**
 * Signal & Outcome Analysis Tool
 * 
 * Run: node research/analyzeSignals.js
 * 
 * This script analyzes all signals and outcomes to find patterns
 * in winners vs losers, optimal trading conditions, and gate effectiveness.
 */

const { getDb } = require('../backend/dist/src/db/db.js');

async function analyze() {
  console.log('\n🔍 SIGNAL & OUTCOME RESEARCH ANALYSIS\n');
  console.log('=' .repeat(70));
  
  const d = getDb();
  
  // ==========================================================================
  // SECTION 1: OVERALL STATISTICS
  // ==========================================================================
  console.log('\n📊 SECTION 1: OVERALL STATISTICS\n');
  
  const statusDist = d.prepare(`
    SELECT status, COUNT(*) as count
    FROM extended_outcomes
    GROUP BY status
    ORDER BY count DESC
  `).all();
  
  console.log('Status Distribution:');
  statusDist.forEach(row => {
    console.log(`  ${row.status}: ${row.count}`);
  });
  
  const performance = d.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN ext24_managed_r > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN ext24_managed_r < 0 THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN ext24_managed_r = 0 THEN 1 ELSE 0 END) as be,
      ROUND(AVG(ext24_managed_r), 3) as avg_r,
      ROUND(SUM(ext24_managed_r), 3) as total_r
    FROM extended_outcomes
    WHERE completed_at IS NOT NULL
  `).get();
  
  console.log('\nPerformance Summary:');
  console.log(`  Total Completed: ${performance.total}`);
  console.log(`  Wins: ${performance.wins}, Losses: ${performance.losses}, BE: ${performance.be}`);
  console.log(`  Win Rate: ${(performance.wins / (performance.wins + performance.losses) * 100).toFixed(1)}%`);
  console.log(`  Average R: ${performance.avg_r}`);
  console.log(`  Total R: ${performance.total_r}`);
  
  // ==========================================================================
  // SECTION 2: SYMBOL PERFORMANCE
  // ==========================================================================
  console.log('\n📈 SECTION 2: SYMBOL PERFORMANCE (min 2 trades)\n');
  
  const symbolPerf = d.prepare(`
    SELECT 
      symbol,
      COUNT(*) as trades,
      SUM(CASE WHEN ext24_managed_r > 0 THEN 1 ELSE 0 END) as wins,
      ROUND(AVG(ext24_managed_r), 3) as avg_r,
      ROUND(SUM(ext24_managed_r), 3) as total_r,
      ROUND(AVG(max_favorable_excursion_pct), 2) as avg_mfe,
      ROUND(AVG(max_adverse_excursion_pct), 2) as avg_mae
    FROM extended_outcomes
    WHERE completed_at IS NOT NULL
    GROUP BY symbol
    HAVING COUNT(*) >= 2
    ORDER BY total_r DESC
  `).all();
  
  console.log('Top Performers:');
  symbolPerf.slice(0, 5).forEach(s => {
    const wr = (s.wins / s.trades * 100).toFixed(0);
    console.log(`  ${s.symbol}: ${s.total_r}R total (${s.avg_r}R avg, ${wr}% WR, ${s.trades} trades)`);
  });
  
  console.log('\nWorst Performers:');
  symbolPerf.slice(-5).reverse().forEach(s => {
    const wr = (s.wins / s.trades * 100).toFixed(0);
    console.log(`  ${s.symbol}: ${s.total_r}R total (${s.avg_r}R avg, ${wr}% WR, ${s.trades} trades)`);
  });
  
  // ==========================================================================
  // SECTION 3: CATEGORY PERFORMANCE
  // ==========================================================================
  console.log('\n📉 SECTION 3: CATEGORY PERFORMANCE\n');
  
  const catPerf = d.prepare(`
    SELECT 
      category,
      COUNT(*) as trades,
      SUM(CASE WHEN ext24_managed_r > 0 THEN 1 ELSE 0 END) as wins,
      ROUND(AVG(ext24_managed_r), 3) as avg_r,
      ROUND(SUM(ext24_managed_r), 3) as total_r
    FROM extended_outcomes
    WHERE completed_at IS NOT NULL
    GROUP BY category
    ORDER BY total_r DESC
  `).all();
  
  catPerf.forEach(c => {
    const wr = (c.wins / c.trades * 100).toFixed(0);
    console.log(`  ${c.category}: ${c.total_r}R (${c.avg_r}R avg, ${wr}% WR, ${c.trades} trades)`);
  });
  
  // ==========================================================================
  // SECTION 4: TIMING ANALYSIS
  // ==========================================================================
  console.log('\n⏰ SECTION 4: TIMING ANALYSIS\n');
  
  const hourPerf = d.prepare(`
    SELECT 
      CAST(signal_time / 1000 / 3600 % 24 AS INTEGER) as hour,
      COUNT(*) as trades,
      SUM(CASE WHEN ext24_managed_r > 0 THEN 1 ELSE 0 END) as wins,
      ROUND(AVG(ext24_managed_r), 3) as avg_r
    FROM extended_outcomes
    WHERE completed_at IS NOT NULL
    GROUP BY hour
    ORDER BY avg_r DESC
  `).all();
  
  console.log('Best Hours (UTC):');
  hourPerf.slice(0, 5).forEach(h => {
    const wr = h.trades > 0 ? (h.wins / h.trades * 100).toFixed(0) : 0;
    console.log(`  ${h.hour}:00 - ${h.avg_r}R avg, ${wr}% WR (${h.trades} trades)`);
  });
  
  console.log('\nWorst Hours (UTC):');
  hourPerf.slice(-3).forEach(h => {
    const wr = h.trades > 0 ? (h.wins / h.trades * 100).toFixed(0) : 0;
    console.log(`  ${h.hour}:00 - ${h.avg_r}R avg, ${wr}% WR (${h.trades} trades)`);
  });
  
  // ==========================================================================
  // SECTION 5: WIDER STOPS IMPACT
  // ==========================================================================
  console.log('\n🛑 SECTION 5: WIDER STOPS IMPACT\n');
  
  const widerStopAnalysis = d.prepare(`
    SELECT 
      COUNT(*) as total_losses,
      SUM(CASE 
        WHEN max_adverse_excursion_pct < ABS((entry_price - stop_price) / entry_price * 100) * 1.4 
        THEN 1 ELSE 0 
      END) as would_survive_1_4x,
      AVG(ABS((entry_price - stop_price) / entry_price * 100)) as avg_stop_distance,
      AVG(max_adverse_excursion_pct) as avg_mae
    FROM extended_outcomes
    WHERE status = 'LOSS_STOP'
      AND completed_at IS NOT NULL
  `).get();
  
  const saved = widerStopAnalysis.would_survive_1_4x;
  const total = widerStopAnalysis.total_losses;
  const pct = total > 0 ? (saved / total * 100).toFixed(1) : 0;
  
  console.log(`Total Losses: ${total}`);
  console.log(`Would Survive 1.4x Wider Stop: ${saved} (${pct}%)`);
  console.log(`Average Stop Distance: ${widerStopAnalysis.avg_stop_distance.toFixed(2)}%`);
  console.log(`Average MAE: ${widerStopAnalysis.avg_mae.toFixed(2)}%`);
  
  // ==========================================================================
  // SECTION 6: MFE/MAE PATTERNS
  // ==========================================================================
  console.log('\n📊 SECTION 6: MFE/MAE PATTERNS\n');
  
  const mfeMae = d.prepare(`
    SELECT 
      CASE 
        WHEN status IN ('WIN_TP1', 'WIN_TP2') THEN 'WIN'
        WHEN status = 'LOSS_STOP' THEN 'LOSS'
        ELSE 'OTHER'
      END as outcome,
      COUNT(*) as count,
      ROUND(AVG(max_favorable_excursion_pct), 2) as avg_mfe,
      ROUND(AVG(max_adverse_excursion_pct), 2) as avg_mae
    FROM extended_outcomes
    WHERE completed_at IS NOT NULL
    GROUP BY outcome
  `).all();
  
  mfeMae.forEach(m => {
    console.log(`  ${m.outcome}: MFE ${m.avg_mfe}%, MAE ${m.avg_mae}% (${m.count} trades)`);
  });
  
  // ==========================================================================
  // SECTION 7: RECENT SIGNALS CHECK
  // ==========================================================================
  console.log('\n🔍 SECTION 7: RECENT SIGNALS (Last 10)\n');
  
  const recent = d.prepare(`
    SELECT 
      symbol,
      category,
      datetime(signal_time / 1000, 'unixepoch') as time,
      status,
      ext24_managed_r
    FROM extended_outcomes
    ORDER BY signal_time DESC
    LIMIT 10
  `).all();
  
  recent.forEach(r => {
    const rStr = r.ext24_managed_r !== null ? `${r.ext24_managed_r}R` : 'pending';
    console.log(`  ${r.time} ${r.symbol} ${r.category}: ${r.status} (${rStr})`);
  });
  
  // ==========================================================================
  // RECOMMENDATIONS
  // ==========================================================================
  console.log('\n💡 RECOMMENDATIONS\n');
  
  // Find best and worst symbols
  const best = symbolPerf[0];
  const worst = symbolPerf[symbolPerf.length - 1];
  
  if (best && worst) {
    console.log(`1. Trade MORE ${best.symbol} (avg ${best.avg_r}R)`);
    console.log(`2. Trade LESS ${worst.symbol} (avg ${worst.avg_r}R)`);
  }
  
  console.log(`3. Wider stops would save ${saved}/${total} losses (${pct}%)`);
  
  const bestHour = hourPerf[0];
  if (bestHour) {
    console.log(`4. Best trading hour: ${bestHour.hour}:00 UTC (${bestHour.avg_r}R avg)`);
  }
  
  console.log('\n' + '='.repeat(70));
  console.log('Analysis Complete\n');
}

analyze().catch(console.error);
