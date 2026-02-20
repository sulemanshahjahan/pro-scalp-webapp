#!/usr/bin/env node
// Check actual runtime config vs env vars

const API = 'https://pro-scalp-backend-production.up.railway.app';

async function main() {
  console.log('🔍 Checking Config...\n');
  
  // 1. Check system health for config info
  try {
    const health = await fetch(`${API}/api/system/health`).then(r => r.json());
    console.log('System Health:', JSON.stringify(health, null, 2));
  } catch (e) {
    console.log('Health check failed:', e.message);
  }
  
  // 2. Check if any signals exist in last 12 hours
  console.log('\n📡 Checking recent signals...');
  try {
    const signals = await fetch(`${API}/api/signals?hours=12&limit=100`).then(r => r.json());
    console.log(`Found ${signals.total || 0} signals in last 12h`);
    if (signals.rows?.length > 0) {
      console.log('Recent:', signals.rows.slice(0, 3).map(s => `${s.symbol} ${s.category} @ ${new Date(Number(s.time)).toISOString()}`));
    }
  } catch (e) {
    console.log('Signals check failed:', e.message);
  }
  
  // 3. Check scan runs for last hour
  console.log('\n📊 Checking scan runs...');
  try {
    const runs = await fetch(`${API}/api/scan-runs?hours=1&limit=5`).then(r => r.json());
    console.log(`Found ${runs.length || 0} scan runs in last hour`);
    if (runs.length > 0) {
      const lastRun = runs[0];
      console.log('Last run signals:', lastRun.signalsByCategory);
      console.log('Last run readyCandidates:', lastRun.gateStats?.readyCandidates);
      console.log('Last run ready_core_true:', lastRun.gateStats?.ready?.ready_core_true);
    }
  } catch (e) {
    console.log('Scan runs check failed:', e.message);
  }
}

main().catch(console.error);
