import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { ensureVapid } from './notifier.js';
import { getLastBtcMarket, getLastScanHealth, getScanIntervalMs, getMaxScanMs, startLoop, scanOnce, thresholdsForPreset, type Preset } from './scanner.js';
import { getLatestScanRuns, listScanRuns, getScanRunByRunId } from './scanStore.js';
import { listCandidateFeatures } from './candidateFeaturesStore.js';
import { applyOverrides, evalFromFeatures, getTuneConfigFromEnv } from './tuneSim.js';
import { pushToAll } from './notifier.js';
import { emailNotify } from './emailNotifier.js';
import { getDb } from './db/db.js';
import {
  clearAllSignalsData,
  deleteOutcomesBulk,
  deleteOutcomesByFilter,
  getInvalidReasons,
  getOutcomesBacklogCount,
  getOutcomesHealth,
  getSignalById,
  getStats,
  getStatsBuckets,
  getStatsHealth,
  getStatsMatrixBtc,
  getStatsSummary,
  listOutcomes,
  listSignals,
  listStrategyVersions,
  getLoggedCategories,
  recordSignal,
  rebuildOutcomesByFilter,
  updateOutcomesOnce,
  startOutcomeUpdater
} from './signalStore.js';
import fs from 'fs';
import { DB_PATH } from './dbPath.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverStartedAt = Date.now();
const buildGitSha =
  process.env.GIT_SHA ||
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.RENDER_GIT_COMMIT ||
  '';
const buildStartedAt = Number(process.env.BUILD_STARTED_AT) || serverStartedAt;

const app = express();
const corsOrigins = (process.env.CORS_ORIGINS || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
app.use(cors({
  origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
    if (!origin) return cb(null, true);
    if (corsOrigins.includes('*') || corsOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('CORS not allowed'));
  },
  credentials: true,
}));
app.options('*', cors());
app.use(express.json());

function parsePreset(v: any): Preset {
  const s = String(v || '').toUpperCase();
  if (s === 'CONSERVATIVE' || s === 'AGGRESSIVE' || s === 'BALANCED') return s as Preset;
  return 'BALANCED';
}

function requireAdmin(req: express.Request, res: express.Response) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return true;
  const got = req.header('x-admin-token');
  if (got !== token) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return false;
  }
  return true;
}

