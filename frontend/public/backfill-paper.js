/**
 * Browser console script to backfill PAPER outcomes
 * 
 * Usage:
 * 1. Open browser console (F12) on the Pro-Scalp app
 * 2. Paste and run: await backfillPaper()
 */

// Backend URL (Railway)
const API_BASE = 'https://pro-scalp-backend-production.up.railway.app';

async function apiPost(endpoint, params = {}) {
  const url = new URL(endpoint, API_BASE);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  
  const resp = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    mode: 'cors'
  });
  
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${text}`);
  }
  
  return resp.json();
}

async function checkPaper() {
  console.log('🔍 Checking signals needing PAPER backfill...');
  const r = await apiPost('/api/admin/backfill-paper-outcomes', { limit: 100, dryRun: 'true' });
  console.log('📊 Result:', r);
  return r;
}

async function runPaper(limit = 100) {
  console.log('🚀 Running backfill for up to ' + limit + ' signals...');
  const r = await apiPost('/api/admin/backfill-paper-outcomes', { limit: limit.toString() });
  console.log('✅ Done:', r);
  return r;
}

async function backfillPaper() {
  const check = await checkPaper();
  if (!check?.wouldProcess) {
    console.log('✅ No signals need backfill');
    return;
  }
  
  if (!confirm(`Create PAPER outcomes for ${check.wouldProcess} signals?`)) {
    console.log('❌ Cancelled');
    return;
  }
  
  const result = await runPaper(100);
  if (result?.created > 0) {
    console.log('🎉 Success! Refreshing in 3 seconds...');
    setTimeout(() => location.reload(), 3000);
  }
}

// Expose globally
window.backfillPaper = backfillPaper;
window.checkPaper = checkPaper;
window.runPaper = runPaper;

console.log('✅ Backfill helper loaded! Run: await backfillPaper()');
