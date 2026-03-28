/**
 * Configuration Verification Endpoint
 * Quick health check for gate configuration
 */

import { Router } from 'express';
import { getDb } from './db/db.js';
import { getGateConfig } from './signalGate.js';

const router = Router();

router.get('/api/verification/status', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  try {
    const d = getDb();
    const gateConfig = getGateConfig();
    
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    
    // Get last 24h stats
    const recentSignals = await d.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN blocked_reasons_json IS NULL OR blocked_reasons_json = '[]' THEN 1 ELSE 0 END) as passed_gate,
        SUM(CASE WHEN blocked_reasons_json IS NOT NULL AND blocked_reasons_json != '[]' THEN 1 ELSE 0 END) as blocked
      FROM signals
      WHERE time > ?
    `).get(oneDayAgo);
    
    // Get symbol breakdown
    const symbolCounts = await d.prepare(`
      SELECT symbol, COUNT(*) as count
      FROM signals
      WHERE time > ?
      GROUP BY symbol
      ORDER BY count DESC
      LIMIT 10
    `).all(oneDayAgo);
    
    // Check blocked symbols that slipped through
    const blockedSymbols = ['ZECUSDT', 'ENSOUSDT', 'ESPUSDT', 'PUMPUSDT', 'TAOUSDT', 
                           'KITEUSDT', 'BARDUSDT', 'ALLOUSDT', 'ARBUSDT', 'XPLUSDT'];
    const placeholder = blockedSymbols.map(() => '?').join(',');
    
    const badSymbolsFound = await d.prepare(`
      SELECT symbol, COUNT(*) as count
      FROM signals
      WHERE time > ? AND symbol IN (${placeholder})
      GROUP BY symbol
    `).all(oneDayAgo, ...blockedSymbols);
    
    // Get outcome stats
    const outcomeStats = await d.prepare(`
      SELECT 
        COUNT(*) as total_outcomes,
        SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'WIN_TP2' THEN 1 ELSE 0 END) as win_tp2,
        SUM(CASE WHEN status = 'WIN_TP1' THEN 1 ELSE 0 END) as win_tp1,
        SUM(CASE WHEN status = 'LOSS_STOP' THEN 1 ELSE 0 END) as loss_stop,
        AVG(ext24_managed_r) as avg_r
      FROM extended_outcomes
      WHERE signal_time > ?
    `).get(oneDayAgo);
    
    // Check pending outcomes
    const pendingCount = await d.prepare(`
      SELECT COUNT(*) as count
      FROM extended_outcomes
      WHERE completed_at IS NULL
    `).get();
    
    // Verify config
    const blockedSymbolsEnv = process.env.SIGNAL_GATE_BLOCK_SYMBOLS || '';
    const blockedSymbolsList = blockedSymbolsEnv ? blockedSymbolsEnv.split(',') : [];
    
    const configChecks = {
      whitelist_disabled: !gateConfig.useSymbolWhitelist,
      time_filters_enabled: gateConfig.useTimeFilters,
      blocked_symbols_count: blockedSymbolsList.length,
      blocked_hours_count: gateConfig.blockedHours?.length || 0,
      mfe_zone_disabled: !gateConfig.useMfeDeathZoneFilter,
    };
    
    const allChecksPass = 
      configChecks.whitelist_disabled &&
      configChecks.time_filters_enabled &&
      configChecks.blocked_symbols_count >= 5 &&
      configChecks.blocked_hours_count >= 10;
    
    res.json({
      ok: true,
      status: allChecksPass ? 'HEALTHY' : 'ISSUES_DETECTED',
      timestamp: new Date().toISOString(),
      config: {
        mode: gateConfig.useSymbolWhitelist ? 'WHITELIST' : 'BLACKLIST',
        blockedSymbols: blockedSymbolsList,
        blockedHours: gateConfig.blockedHours || [],
        allowedCategories: gateConfig.allowedCategories || [],
      },
      configChecks,
      last24h: {
        signals: {
          total: recentSignals?.total || 0,
          passedGate: recentSignals?.passed_gate || 0,
          blocked: recentSignals?.blocked || 0,
          topSymbols: symbolCounts || [],
        },
        blockedSymbolsSlipped: badSymbolsFound || [],
        outcomes: {
          total: outcomeStats?.total_outcomes || 0,
          completed: outcomeStats?.completed || 0,
          winTp2: outcomeStats?.win_tp2 || 0,
          winTp1: outcomeStats?.win_tp1 || 0,
          lossStop: outcomeStats?.loss_stop || 0,
          avgR: outcomeStats?.avg_r || 0,
        },
        pending: pendingCount?.count || 0,
      },
      recommendations: [
        !configChecks.whitelist_disabled && '⚠️ Whitelist is enabled - should be DISABLED for blacklist mode',
        !configChecks.time_filters_enabled && '⚠️ Time filters are disabled',
        (badSymbolsFound?.length > 0) && `⚠️ Blocked symbols found: ${badSymbolsFound.map((s: any) => s.symbol).join(', ')}`,
        (pendingCount?.count > 20) && `⚠️ ${pendingCount.count} pending outcomes - resolver may be stuck`,
      ].filter(Boolean),
    });
    
  } catch (error) {
    console.error('[verification] Error:', error);
    res.status(500).json({ ok: false, error: String(error) });
  }
});

export default router;