function computePercentiles(values: number[], ps = [0.1, 0.25, 0.5, 0.75, 0.9]) {
  const clean = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  const n = clean.length;
  const out: Record<string, number | null> = {};
  for (const p of ps) {
    if (!n) { out[`p${Math.round(p * 100)}`] = null; continue; }
    const idx = (n - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    const t = idx - lo;
    const v = lo === hi ? clean[lo] : clean[lo] * (1 - t) + clean[hi] * t;
    out[`p${Math.round(p * 100)}`] = Number.isFinite(v) ? v : null;
  }
  return out;
}

const db = getDb();
const dbPath = db.driver === 'sqlite' ? DB_PATH : null;

console.log('[db] server dbPath:', dbPath || '(postgres)');
console.log('[db] env DB_PATH:', process.env.DB_PATH || '');

// init schema (if present)
void (async () => {
  if (db.driver === 'sqlite') {
    try {
      const schemaPath = path.join(__dirname, '../../db/schema.sql');
      console.log('[db] schemaPath:', schemaPath, 'exists?', fs.existsSync(schemaPath));
      if (fs.existsSync(schemaPath)) {
        const schema = fs.readFileSync(schemaPath, 'utf-8');
        await db.exec(schema);
      }
    } catch (e) {
      console.warn('[db] schema load failed (continuing):', e);
    }

    // Ensure subscriptions table exists even if schema.sql is missing
    try {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS subscriptions (
          endpoint TEXT PRIMARY KEY,
          keys_p256dh TEXT NOT NULL,
          keys_auth TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
        );
      `);
    } catch (e) {
      console.warn('[db] subscriptions table ensure failed:', e);
    }
  }
})();

// VAPID
let publicKey = '';
void ensureVapid()
  .then((r) => { publicKey = r.publicKey; })
  .catch((e) => console.warn('[vapid] init failed', e));

// Health
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// System health (scan + outcomes + BTC)
app.get('/api/system/health', async (req, res) => {
  try {
    const days = Number((req.query as any)?.days);
    const safeDays = Number.isFinite(days) ? Math.max(1, Math.min(365, days)) : 7;
    const { lastFinished, lastRunning } = await getLatestScanRuns();
    const legacyScan = getLastScanHealth();
    const scanLast = lastFinished ?? legacyScan ?? null;
    const scanIntervalMs = getScanIntervalMs();
    let scanState: 'IDLE' | 'RUNNING' | 'COOLDOWN' = 'IDLE';
    let nextScanAt: number | null = null;
    if (lastRunning && lastRunning.status === 'RUNNING') {
      scanState = 'RUNNING';
    } else if (scanLast?.finishedAt) {
      const next = Number(scanLast.finishedAt) + scanIntervalMs;
      nextScanAt = next;
      if (Date.now() < next) scanState = 'COOLDOWN';
    }
    const scan = {
      state: scanState,
      nextScanAt,
      meta: {
        intervalMs: scanIntervalMs,
        maxScanMs: getMaxScanMs(),
      },
      last: scanLast,
      current: lastRunning ?? null,
    };
    const { market, at } = getLastBtcMarket();
    const outcomes = getOutcomesHealth();
    const backlog = await getOutcomesBacklogCount({ days: safeDays });
    res.json({
      ok: true,
      days: safeDays,
      categoriesLogged: getLoggedCategories(),
      build: {
        gitSha: buildGitSha || null,
        startedAt: buildStartedAt,
      },
      scan,
      btc: { market, at },
      outcomes: {
        lastRun: outcomes,
        backlog,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Scan runs (history)
app.get('/api/scanRuns', async (req, res) => {
  try {
    const limitRaw = Number((req.query as any)?.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, limitRaw)) : 50;
    const rows = await listScanRuns(limit);
    res.json({ ok: true, limit, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Tune simulator (admin-only)
app.post('/api/tune/sim', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const body = req.body || {};
    let runId = String(body.runId || '').trim();
    const useLatest = body.useLatestFinishedIfMissing !== false;
    let scanRun = runId ? await getScanRunByRunId(runId) : null;
    if (!runId && useLatest) {
      const latest = await getLatestScanRuns();
      scanRun = latest.lastFinished;
      runId = scanRun?.runId ?? '';
    }
    if (!runId) return res.status(400).json({ ok: false, error: 'runId required' });
    if (!scanRun && runId) scanRun = await getScanRunByRunId(runId);

    const preset = parsePreset(body.preset ?? scanRun?.preset ?? 'BALANCED');
    const scope = body.scope || {};
    const limitRaw = Number(scope?.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(5000, limitRaw)) : 500;
    const symbols = Array.isArray(scope?.symbols) ? scope.symbols : null;

    const rows = await listCandidateFeatures({
      runId,
      preset: body.preset ? preset : undefined,
      limit,
      symbols,
    });
    if (!rows.length) return res.status(404).json({ ok: false, error: 'No candidate features found' });

    const cfgBase = getTuneConfigFromEnv(thresholdsForPreset(preset));
    const overrideReport = applyOverrides(cfgBase, body.overrides || {});
    const cfg = overrideReport.config;
    const includeExamples = Boolean(body.includeExamples);
    const examplesPerGate = Math.max(1, Math.min(50, Number(body.examplesPerGate ?? 5)));

    const counts = { watch: 0, early: 0, ready: 0, best: 0 };
    const funnel = {
      candidate_evaluated: rows.length,
      watch_created: 0,
      early_created: 0,
      ready_core_true: 0,
      best_core_true: 0,
      ready_final_true: 0,
      best_final_true: 0,
    };
    const firstFailed: Record<string, Record<string, number>> = {
      watch: {},
      early: {},
      ready: {},
      best: {},
    };
    const gateTrue: Record<string, Record<string, number>> = {
      watch: {},
      early: {},
      ready: {},
      best: {},
    };
    const examples: Record<string, Record<string, string[]>> | undefined = includeExamples
      ? { watch: {}, early: {}, ready: {}, best: {} }
      : undefined;

    const watchOrder = ['nearVwapWatch', 'rsiWatchOk', 'emaWatchOk'];
    const earlyOrder = ['sessionOK', 'nearVwapWatch', 'rsiWatchOk', 'emaWatchOk', 'atrOkReady', 'reclaimOrTap', 'priceAboveVwap'];
    const readyOrder = [
      'sessionOK',
      'priceAboveVwap',
      'priceAboveEma',
      'nearVwapReady',
      'reclaimOrTap',
      'readyVolOk',
      'atrOkReady',
      'confirm15mOk',
      'strongBody',
      'rsiReadyOk',
      'readyTrendOk',
    ];
    const bestOrder = [
      'priceAboveVwap',
      'priceAboveEma',
      'nearVwapBuy',
      'rsiBestOk',
      'strongBody',
      'atrOkBest',
      'trendOk',
      'sessionOK',
      'confirm15mOk',
      'sweepOk',
      'reclaimOrTap',
      'bestVolOk',
      'rrOk',
      'hasMarket',
    ];

    const addGateTrue = (bucket: Record<string, number>, flags: Record<string, boolean>) => {
      for (const [k, ok] of Object.entries(flags)) {
        if (ok) bucket[k] = (bucket[k] ?? 0) + 1;
      }
    };
    const addFirstFailed = (stage: string, order: string[], flags: Record<string, boolean>, symbol: string) => {
      const k = order.find(key => !flags[key]);
      if (!k) return;
      firstFailed[stage][k] = (firstFailed[stage][k] ?? 0) + 1;
      if (examples) {
        const arr = examples[stage][k] ?? (examples[stage][k] = []);
        if (arr.length < examplesPerGate) arr.push(symbol);
      }
    };
    const addExample = (stage: string, key: string, symbol: string) => {
      if (!examples) return;
      const arr = examples[stage][key] ?? (examples[stage][key] = []);
      if (arr.length < examplesPerGate) arr.push(symbol);
    };

    for (const row of rows) {
      const evalRes = evalFromFeatures({ metrics: row.metrics, computed: row.computed }, cfg);
      if (evalRes.watchOk) counts.watch += 1;
      if (evalRes.earlyOk) counts.early += 1;
      if (evalRes.readyOk) counts.ready += 1;
      if (evalRes.bestOk) counts.best += 1;

      if (evalRes.watchOk) funnel.watch_created += 1;
      if (evalRes.earlyOk) funnel.early_created += 1;
      if (evalRes.readyCore) funnel.ready_core_true += 1;
      if (evalRes.bestCore) funnel.best_core_true += 1;
      if (evalRes.readyOk) funnel.ready_final_true += 1;
      if (evalRes.bestOk) funnel.best_final_true += 1;

      addGateTrue(gateTrue.watch, evalRes.watchFlags);
      addGateTrue(gateTrue.early, evalRes.earlyFlags);
      addGateTrue(gateTrue.ready, evalRes.readyFlags);
      addGateTrue(gateTrue.best, evalRes.bestFlags);

      if (!evalRes.watchOk) addFirstFailed('watch', watchOrder, evalRes.watchFlags, row.symbol);
      if (!evalRes.earlyOk) addFirstFailed('early', earlyOrder, evalRes.earlyFlags, row.symbol);

      if (!evalRes.readyCore) {
        addFirstFailed('ready', readyOrder, evalRes.readyFlags, row.symbol);
      } else if (!evalRes.readySweepOk) {
        firstFailed.ready.readySweep = (firstFailed.ready.readySweep ?? 0) + 1;
        addExample('ready', 'readySweep', row.symbol);
      } else if (!evalRes.readyBtcOk) {
        firstFailed.ready.btcOkReady = (firstFailed.ready.btcOkReady ?? 0) + 1;
        addExample('ready', 'btcOkReady', row.symbol);
      }

      if (!evalRes.bestCore) {
        addFirstFailed('best', bestOrder, evalRes.bestFlags, row.symbol);
      } else if (!evalRes.bestBtcOk) {
        firstFailed.best.btcBull = (firstFailed.best.btcBull ?? 0) + 1;
        addExample('best', 'btcBull', row.symbol);
      }
    }

    const startedAt = scanRun?.startedAt ?? rows[0]?.startedAt ?? null;
    const diffVsActual = scanRun?.signalsByCategory ? {
      watch: counts.watch - Number(scanRun.signalsByCategory?.WATCH ?? 0),
      early: counts.early - Number(scanRun.signalsByCategory?.EARLY_READY ?? 0),
      ready: counts.ready - Number(scanRun.signalsByCategory?.READY_TO_BUY ?? 0),
      best: counts.best - Number(scanRun.signalsByCategory?.BEST_ENTRY ?? 0),
    } : null;

    res.json({
      meta: {
        preset,
        runId,
        startedAt,
        evaluated: rows.length,
        overrides: {
          applied: overrideReport.appliedOverrides,
          unknownKeys: overrideReport.unknownOverrideKeys,
          typeErrors: overrideReport.overrideTypeErrors,
          effectiveConfig: overrideReport.config,
        },
      },
      counts,
      funnel,
      firstFailed,
      gateTrue,
      ...(examples ? { examples } : {}),
      diffVsActual,
      riskNotes: [],
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Tune histograms (admin-only)
app.get('/api/tune/hist', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    let runId = String((req.query as any)?.runId || '').trim();
    const useLatestRaw = String((req.query as any)?.useLatestFinishedIfMissing || '').toLowerCase();
    const useLatest = useLatestRaw ? ['1', 'true', 'yes'].includes(useLatestRaw) : true;
    let scanRun = runId ? await getScanRunByRunId(runId) : null;
    if (!runId && useLatest) {
      const latest = await getLatestScanRuns();
      scanRun = latest.lastFinished;
      runId = scanRun?.runId ?? '';
    }
    if (!runId) return res.status(400).json({ ok: false, error: 'runId required' });
    if (!scanRun && runId) scanRun = await getScanRunByRunId(runId);

    const preset = parsePreset((req.query as any)?.preset ?? scanRun?.preset ?? 'BALANCED');
    const limitRaw = Number((req.query as any)?.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(10000, limitRaw)) : 5000;
    const rows = await listCandidateFeatures({ runId, preset: (req.query as any)?.preset ? preset : undefined, limit });
    if (!rows.length) return res.status(404).json({ ok: false, error: 'No candidate features found' });

    const rsiVals: number[] = [];
    const vwapAbs: number[] = [];
    const emaAbs: number[] = [];
    const bodyPctVals: number[] = [];
    const atrPctVals: number[] = [];

    for (const row of rows) {
      const m = row.metrics ?? {};
      const rsi = Number(m.rsi);
      const vwapDist = Number(m.vwapDistPct);
      const emaDist = Number(m.emaDistPct);
      const body = Number(m.bodyPct);
      const atr = Number(m.atrPct);
      if (Number.isFinite(rsi)) rsiVals.push(rsi);
      if (Number.isFinite(vwapDist)) vwapAbs.push(Math.abs(vwapDist));
      if (Number.isFinite(emaDist)) emaAbs.push(Math.abs(emaDist));
      if (Number.isFinite(body)) bodyPctVals.push(body);
      if (Number.isFinite(atr)) atrPctVals.push(atr);
    }

    res.json({
      ok: true,
      meta: {
        runId,
        preset,
        startedAt: scanRun?.startedAt ?? rows[0]?.startedAt ?? null,
        evaluated: rows.length,
      },
      rsi: computePercentiles(rsiVals),
      vwapAbs: computePercentiles(vwapAbs),
      emaAbs: computePercentiles(emaAbs),
      bodyPct: computePercentiles(bodyPctVals),
      atrPct: computePercentiles(atrPctVals),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Debug: list tables
app.get('/api/debug/tables', async (_req, res) => {
  try {
    if (db.driver === 'sqlite') {
      const rows = await db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as Array<{ name: string }>;
      res.json({ ok: true, tables: rows.map(r => r.name) });
      return;
    }
    const rows = await db.prepare(`
      SELECT table_name as name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `).all() as Array<{ name: string }>;
    res.json({ ok: true, tables: rows.map(r => r.name) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Public key
app.get('/api/vapidPublicKey', async (_req, res) => {
  try {
    if (!publicKey) {
      const r = await ensureVapid();
      publicKey = r.publicKey;
    }
    res.json({ publicKey });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// BTC market snapshot (for frontend display)
app.get('/api/market/btc', (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const { market, at } = getLastBtcMarket();
    res.json({ ok: true, market, at });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Subscriptions
app.post('/api/subscribe', async (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  try {
    await db.prepare(`INSERT INTO subscriptions(endpoint, keys_p256dh, keys_auth)
                VALUES(?, ?, ?)
                ON CONFLICT(endpoint) DO UPDATE SET keys_p256dh=excluded.keys_p256dh, keys_auth=excluded.keys_auth`)
      .run(sub.endpoint, sub.keys.p256dh, sub.keys.auth);
  } catch (e) {
    console.warn('[db] subscribe insert failed:', e);
  }
  res.json({ ok: true });
});

app.post('/api/unsubscribe', async (req, res) => {
  const sub = req.body;
  if (sub?.endpoint) {
    try { await db.prepare('DELETE FROM subscriptions WHERE endpoint = ?').run(sub.endpoint); } catch {}
  }
  res.json({ ok: true });
});

// ✅ Scan-once with coalescing queue (max 1 running + 1 pending)
let running: Promise<any[]> | null = null;
let runningPreset: Preset | null = null;
let runningStartedAt = 0;
let pendingPreset: Preset | null = null;
const lastByPreset = new Map<Preset, { signals: any[]; at: number }>();

async function runScan(preset: Preset) {
  runningPreset = preset;
  runningStartedAt = Date.now();
  try {
    const out = await scanOnce(preset);
    const at = Date.now();
    lastByPreset.set(preset, { signals: out, at });
    try {
      for (const sig of out) await recordSignal(sig as any, preset);
    } catch (e) {
      console.warn('[signals] record failed:', e);
    }
    return out;
  } finally {
    running = null;
    runningPreset = null;
    const next = pendingPreset;
    pendingPreset = null;
    if (next) running = runScan(next);
  }
}

app.get('/api/scan', async (req, res) => {
  const preset = parsePreset((req.query as any)?.preset);
  const asyncModeRaw = String((req.query as any)?.async ?? '').toLowerCase();
  const asyncMode = ['1', 'true', 'yes'].includes(asyncModeRaw);

  const last = lastByPreset.get(preset) ?? { signals: [], at: 0 };

  if (!running) {
    running = runScan(preset);
  } else {
    pendingPreset = preset;
  }

  if (asyncMode) {
    return res.json({
      queued: true,
      running: Boolean(running),
      runningPreset,
      runningStartedAt,
      preset,
      at: last.at || Date.now(),
      signals: last.signals,
    });
  }

  try {
    const out = await running;
    return res.json({ preset, at: Date.now(), signals: out });
  } catch (e) {
    return res.status(500).json({ preset, at: Date.now(), signals: [], error: String(e) });
  }
});

// --- DEBUG: push ---
app.post('/api/debug/push', async (req, res) => {
  try {
    const { symbol = 'DEMOUSDT', category = 'BEST_ENTRY', price = 1.2345 } = req.body || {};
    const title =
      category === 'READY_TO_BUY' ? '✅ Ready to BUY' :
      category === 'BEST_ENTRY'   ? '⭐ Best Entry' :
                                    '👀 Watch';
    const body = `${symbol} @ ${Number(price).toFixed(6)} | ΔVWAP 0.20% | RSI 56.5 | Vol× 1.80`;
    await pushToAll({ title, body, data: { symbol, price, category } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// --- DEBUG: email ---
app.get('/api/debug/email', async (_req, res) => {
  try {
    const fakeSignal: any = {
      symbol: 'TESTUSDT',
      category: 'BEST_ENTRY',
      price: 123.45,
      rsi9: 55.2,
      vwapDistancePct: 0.001,
      ema200: 123.00,
      volume: 99999,
      chartUrl: 'https://www.tradingview.com/chart/?symbol=BINANCE:BTCUSDT'
    };
    await emailNotify(undefined, fakeSignal);
    res.json({ ok: true, sent: fakeSignal });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// --- DEBUG: outcomes health ---
app.get('/api/debug/outcomes/health', async (req, res) => {
  const enabled = (process.env.DEBUG_ENDPOINTS ?? 'false').toLowerCase() === 'true';
  if (!enabled) return res.status(404).json({ ok: false });
  const debugKey = process.env.DEBUG_KEY;
  if (debugKey && req.header('x-debug-key') !== debugKey) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  try {
    const days = Number((req.query as any)?.days);
    const safeDays = Number.isFinite(days) ? Math.max(1, Math.min(365, days)) : 7;
    const since = Date.now() - safeDays * 24 * 60 * 60_000;

    const byStatus = await db.prepare(`
      SELECT
        o.window_status as status,
        COALESCE(o.invalid_reason, '') as reason,
        COUNT(*) as n
      FROM signal_outcomes o
      JOIN signals s ON s.id = o.signal_id
      WHERE s.time >= ?
      GROUP BY 1, 2
      ORDER BY n DESC
    `).all(since);

    const coverage = await db.prepare(`
      SELECT
        o.horizon_min as horizonMin,
        AVG((o.n_candles * 100.0) / (1.0 * o.horizon_min / NULLIF(o.interval_min, 0))) as avgCoveragePct,
        MIN((o.n_candles * 100.0) / (1.0 * o.horizon_min / NULLIF(o.interval_min, 0))) as minCoveragePct
      FROM signal_outcomes o
      JOIN signals s ON s.id = o.signal_id
      WHERE s.time >= ?
        AND o.window_status = 'COMPLETE'
      GROUP BY o.horizon_min
      ORDER BY o.horizon_min
    `).all(since);

    res.json({ ok: true, days: safeDays, since, byStatus, coverage });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// --- DEBUG: ready gate diagnostics ---
app.get('/api/debug/readyGate', async (req, res) => {
  const enabled = (process.env.DEBUG_ENDPOINTS ?? 'false').toLowerCase() === 'true';
  if (!enabled) return res.status(404).json({ ok: false });
  const debugKey = process.env.DEBUG_KEY;
  if (debugKey && req.header('x-debug-key') !== debugKey) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  try {
    const limitRaw = Number((req.query as any)?.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 50;

    const rows = await db.prepare(`
      SELECT
        id,
        symbol,
        time,
        category,
        blocked_by_btc as blockedByBtc,
        ready_debug_json as readyDebugJson,
        gate_snapshot_json as gateSnapshotJson
      FROM signals
      ORDER BY time DESC
      LIMIT ?
    `).all(limit) as Array<any>;

    const countsAll: Record<string, number> = {};
    const countsEarly: Record<string, number> = {};
    const items = rows.map((r) => {
      let blockedReasons: string[] = [];
      let firstFailedGate: string | null = null;
      let gateScore: number | null = null;

      try {
        if (r.readyDebugJson) {
          const parsed = JSON.parse(String(r.readyDebugJson));
          blockedReasons = Array.isArray(parsed?.blockedReasons) ? parsed.blockedReasons : [];
          firstFailedGate = parsed?.firstFailedGate ?? null;
          gateScore = Number.isFinite(parsed?.gateScore) ? parsed.gateScore : null;
        } else if (r.gateSnapshotJson) {
          const snap = JSON.parse(String(r.gateSnapshotJson));
          const ready = snap?.ready ?? {};
          const gateMap: Array<{ key: string; ok: boolean; reason: string }> = [
            { key: 'nearVwapBuy', ok: Boolean(ready.nearVwap), reason: 'Too far from VWAP (extended)' },
            { key: 'confirm15mOk', ok: Boolean(ready.confirm15), reason: '15m confirmation not satisfied' },
            { key: 'trendOk', ok: Boolean(ready.trend), reason: 'Trend not OK (EMA50>EMA200 + both rising)' },
            { key: 'volSpike', ok: Boolean(ready.volSpike), reason: 'Volume spike not met' },
            { key: 'atrOk', ok: Boolean(ready.atr), reason: 'ATR too high' },
            { key: 'sweepOk', ok: Boolean(ready.sweep), reason: 'Liquidity sweep not detected' },
            { key: 'strongBody', ok: Boolean(ready.strongBody), reason: 'No strong bullish body candle' },
            { key: 'reclaimOrTap', ok: Boolean(ready.reclaimOrTap), reason: 'No reclaim/tap pattern (or blocked by day boundary)' },
            { key: 'hasMarket', ok: Boolean(ready.hasMarket), reason: 'BTC market data missing' },
            { key: 'btcOk', ok: Boolean(ready.btc), reason: 'BTC regime gate failed' },
          ];
          const failed = gateMap.filter(g => !g.ok);
          blockedReasons = failed.map(g => g.reason);
          firstFailedGate = failed[0]?.key ?? null;
          gateScore = gateMap.length ? Math.round(((gateMap.length - failed.length) / gateMap.length) * 100) : null;
        }
      } catch {
        blockedReasons = [];
        firstFailedGate = null;
        gateScore = null;
      }

      for (const reason of blockedReasons) {
        countsAll[reason] = (countsAll[reason] ?? 0) + 1;
        if (r.category === 'EARLY_READY') {
          countsEarly[reason] = (countsEarly[reason] ?? 0) + 1;
        }
      }

      return {
        id: r.id,
        symbol: r.symbol,
        time: r.time,
        category: r.category,
        blockedByBtc: Boolean(r.blockedByBtc),
        blockedReasons,
        firstFailedGate,
        gateScore,
      };
    });

    res.json({ ok: true, limit, counts: countsAll, countsEarly, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// --- DEBUG: run outcomes once (manual trigger) ---
app.post('/api/debug/outcomes/run', async (req, res) => {
  const enabled = (process.env.DEBUG_ENDPOINTS ?? 'false').toLowerCase() === 'true';
  if (!enabled) return res.status(404).json({ ok: false });
  const debugKey = process.env.DEBUG_KEY;
  if (debugKey && req.header('x-debug-key') !== debugKey) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  try {
    await updateOutcomesOnce();
    const outcomes = getOutcomesHealth();
    const signalsTotal = await db.prepare('SELECT COUNT(1) as n FROM signals').get() as { n: number };
    const outcomesTotal = await db.prepare('SELECT COUNT(1) as n FROM signal_outcomes').get() as { n: number };
    res.json({
      ok: true,
      outcomes,
      signalsTotal: signalsTotal?.n ?? 0,
      outcomesTotal: outcomesTotal?.n ?? 0,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Signals
app.get('/api/signals', async (req, res) => {
  try {
    const days = Number((req.query as any)?.days);
    const start = Number((req.query as any)?.start);
    const end = Number((req.query as any)?.end);
    const limit = Number((req.query as any)?.limit);
    const offset = Number((req.query as any)?.offset);
    const category = String((req.query as any)?.category || '').trim() || undefined;
    const categoriesRaw = String((req.query as any)?.categories || '').trim();
    const categories = categoriesRaw ? categoriesRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const symbol = String((req.query as any)?.symbol || '').trim() || undefined;
    const preset = String((req.query as any)?.preset || '').trim() || undefined;
    const strategyVersion = String((req.query as any)?.version || '').trim() || undefined;
    const blockedByBtcRaw = String((req.query as any)?.blockedByBtc || '').toLowerCase();
    const blockedByBtc = ['1', 'true', 'yes'].includes(blockedByBtcRaw) ? true
      : ['0', 'false', 'no'].includes(blockedByBtcRaw) ? false : undefined;
    const btcState = String((req.query as any)?.btcState || '').trim() || undefined;
    const uniqueRaw = String((req.query as any)?.unique || '').toLowerCase();
    const unique = ['1', 'true', 'yes'].includes(uniqueRaw);

    const out = await listSignals({
      days: Number.isFinite(days) ? days : undefined,
      start: Number.isFinite(start) ? start : undefined,
      end: Number.isFinite(end) ? end : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
      offset: Number.isFinite(offset) ? offset : undefined,
      category,
      categories,
      symbol,
      preset,
      strategyVersion,
      blockedByBtc,
      btcState,
      unique,
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/signal/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const out = await getSignalById(id);
    if (!out) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, signal: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const days = Number((req.query as any)?.days);
    const start = Number((req.query as any)?.start);
    const end = Number((req.query as any)?.end);
    const category = String((req.query as any)?.category || '').trim() || undefined;
    const categoriesRaw = String((req.query as any)?.categories || '').trim();
    const categories = categoriesRaw ? categoriesRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const symbol = String((req.query as any)?.symbol || '').trim() || undefined;
    const preset = String((req.query as any)?.preset || '').trim() || undefined;
    const strategyVersion = String((req.query as any)?.version || '').trim() || undefined;
    const out = await getStats({
      days: Number.isFinite(days) ? days : undefined,
      start: Number.isFinite(start) ? start : undefined,
      end: Number.isFinite(end) ? end : undefined,
      category,
      categories,
      symbol,
      preset,
      strategyVersion,
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/stats/summary', async (req, res) => {
  try {
    const days = Number((req.query as any)?.days);
    const start = Number((req.query as any)?.start);
    const end = Number((req.query as any)?.end);
    const category = String((req.query as any)?.category || '').trim() || undefined;
    const categoriesRaw = String((req.query as any)?.categories || '').trim();
    const categories = categoriesRaw ? categoriesRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const symbol = String((req.query as any)?.symbol || '').trim() || undefined;
    const preset = String((req.query as any)?.preset || '').trim() || undefined;
    const strategyVersion = String((req.query as any)?.version || '').trim() || undefined;
    const blockedByBtcRaw = String((req.query as any)?.blockedByBtc || '').toLowerCase();
    const blockedByBtc = ['1', 'true', 'yes'].includes(blockedByBtcRaw) ? true
      : ['0', 'false', 'no'].includes(blockedByBtcRaw) ? false : undefined;
    const btcState = String((req.query as any)?.btcState || '').trim() || undefined;
    const horizonMin = Number((req.query as any)?.horizonMin);

    const out = await getStatsSummary({
      days: Number.isFinite(days) ? days : undefined,
      start: Number.isFinite(start) ? start : undefined,
      end: Number.isFinite(end) ? end : undefined,
      category,
      categories,
      symbol,
      preset,
      strategyVersion,
      blockedByBtc,
      btcState,
      horizonMin: Number.isFinite(horizonMin) ? horizonMin : undefined,
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/api/stats/matrix/btc', async (req, res) => {
  try {
    const days = Number((req.query as any)?.days);
    const start = Number((req.query as any)?.start);
    const end = Number((req.query as any)?.end);
    const category = String((req.query as any)?.category || '').trim() || undefined;
    const categoriesRaw = String((req.query as any)?.categories || '').trim();
    const categories = categoriesRaw ? categoriesRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const symbol = String((req.query as any)?.symbol || '').trim() || undefined;
    const preset = String((req.query as any)?.preset || '').trim() || undefined;
    const strategyVersion = String((req.query as any)?.version || '').trim() || undefined;
    const blockedByBtcRaw = String((req.query as any)?.blockedByBtc || '').toLowerCase();
    const blockedByBtc = ['1', 'true', 'yes'].includes(blockedByBtcRaw) ? true
      : ['0', 'false', 'no'].includes(blockedByBtcRaw) ? false : undefined;
    const btcState = String((req.query as any)?.btcState || '').trim() || undefined;
    const horizonMin = Number((req.query as any)?.horizonMin);

    const out = await getStatsMatrixBtc({
      days: Number.isFinite(days) ? days : undefined,
      start: Number.isFinite(start) ? start : undefined,
      end: Number.isFinite(end) ? end : undefined,
      category,
      categories,
      symbol,
      preset,
      strategyVersion,
      blockedByBtc,
      btcState,
      horizonMin: Number.isFinite(horizonMin) ? horizonMin : undefined,
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/api/stats/buckets', async (req, res) => {
  try {
    const days = Number((req.query as any)?.days);
    const start = Number((req.query as any)?.start);
    const end = Number((req.query as any)?.end);
    const category = String((req.query as any)?.category || '').trim() || undefined;
    const categoriesRaw = String((req.query as any)?.categories || '').trim();
    const categories = categoriesRaw ? categoriesRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const symbol = String((req.query as any)?.symbol || '').trim() || undefined;
    const preset = String((req.query as any)?.preset || '').trim() || undefined;
    const strategyVersion = String((req.query as any)?.version || '').trim() || undefined;
    const blockedByBtcRaw = String((req.query as any)?.blockedByBtc || '').toLowerCase();
    const blockedByBtc = ['1', 'true', 'yes'].includes(blockedByBtcRaw) ? true
      : ['0', 'false', 'no'].includes(blockedByBtcRaw) ? false : undefined;
    const btcState = String((req.query as any)?.btcState || '').trim() || undefined;
    const horizonMin = Number((req.query as any)?.horizonMin);

    const out = await getStatsBuckets({
      days: Number.isFinite(days) ? days : undefined,
      start: Number.isFinite(start) ? start : undefined,
      end: Number.isFinite(end) ? end : undefined,
      category,
      categories,
      symbol,
      preset,
      strategyVersion,
      blockedByBtc,
      btcState,
      horizonMin: Number.isFinite(horizonMin) ? horizonMin : undefined,
    });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/api/stats/invalidReasons', async (req, res) => {
  try {
    const days = Number((req.query as any)?.days);
    const start = Number((req.query as any)?.start);
    const end = Number((req.query as any)?.end);
    const category = String((req.query as any)?.category || '').trim() || undefined;
    const categoriesRaw = String((req.query as any)?.categories || '').trim();
    const categories = categoriesRaw ? categoriesRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const symbol = String((req.query as any)?.symbol || '').trim() || undefined;
    const preset = String((req.query as any)?.preset || '').trim() || undefined;
    const strategyVersion = String((req.query as any)?.version || '').trim() || undefined;
    const blockedByBtcRaw = String((req.query as any)?.blockedByBtc || '').toLowerCase();
    const blockedByBtc = ['1', 'true', 'yes'].includes(blockedByBtcRaw) ? true
      : ['0', 'false', 'no'].includes(blockedByBtcRaw) ? false : undefined;
    const btcState = String((req.query as any)?.btcState || '').trim() || undefined;
    const horizonMin = Number((req.query as any)?.horizonMin);

    const out = await getInvalidReasons({
      days: Number.isFinite(days) ? days : undefined,
      start: Number.isFinite(start) ? start : undefined,
      end: Number.isFinite(end) ? end : undefined,
      category,
      categories,
      symbol,
      preset,
      strategyVersion,
      blockedByBtc,
      btcState,
      horizonMin: Number.isFinite(horizonMin) ? horizonMin : undefined,
    });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/api/stats/versions', async (_req, res) => {
  try {
    const out = await listStrategyVersions();
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/api/stats/health', async (req, res) => {
  try {
    const enabled = process.env.ENABLE_STATS_HEALTH === '1';
    if (!enabled) return res.status(404).json({ ok: false, error: 'Not found' });
    const token = process.env.ADMIN_TOKEN;
    if (token) {
      const got = req.header('x-admin-token');
      if (got !== token) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    const days = Number((req.query as any)?.days);
    const out = await getStatsHealth({ days: Number.isFinite(days) ? days : undefined });
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/api/outcomes', async (req, res) => {
  try {
    const days = Number((req.query as any)?.days);
    const start = Number((req.query as any)?.start);
    const end = Number((req.query as any)?.end);
    const limit = Number((req.query as any)?.limit);
    const offset = Number((req.query as any)?.offset);
    const category = String((req.query as any)?.category || '').trim() || undefined;
    const categoriesRaw = String((req.query as any)?.categories || '').trim();
    const categories = categoriesRaw ? categoriesRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const symbol = String((req.query as any)?.symbol || '').trim() || undefined;
    const preset = String((req.query as any)?.preset || '').trim() || undefined;
    const strategyVersion = String((req.query as any)?.version || '').trim() || undefined;
    const blockedByBtcRaw = String((req.query as any)?.blockedByBtc || '').toLowerCase();
    const blockedByBtc = ['1', 'true', 'yes'].includes(blockedByBtcRaw) ? true
      : ['0', 'false', 'no'].includes(blockedByBtcRaw) ? false : undefined;
    const btcState = String((req.query as any)?.btcState || '').trim() || undefined;
    const horizonMin = Number((req.query as any)?.horizonMin);
    const windowStatus = String((req.query as any)?.windowStatus || '').trim() || undefined;
    const result = String((req.query as any)?.result || '').trim() || undefined;
    const invalidReason = String((req.query as any)?.invalidReason || '').trim() || undefined;
    const sort = String((req.query as any)?.sort || '').trim() || undefined;

    const out = await listOutcomes({
      days: Number.isFinite(days) ? days : undefined,
      start: Number.isFinite(start) ? start : undefined,
      end: Number.isFinite(end) ? end : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
      offset: Number.isFinite(offset) ? offset : undefined,
      category,
      categories,
      symbol,
      preset,
      strategyVersion,
      blockedByBtc,
      btcState,
      horizonMin: Number.isFinite(horizonMin) ? horizonMin : undefined,
      windowStatus,
      result,
      invalidReason,
      sort,
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.delete('/api/outcomes', async (req, res) => {
  try {
    const days = Number((req.query as any)?.days);
    const start = Number((req.query as any)?.start);
    const end = Number((req.query as any)?.end);
    const category = String((req.query as any)?.category || '').trim() || undefined;
    const categoriesRaw = String((req.query as any)?.categories || '').trim();
    const categories = categoriesRaw ? categoriesRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const symbol = String((req.query as any)?.symbol || '').trim() || undefined;
    const preset = String((req.query as any)?.preset || '').trim() || undefined;
    const strategyVersion = String((req.query as any)?.version || '').trim() || undefined;
    const blockedByBtcRaw = String((req.query as any)?.blockedByBtc || '').toLowerCase();
    const blockedByBtc = ['1', 'true', 'yes'].includes(blockedByBtcRaw) ? true
      : ['0', 'false', 'no'].includes(blockedByBtcRaw) ? false : undefined;
    const horizonMin = Number((req.query as any)?.horizonMin);
    const windowStatus = String((req.query as any)?.windowStatus || '').trim() || undefined;
    const result = String((req.query as any)?.result || '').trim() || undefined;

    const deleted = await deleteOutcomesByFilter({
      days: Number.isFinite(days) ? days : undefined,
      start: Number.isFinite(start) ? start : undefined,
      end: Number.isFinite(end) ? end : undefined,
      category,
      categories,
      symbol,
      preset,
      strategyVersion,
      blockedByBtc,
      horizonMin: Number.isFinite(horizonMin) ? horizonMin : undefined,
      windowStatus,
      result,
    });
    res.json({ ok: true, deleted });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post('/api/outcomes/rebuild', async (req, res) => {
  try {
    const days = Number((req.query as any)?.days);
    const start = Number((req.query as any)?.start);
    const end = Number((req.query as any)?.end);
    const category = String((req.query as any)?.category || '').trim() || undefined;
    const categoriesRaw = String((req.query as any)?.categories || '').trim();
    const categories = categoriesRaw ? categoriesRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const symbol = String((req.query as any)?.symbol || '').trim() || undefined;
    const preset = String((req.query as any)?.preset || '').trim() || undefined;
    const strategyVersion = String((req.query as any)?.version || '').trim() || undefined;
    const blockedByBtcRaw = String((req.query as any)?.blockedByBtc || '').toLowerCase();
    const blockedByBtc = ['1', 'true', 'yes'].includes(blockedByBtcRaw) ? true
      : ['0', 'false', 'no'].includes(blockedByBtcRaw) ? false : undefined;
    const horizonMin = Number((req.query as any)?.horizonMin);
    const result = String((req.query as any)?.result || '').trim() || undefined;

    const rebuilt = await rebuildOutcomesByFilter({
      days: Number.isFinite(days) ? days : undefined,
      start: Number.isFinite(start) ? start : undefined,
      end: Number.isFinite(end) ? end : undefined,
      category,
      categories,
      symbol,
      preset,
      strategyVersion,
      blockedByBtc,
      horizonMin: Number.isFinite(horizonMin) ? horizonMin : undefined,
      result,
    });
    res.json({ ok: true, rebuilt });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post('/api/outcomes/delete', async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const cleaned = items
      .map((it: any) => ({
        signalId: Number(it?.signalId),
        horizonMin: Number(it?.horizonMin),
      }))
      .filter((it: any) => Number.isFinite(it.signalId) && Number.isFinite(it.horizonMin));

    const deleted = await deleteOutcomesBulk(cleaned);
    res.json({ ok: true, deleted });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post('/api/signals/clear', async (_req, res) => {
  try {
    const out = await clearAllSignalsData();
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Serve frontend build
const feRoot = path.join(__dirname, '../../frontend/dist');
app.use(express.static(feRoot));
app.get('*', (_req, res) => {
  res.sendFile(path.join(feRoot, 'index.html'));
});

// Server
const port = parseInt(process.env.PORT || '8080', 10);
app.listen(port, () => console.log(`Server on http://localhost:${port}`));

function logRegisteredRoutes() {
  const stack = (app as any)?._router?.stack || [];
  const out: string[] = [];

  for (const layer of stack) {
    if (layer?.route?.path && layer?.route?.methods) {
      const methods = Object.keys(layer.route.methods)
        .filter(m => layer.route.methods[m])
        .map(m => m.toUpperCase())
        .join(',');
      out.push(`${methods} ${layer.route.path}`);
    } else if (layer?.name === 'router' && Array.isArray(layer?.handle?.stack)) {
      for (const child of layer.handle.stack) {
        if (child?.route?.path && child?.route?.methods) {
          const methods = Object.keys(child.route.methods)
            .filter(m => child.route.methods[m])
            .map(m => m.toUpperCase())
            .join(',');
          out.push(`${methods} ${child.route.path}`);
        }
      }
    }
  }

  console.log('[routes] registered');
  for (const line of out) console.log(`[routes] ${line}`);
}

logRegisteredRoutes();

// ✅ Server background loop OFF by default (prevents double-scanning)
// Auto-enable on Railway unless explicitly disabled.
const railwayDetected = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
const serverLoopDefault = railwayDetected ? 'true' : 'false';
const SERVER_LOOP_ENABLED = (process.env.SERVER_LOOP_ENABLED ?? serverLoopDefault).toLowerCase() === 'true';
if (SERVER_LOOP_ENABLED) {
  console.log('[scan] server loop enabled');
  startLoop(async (signals) => {
    try {
      for (const sig of signals) await recordSignal(sig as any, undefined);
    } catch (e) {
      console.warn('[signals] record failed (loop):', e);
    }
  });
} else {
  console.log('[scan] server loop disabled (SERVER_LOOP_ENABLED=false)');
}

// Outcomes updater (safe to run even if no signals yet)
startOutcomeUpdater();

export { app };
