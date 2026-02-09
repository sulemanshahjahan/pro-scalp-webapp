import crypto from 'crypto';

export const CONFIG_ENV_KEYS = [
  'READY_BTC_REQUIRED',
  'READY_CONFIRM15_REQUIRED',
  'READY_TREND_REQUIRED',
  'READY_VOL_SPIKE_REQUIRED',
  'READY_SWEEP_REQUIRED',
  'READY_RECLAIM_REQUIRED',
  'READY_VWAP_MAX_PCT',
  'READY_VWAP_EPS_PCT',
  'READY_VWAP_TOUCH_PCT',
  'READY_VWAP_TOUCH_BARS',
  'READY_BODY_PCT',
  'READY_CLOSE_POS_MIN',
  'READY_UPPER_WICK_MAX',
  'READY_EMA_EPS_PCT',
  'WATCH_EMA_EPS_PCT',
  'RSI_READY_MIN',
  'RSI_READY_MAX',
  'RSI_EARLY_MIN',
  'RSI_EARLY_MAX',
  'RSI_DELTA_STRICT',
  'CONFIRM15_VWAP_EPS_PCT',
  'CONFIRM15_VWAP_ROLL_BARS',
  'BEST_BTC_REQUIRED',
  'BEST_VWAP_MAX_PCT',
  'BEST_VWAP_EPS_PCT',
  'BEST_EMA_EPS_PCT',
  'RSI_BEST_MIN',
  'RSI_BEST_MAX',
  'RR_MIN_BEST',
  'MIN_BODY_PCT',
  'MIN_ATR_PCT',
  'MIN_RISK_PCT',
  'SESSION_FILTER_ENABLED',
  'SESSIONS_UTC',
  'SCAN_INTERVAL_MS',
];

const SECRET_ENV_RE = /(TOKEN|KEY|SECRET|PASSWORD|DATABASE|URL)/i;

export function parseEnvValue(raw: string) {
  const v = String(raw).trim();
  if (!v) return v;
  if (v.toLowerCase() === 'true') return true;
  if (v.toLowerCase() === 'false') return false;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  return v;
}

export function safeEnvSnapshot(keys: string[] = CONFIG_ENV_KEYS) {
  const out: Record<string, string | number | boolean> = {};
  for (const key of keys) {
    if (!(key in process.env)) continue;
    if (SECRET_ENV_RE.test(key)) continue;
    const raw = String(process.env[key]);
    out[key] = parseEnvValue(raw) as string | number | boolean;
  }
  return out;
}

export function buildConfigSnapshot(params: {
  preset: string | null | undefined;
  thresholds: { vwapDistancePct?: number | null; volSpikeX?: number | null; atrGuardPct?: number | null };
  buildGitSha?: string | null;
  env?: Record<string, any>;
}) {
  const env = params.env ?? safeEnvSnapshot();
  return {
    preset: params.preset ?? null,
    env,
    thresholds: {
      vwapDistancePct: params.thresholds?.vwapDistancePct ?? null,
      volSpikeX: params.thresholds?.volSpikeX ?? null,
      atrGuardPct: params.thresholds?.atrGuardPct ?? null,
    },
    build: { gitSha: params.buildGitSha ?? null },
  };
}

export function stableStringify(obj: any): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function computeConfigHash(snapshot: { preset?: any; env?: any; thresholds?: any }) {
  const payload = {
    preset: snapshot?.preset ?? null,
    env: snapshot?.env ?? {},
    thresholds: snapshot?.thresholds ?? {},
  };
  const stable = stableStringify(payload);
  return crypto.createHash('sha256').update(stable).digest('hex');
}
