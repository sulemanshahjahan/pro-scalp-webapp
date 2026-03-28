/**
 * Research Analysis API Endpoint
 * Provides signal/outcome analysis directly from the server
 */

import { Router } from 'express';
import { getDb } from './db/db.js';

const router = Router();

router.get('/api/research/analysis', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  try {
    const d = getDb();
    const results: any = {};
    
    // ==========================================================================
    // SECTION 1: OVERALL STATISTICS
    // ==========================================================================
    const statusDist = await d.prepare(`
      SELECT status, COUNT(*) as count
      FROM extended_outcomes
      GROUP BY status
      ORDER BY count DESC
    `).all();
    
    const performance = await d.prepare(`
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
    
    results.overview = {
      statusDistribution: statusDist,
      performance: {
        ...performance,
        winRate: performance.wins / (performance.wins + performance.losses) * 100
      }
    };
    
    // ==========================================================================
    // SECTION 2: SYMBOL PERFORMANCE
    // ==========================================================================
    const symbolPerf = await d.prepare(`
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
    
    results.symbols = {
      best: symbolPerf.slice(0, 5),
      worst: symbolPerf.slice(-5).reverse(),
      all: symbolPerf
    };
    
    // ==========================================================================
    // SECTION 3: CATEGORY PERFORMANCE
    // ==========================================================================
    const catPerf = await d.prepare(`
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
    
    results.categories = catPerf;
    
    // ==========================================================================
    // SECTION 4: TIMING ANALYSIS
    // ==========================================================================
    const hourPerf = await d.prepare(`
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
    
    results.timing = {
      bestHours: hourPerf.slice(0, 5),
      worstHours: hourPerf.slice(-3)
    };
    
    // ==========================================================================
    // SECTION 5: WIDER STOPS IMPACT
    // ==========================================================================
    const widerStopAnalysis = await d.prepare(`
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
    
    results.widerStops = {
      ...widerStopAnalysis,
      survivalRate: widerStopAnalysis.total_losses > 0 
        ? (widerStopAnalysis.would_survive_1_4x / widerStopAnalysis.total_losses * 100).toFixed(1)
        : 0
    };
    
    // ==========================================================================
    // SECTION 6: MFE/MAE PATTERNS
    // ==========================================================================
    const mfeMae = await d.prepare(`
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
    
    results.mfeMae = mfeMae;
    
    // ==========================================================================
    // SECTION 7: RECENT SIGNALS
    // ==========================================================================
    const recent = await d.prepare(`
      SELECT 
        symbol,
        category,
        signal_time,
        status,
        ext24_managed_r
      FROM extended_outcomes
      ORDER BY signal_time DESC
      LIMIT 10
    `).all();
    
    results.recent = recent;
    
    // ==========================================================================
    // RECOMMENDATIONS
    // ==========================================================================
    const recommendations = [];
    
    if (results.symbols.best.length > 0) {
      const best = results.symbols.best[0];
      recommendations.push(`Trade MORE ${best.symbol} (avg ${best.avg_r}R)`);
    }
    
    if (results.symbols.worst.length > 0) {
      const worst = results.symbols.worst[0];
      recommendations.push(`Trade LESS ${worst.symbol} (avg ${worst.avg_r}R)`);
    }
    
    recommendations.push(`Wider stops would save ${results.widerStops.would_survive_1_4x}/${results.widerStops.total_losses} losses (${results.widerStops.survivalRate}%)`);
    
    if (results.timing.bestHours.length > 0) {
      const bestHour = results.timing.bestHours[0];
      recommendations.push(`Best trading hour: ${bestHour.hour}:00 UTC (${bestHour.avg_r}R avg)`);
    }
    
    results.recommendations = recommendations;
    
    res.json({ ok: true, results });
    
  } catch (error) {
    console.error('[research/analysis] Error:', error);
    res.status(500).json({ ok: false, error: String(error) });
  }
});

export default router;
