#!/usr/bin/env node
/**
 * Performance tracking script for Pro-Scalp
 * Tracks signals and outcomes over time
 * 
 * Usage: node trackPerformance.mjs [--hours=38] [--output=performance.json]
 */

import { writeFileSync, existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const API_BASE = process.env.API_BASE || 'https://pro-scalp-backend-production.up.railway.app';

async function fetchJson(path) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getStats(hours = 48) {
  return fetchJson(`/api/stats?hours=${hours}&source=signals`);
}

async function getOutcomes(hours = 48, horizonMin = 15) {
  return fetchJson(`/api/outcomes?hours=${hours}&horizonMin=${horizonMin}&source=signals&limit=1000`);
}

async function getSignals(hours = 48) {
  return fetchJson(`/api/signals?hours=${hours}&limit=1000`);
}

function formatPct(val) {
  if (val == null) return 'N/A';
  return `${(val * 100).toFixed(1)}%`;
}

function formatR(val) {
  if (val == null) return 'N/A';
  return `${val > 0 ? '+' : ''}${val.toFixed(2)}R`;
}

function analyzeOutcomes(outcomes) {
  const byHorizon = {};
  const rows = outcomes.rows || [];
  
  console.log(`  ✓ ${rows.length} outcome rows`);
  
  for (const row of rows) {
    const h = row.horizonMin;
    if (!byHorizon[h]) {
      byHorizon[h] = { total: 0, win: 0, loss: 0, flat: 0, netR: 0, avgR: 0, mfe: [], mae: [] };
    }
    
    const d = byHorizon[h];
    d.total++;
    d.netR += row.rClose || 0;
    d.mfe.push(row.mfePct || 0);
    d.mae.push(row.maePct || 0);
    
    if (row.result === 'WIN') d.win++;
    else if (row.result === 'LOSS') d.loss++;
    else if (row.result === 'FLAT') d.flat++;
  }
  
  // Calculate averages
  for (const h in byHorizon) {
    const d = byHorizon[h];
    d.avgR = d.total > 0 ? d.netR / d.total : 0;
    d.avgMfe = d.mfe.length > 0 ? d.mfe.reduce((a,b)=>a+b,0) / d.mfe.length : 0;
    d.avgMae = d.mae.length > 0 ? d.mae.reduce((a,b)=>a+b,0) / d.mae.length : 0;
    d.winRate = d.total > 0 ? d.win / d.total : 0;
    d.stopRate = d.total > 0 ? d.loss / d.total : 0;
  }
  
  return byHorizon;
}

async function main() {
  const args = process.argv.slice(2);
  const hours = Number(args.find(a => a.startsWith('--hours='))?.split('=')[1]) || 38;
  const outputFile = args.find(a => a.startsWith('--output='))?.split('=')[1] || 'performance-tracker.json';
  
  console.log(`📊 Pro-Scalp Performance Tracker`);
  console.log(`================================`);
  console.log(`Tracking last ${hours} hours...\n`);
  
  try {
    // Fetch data
    console.log('Fetching signals...');
    const signals = await getSignals(hours);
    console.log(`  ✓ ${signals.total || signals.rows?.length || 0} signals`);
    
    console.log('Fetching stats...');
    let stats = {};
    try {
      stats = await getStats(hours);
    } catch (e) {
      console.log('  ⚠ Stats endpoint error (non-critical)');
    }
    
    // Fetch outcomes for each horizon
    const horizons = [15, 30, 60, 120, 240];
    const allOutcomes = {};
    
    for (const h of horizons) {
      console.log(`Fetching ${h}m outcomes...`);
      const outcomes = await getOutcomes(hours, h);
      if (h === 15 && outcomes.rows?.length > 0) {
        console.log('  Sample row keys:', Object.keys(outcomes.rows[0]).slice(0, 10).join(', '));
      }
      allOutcomes[h] = analyzeOutcomes(outcomes);
    }
    
    // Build report
    const report = {
      timestamp: Date.now(),
      timestampISO: new Date().toISOString(),
      hours,
      signals: {
        total: signals.total || signals.rows?.length || 0,
        categories: signals.totals || {}
      },
      outcomes: allOutcomes,
      summary: {
        byHorizon: {}
      }
    };
    
    // Print summary
    console.log('\n📈 PERFORMANCE SUMMARY');
    console.log('======================');
    
    for (const h of horizons) {
      const d = allOutcomes[h];
      if (!d || d.total === 0) {
        console.log(`\n${h}m: No completed outcomes yet`);
        continue;
      }
      
      console.log(`\n${h}m Horizon (${d.total} completed):`);
      console.log(`  Win Rate: ${formatPct(d.winRate)} (${d.win}/${d.total})`);
      console.log(`  Stop Rate: ${formatPct(d.stopRate)} (${d.loss}/${d.total})`);
      console.log(`  Flat Rate: ${formatPct(d.flat/d.total)} (${d.flat}/${d.total})`);
      console.log(`  Net R: ${formatR(d.netR)}`);
      console.log(`  Avg R: ${formatR(d.avgR)}`);
      console.log(`  Avg Max Up: ${(d.avgMfe * 100).toFixed(2)}%`);
      console.log(`  Avg Max Down: ${(d.avgMae * 100).toFixed(2)}%`);
      
      report.summary.byHorizon[h] = {
        total: d.total,
        win: d.win,
        loss: d.loss,
        flat: d.flat,
        winRate: d.winRate,
        stopRate: d.stopRate,
        netR: d.netR,
        avgR: d.avgR,
        avgMfePct: d.avgMfe,
        avgMaePct: d.avgMae
      };
    }
    
    // Save to file
    let history = [];
    if (existsSync(outputFile)) {
      try {
        history = JSON.parse(readFileSync(outputFile, 'utf8'));
        if (!Array.isArray(history)) history = [history];
      } catch {}
    }
    
    history.push(report);
    writeFileSync(outputFile, JSON.stringify(history, null, 2));
    console.log(`\n💾 Saved to ${outputFile}`);
    
    // Show trend if multiple snapshots
    if (history.length > 1) {
      console.log('\n📉 TREND (vs previous snapshot)');
      console.log('=================================');
      const prev = history[history.length - 2];
      const timeDiff = Math.round((report.timestamp - prev.timestamp) / 60000);
      console.log(`Time since last: ${timeDiff} minutes`);
      
      for (const h of horizons) {
        const curr = report.summary.byHorizon[h];
        const pre = prev.summary.byHorizon[h];
        if (!curr || !pre) continue;
        
        const winRateChange = (curr.winRate - pre.winRate) * 100;
        const avgRChange = curr.avgR - pre.avgR;
        
        console.log(`${h}m: WinRate ${winRateChange >= 0 ? '+' : ''}${winRateChange.toFixed(1)}pp, AvgR ${avgRChange >= 0 ? '+' : ''}${avgRChange.toFixed(2)}`);
      }
    }
    
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

main();
