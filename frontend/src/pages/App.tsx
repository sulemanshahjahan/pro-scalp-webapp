import { useEffect, useState, useRef, type ChangeEvent } from 'react';

import { useStore } from '../state/store'
import { getBtcMarket, getSystemHealth, scanNow } from '../services/api'
import SignalCard from '../components/SignalCard'
import { enablePush, disablePush } from '../services/push'
import StatsPage from '../pages/StatsPage'
import TunePage from '../pages/TunePage'
import TuningBundlesPage from '../pages/TuningBundlesPage'
import { enableSoundSync, isSoundEnabled } from '../services/sound'
import { playAlert } from '../services/sound'

type StorePreset = 'Conservative' | 'Balanced' | 'Aggressive';
type ApiPreset   = 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE';

const toApiPreset = (p: StorePreset): ApiPreset =>
  p === 'Conservative' ? 'CONSERVATIVE'
  : p === 'Balanced'   ? 'BALANCED'
  : 'AGGRESSIVE';

type Route = 'home' | 'stats' | 'tune' | 'bundles';
function getInitialRoute(): Route {
  if (window.location.pathname === '/stats') return 'stats';
  if (window.location.pathname === '/tune') return 'tune';
  if (window.location.pathname === '/bundles') return 'bundles';
  return 'home';
}
function navigate(to: Route) {
  const path = to === 'stats'
    ? '/stats'
    : to === 'tune'
      ? '/tune'
      : to === 'bundles'
        ? '/bundles'
        : '/';
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export default function App() {
  const [route, setRoute] = useState<Route>(getInitialRoute());
  useEffect(() => {
    const onPop = () => setRoute(getInitialRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  if (route === 'stats') {
    return (
      <div className="min-h-dvh px-3 pb-24 max-w-[90%] mx-auto">
        <header className="sticky top-0 bg-bg/70 backdrop-blur z-10 py-3 border-b border-white/5">
          <div className="flex items-center justify-between">
            <div className="text-xl font-semibold">Pro Scalp</div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => navigate('bundles')}
                className="px-3 py-1 rounded-xl bg-white/10 hover:bg-white/15"
              >
                Bundles
              </button>
              <button
                onClick={() => navigate('tune')}
                className="px-3 py-1 rounded-xl bg-white/10 hover:bg-white/15"
              >
                Tune
              </button>
              <button
                onClick={() => navigate('home')}
                className="px-3 py-1 rounded-xl bg-white/10 hover:bg-white/15"
              >
                Home
              </button>
            </div>
          </div>
          <div className="mt-1 text-xs text-white/60">
            Stats = logged signals + outcomes after 30m/60m/4h.
          </div>
        </header>

        <StatsPage />
      </div>
    );
  }

  if (route === 'tune') {
    return (
      <div className="min-h-dvh px-3 pb-24 max-w-[90%] mx-auto">
        <header className="sticky top-0 bg-bg/70 backdrop-blur z-10 py-3 border-b border-white/5">
          <div className="flex items-center justify-between">
            <div className="text-xl font-semibold">Pro Scalp</div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => navigate('bundles')}
                className="px-3 py-1 rounded-xl bg-white/10 hover:bg-white/15"
              >
                Bundles
              </button>
              <button
                onClick={() => navigate('stats')}
                className="px-3 py-1 rounded-xl bg-white/10 hover:bg-white/15"
              >
                Stats
              </button>
              <button
                onClick={() => navigate('home')}
                className="px-3 py-1 rounded-xl bg-white/10 hover:bg-white/15"
              >
                Home
              </button>
            </div>
          </div>
          <div className="mt-1 text-xs text-white/60">
            Tune = replay gates from stored feature snapshots.
          </div>
        </header>

        <TunePage />
      </div>
    );
  }

  if (route === 'bundles') {
    return (
      <div className="min-h-dvh px-3 pb-24 max-w-[90%] mx-auto">
        <header className="sticky top-0 bg-bg/70 backdrop-blur z-10 py-3 border-b border-white/5">
          <div className="flex items-center justify-between">
            <div className="text-xl font-semibold">Pro Scalp</div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => navigate('stats')}
                className="px-3 py-1 rounded-xl bg-white/10 hover:bg-white/15"
              >
                Stats
              </button>
              <button
                onClick={() => navigate('tune')}
                className="px-3 py-1 rounded-xl bg-white/10 hover:bg-white/15"
              >
                Tune
              </button>
              <button
                onClick={() => navigate('home')}
                className="px-3 py-1 rounded-xl bg-white/10 hover:bg-white/15"
              >
                Home
              </button>
            </div>
          </div>
          <div className="mt-1 text-xs text-white/60">
            Bundles = periodic tuning reports and snapshots.
          </div>
        </header>

        <TuningBundlesPage />
      </div>
    );
  }

  const { set, lastScanAt, onlyBest, vwapDistancePct, volSpikeX, atrGuardPct, preset } = useStore()
  const [signals, setSignals] = useState<any[]>([])
  const [auto, setAuto] = useState(true)
  const [pushEnabled, setPushEnabled] = useState(false)
  const [soundOn, setSoundOn] = useState(isSoundEnabled());
  const [btcMarket, setBtcMarket] = useState<any | null>(null);
  const [btcAt, setBtcAt] = useState(0);
  const [health, setHealth] = useState<any | null>(null);
  const [nowTs, setNowTs] = useState(Date.now());

  // ✅ Prevent overlapping scans from UI
  const scanInFlight = useRef(false);

  // two sound group toggles (persisted)
  const [groupWatchOn, setGroupWatchOn] = useState(
    localStorage.getItem('ps_sound_group_watch') !== '0'
  );
  const [groupBuyOn, setGroupBuyOn] = useState(
    localStorage.getItem('ps_sound_group_buy') !== '0'
  );
  const groupWatchOnRef = useRef(groupWatchOn);
  const groupBuyOnRef = useRef(groupBuyOn);

  useEffect(() => {
    groupWatchOnRef.current = groupWatchOn;
    localStorage.setItem('ps_sound_group_watch', groupWatchOn ? '1' : '0');
  }, [groupWatchOn]);
  useEffect(() => {
    groupBuyOnRef.current = groupBuyOn;
    localStorage.setItem('ps_sound_group_buy', groupBuyOn ? '1' : '0');
  }, [groupBuyOn]);

  const seenKeys = useRef<Set<string>>(new Set());

  // STICKY cards: 5 minutes
  const STICKY_MS = 5 * 60_000;
  type CacheEntry = { s: any; firstSeenAt: number; lastSeenAt: number };
  const cacheRef = useRef<Map<string, CacheEntry>>(new Map());

  const PRESET_THRESHOLDS: Record<StorePreset, { vwapDistancePct: number; volSpikeX: number; atrGuardPct: number; }> = {
    Conservative: { vwapDistancePct: 0.20, volSpikeX: 2.0, atrGuardPct: 1.8 },
    Balanced:     { vwapDistancePct: 0.30, volSpikeX: 1.5, atrGuardPct: 2.5 },
    Aggressive:   { vwapDistancePct: 1.00, volSpikeX: 1.0, atrGuardPct: 4.0 },
  };

  function canPlayByGroup(cat: 'WATCH' | 'EARLY_READY' | 'READY_TO_BUY' | 'BEST_ENTRY') {
    if (cat === 'WATCH' || cat === 'EARLY_READY') return groupWatchOnRef.current;
    if (cat === 'READY_TO_BUY' || cat === 'BEST_ENTRY') return groupBuyOnRef.current;
    return true;
  }

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      const handler = (evt: MessageEvent) => {
        if (evt.data?.type === 'PLAY_SOUND') {
          const cat = evt.data?.category as 'WATCH' | 'READY_TO_BUY' | 'BEST_ENTRY' | 'EARLY_READY' | undefined;
          const finalCat = cat ?? 'BEST_ENTRY';
          if (canPlayByGroup(finalCat)) playAlert(finalCat);
        }
      };
      navigator.serviceWorker.addEventListener('message', handler);
      return () => navigator.serviceWorker.removeEventListener('message', handler);
    }
  }, []);

  useEffect(() => {
    let t: any;
    const load = async () => {
      try {
        const j = await getBtcMarket();
        if (j?.ok) {
          setBtcMarket(j.market ?? null);
          setBtcAt(j.at ?? 0);
        }
      } catch {
        // ignore
      }
    };
    load();
    t = setInterval(load, 60_000);
    return () => t && clearInterval(t);
  }, []);

  useEffect(() => {
    let t: any;
    const load = async () => {
      try {
        const j = await getSystemHealth();
        if (j?.ok) setHealth(j);
      } catch {
        // ignore
      }
    };
    load();
    t = setInterval(load, 60_000);
    return () => t && clearInterval(t);
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNowTs(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const onUnlocked = () => setSoundOn(true);
    window.addEventListener('sound-unlocked', onUnlocked as EventListener);
    return () => window.removeEventListener('sound-unlocked', onUnlocked as EventListener);
  }, []);

  useEffect(() => {
    const wanted = localStorage.getItem('ps_soundWanted') === '1';
    if (wanted) setSoundOn(true);
    if (wanted && !isSoundEnabled()) {
      const tryUnlock = () => {
        enableSoundSync();
        document.removeEventListener('pointerdown', tryUnlock, true);
        document.removeEventListener('keydown', tryUnlock, true);
      };
      document.addEventListener('pointerdown', tryUnlock, true);
      document.addEventListener('keydown', tryUnlock, true);
      return () => {
        document.removeEventListener('pointerdown', tryUnlock, true);
        document.removeEventListener('keydown', tryUnlock, true);
      };
    }
  }, []);

  const [totals, setTotals] = useState({ watch: 0, early_ready: 0, ready: 0, best: 0 });

  const scanState = health?.scan?.state ?? 'IDLE';
  const scanMeta = health?.scan?.meta ?? null;
  const scanCurrent = health?.scan?.current ?? null;
  const scanLast = health?.scan?.last ?? null;
  const scanIntervalMs = Number(scanMeta?.intervalMs) || 240_000;
  const scanMaxMs = Number(scanMeta?.maxScanMs) || 4 * 60_000;
  const scanNextAt = Number(health?.scan?.nextScanAt) || null;
  const scanProgress = (() => {
    if (scanState === 'RUNNING' && scanCurrent?.startedAt) {
      const elapsed = Math.max(0, nowTs - Number(scanCurrent.startedAt));
      return Math.max(0, Math.min(0.99, elapsed / scanMaxMs));
    }
    if (scanState === 'COOLDOWN' && scanNextAt) {
      const remaining = Math.max(0, scanNextAt - nowTs);
      return Math.max(0, Math.min(1, 1 - (remaining / scanIntervalMs)));
    }
    if (scanLast?.finishedAt) return 1;
    return 0;
  })();
  const scanPct = Math.round(scanProgress * 100);
  const gateStats = scanLast?.gateStats ?? health?.scan?.gateStats ?? null;

  function topGateFailures(gateStats: any, kind: 'ready' | 'best') {
    if (!gateStats?.[kind]) return [];
    const labels: Record<string, string> = {
      failed_btc_gate: 'BTC not supportive',
      failed_confirm15: '15m confirmation missing',
      failed_trend: 'Trend not strong yet',
      failed_near_vwap: 'Price too far from VWAP',
      failed_volSpike: 'Volume spike missing',
      failed_atr: 'Price moving too much (ATR high)',
      failed_sweep: 'No liquidity sweep',
      failed_rr: 'Risk/Reward too low',
    };
    return Object.entries(gateStats[kind] as Record<string, number>)
      .filter(([, v]) => Number(v) > 0)
      .map(([k, v]) => ({ label: labels[k] || k, n: Number(v) }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 3);
  }

  const readyBearOverrideCount = signals.filter(
    (s) => s?.category === 'READY_TO_BUY' && s?.market?.btcBear15m === true
  ).length;

  async function doScan() {
    if (scanInFlight.current) return;
    scanInFlight.current = true;

    try {
      const storePreset = (useStore.getState().preset as StorePreset) || 'Balanced';
      const j = await scanNow(toApiPreset(storePreset));
      set({ lastScanAt: j.at });

      const now = Date.now();
      const incoming: any[] = j.signals || [];
      const seenThisScan = new Set<string>();

      for (const s of incoming) {
        const key = `${s.symbol}|${s.category}`;
        const prev = cacheRef.current.get(key);
        if (!prev) cacheRef.current.set(key, { s, firstSeenAt: now, lastSeenAt: now });
        else cacheRef.current.set(key, { s, firstSeenAt: prev.firstSeenAt, lastSeenAt: now });
        seenThisScan.add(key);
      }

      for (const [key, entry] of cacheRef.current) {
        const reappeared = seenThisScan.has(key);
        if (!reappeared && (now - entry.firstSeenAt >= STICKY_MS)) cacheRef.current.delete(key);
      }

      const merged = Array.from(cacheRef.current.values()).map(e => ({
        ...e.s,
        __firstSeenAt: e.firstSeenAt,
      }));

      setSignals(merged);

      for (const s of incoming) {
        const cat = s.category as 'WATCH' | 'READY_TO_BUY' | 'BEST_ENTRY' | 'EARLY_READY' | undefined;
        if (!cat) continue;

        const key = `${s.symbol}|${cat}|${s.time}`;
        if (!seenKeys.current.has(key)) {
          seenKeys.current.add(key);

          if (cat === 'WATCH') setTotals(t => ({ ...t, watch: t.watch + 1 }));
          else if (cat === 'EARLY_READY') setTotals(t => ({ ...t, early_ready: t.early_ready + 1 }));
          else if (cat === 'READY_TO_BUY') setTotals(t => ({ ...t, ready: t.ready + 1 }));
          else if (cat === 'BEST_ENTRY') setTotals(t => ({ ...t, best: t.best + 1 }));

          if (canPlayByGroup(cat)) playAlert(cat);
        }
      }

      if (seenKeys.current.size > 500) {
        const fresh = new Set<string>();
        for (const s of incoming) {
          const cat = s.category as string;
          if (!cat) continue;
          fresh.add(`${s.symbol}|${cat}|${s.time}`);
        }
        seenKeys.current = fresh;
      }
    } catch (e) {
      console.warn('[ui] scan failed:', e);
    } finally {
      scanInFlight.current = false;
    }
  }

  useEffect(() => {
    doScan();
    let t: any;
    if (auto) t = setInterval(doScan, 240_000); // ✅ 4 minutes
    return () => t && clearInterval(t);
  }, [auto]);

  function onPresetChange(e: ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value as StorePreset;
    const th = PRESET_THRESHOLDS[next];

    useStore.getState().set({
      preset: next,
      vwapDistancePct: th.vwapDistancePct,
      volSpikeX: th.volSpikeX,
      atrGuardPct: th.atrGuardPct
    });

    doScan();
    localStorage.setItem('preset', next);
  }

  return (
    <div className="min-h-dvh px-3 pb-24 max-w-[90%] mx-auto">
      <header className="sticky top-0 bg-bg/70 backdrop-blur z-10 py-3 border-b border-white/5">
        <div className="flex items-center justify-between">
          <div className="text-xl font-semibold">Pro Scalp</div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate('tune')}
              className="px-3 py-1 rounded-xl bg-white/10 hover:bg-white/15"
            >
              Tune
            </button>
            <button
              onClick={() => navigate('bundles')}
              className="px-3 py-1 rounded-xl bg-white/10 hover:bg-white/15"
            >
              Bundles
            </button>
            <button
              onClick={() => navigate('stats')}
              className="px-3 py-1 rounded-xl bg-white/10 hover:bg-white/15"
            >
              Stats
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between mt-2">
          <div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={onlyBest} onChange={(e)=>useStore.getState().set({onlyBest: e.target.checked})} />
              Only Best Entry
            </label>

            {!pushEnabled ? (
              <button onClick={async ()=>{ const ok = await enablePush(); setPushEnabled(ok) }} className="px-3 py-1 rounded-xl bg-success/20">
                Enable Push
              </button>
            ) : (
              <button onClick={async ()=>{ await disablePush(); setPushEnabled(false) }} className="px-3 py-1 rounded-xl bg-white/10">
                Disable Push
              </button>
            )}

            <button
              onClick={() => {
                const ok = enableSoundSync();
                setSoundOn(ok);
                alert(ok ? 'Sound enabled ✅' : '❌ Still blocked, click again');
              }}
              className="px-3 py-1 rounded-xl bg-white/10 hover:bg-white/15"
            >
              {soundOn ? 'Sound: ON' : 'Enable Sound'}
            </button>
          </div>

          <div className="text-xs text-white/70 text-right">
            Last scan: {lastScanAt ? new Date(lastScanAt).toLocaleTimeString() : '—'}
            <div className="mt-1">
              <div className="flex items-center justify-end gap-2 text-[10px] text-white/60">
                <span>Scan {String(scanState).toLowerCase()}</span>
                <span>{scanPct}%</span>
              </div>
              <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div
                  className={'h-1.5 ' + (scanState === 'RUNNING' ? 'bg-cyan-400/70' : scanState === 'COOLDOWN' ? 'bg-amber-400/70' : 'bg-emerald-400/70')}
                  style={{ width: scanPct + '%' }}
                />
              </div>
            </div>
            <br/>
            <span className="text-white/80">
              Watch: {totals.watch} | Early: {totals.early_ready} | Ready: {totals.ready} | Best: {totals.best}
            </span>
            <br/>
            <span className="text-white/70">
              BTC 15m:{' '}
              {btcMarket
                ? (btcMarket.btcBull15m ? 'Bull' : (btcMarket.btcBear15m ? 'Bear' : 'Neutral'))
                : '—'}
              {btcMarket ? ` | ΔVWAP ${Number(btcMarket.btcDeltaVwapPct15m).toFixed(2)}% | RSI ${Number(btcMarket.btcRsi9_15m).toFixed(1)}` : ''}
            </span>
            {btcAt ? (
              <div className="text-[10px] text-white/50">
                BTC updated {new Date(btcAt).toLocaleTimeString()}
              </div>
            ) : null}
          </div>
        </div>

        {(signals.every(s => s.category !== 'READY_TO_BUY' && s.category !== 'BEST_ENTRY')) ? (
          <div className="mt-2 text-xs text-white/70">
            <div className="text-white/60">No Ready/Best yet — top reasons (last scan):</div>
            <div className="mt-1 flex flex-wrap gap-2">
              {topGateFailures(gateStats, 'ready').map((g) => (
                <span key={`ready-${g.label}`} className="px-2 py-0.5 rounded-lg border border-white/10 bg-white/5">
                  Ready: {g.label} ({g.n})
                </span>
              ))}
              {topGateFailures(gateStats, 'best').map((g) => (
                <span key={`best-${g.label}`} className="px-2 py-0.5 rounded-lg border border-white/10 bg-white/5">
                  Best: {g.label} ({g.n})
                </span>
              ))}
              {(!gateStats || (!topGateFailures(gateStats, 'ready').length && !topGateFailures(gateStats, 'best').length)) ? (
                <span className="text-white/50">Waiting for scan stats…</span>
              ) : null}
            </div>
          </div>
        ) : null}

        {readyBearOverrideCount > 0 ? (
          <div className="mt-1 text-[11px] text-amber-200">
            Ready signals using BTC Bear override: {readyBearOverrideCount}
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2 mt-2">
          <button
            onClick={() => setGroupWatchOn(v => !v)}
            className={`px-3 py-1 rounded-xl ${groupWatchOn ? 'bg-blue-500/20 hover:bg-blue-500/30' : 'bg-white/10 hover:bg-white/15'}`}
          >
            {groupWatchOn ? '🔔 Watch/Early: ON' : '🔕 Watch/Early: OFF'}
          </button>

          <button
            onClick={() => setGroupBuyOn(v => !v)}
            className={`px-3 py-1 rounded-xl ${groupBuyOn ? 'bg-green-500/20 hover:bg-green-500/30' : 'bg-white/10 hover:bg-white/15'}`}
          >
            {groupBuyOn ? '🔔 Ready/Best: ON' : '🔕 Ready/Best: OFF'}
          </button>
        </div>
      </header>

      <section className="sticky top-16 bg-bg/80 backdrop-blur z-10 py-3 border-b border-white/5">
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
          <div>VWAP dist ≤ <b>{vwapDistancePct}%</b></div>
          <div>Vol spike ≥ <b>{volSpikeX}×</b></div>
          <div>ATR% ≤ <b>{atrGuardPct}%</b></div>

          <div>
            <select
              value={preset}
              onChange={onPresetChange}
              className="bg-white/10 border border-white/10 rounded px-2 py-1"
            >
              <option value="Conservative">Conservative</option>
              <option value="Balanced">Balanced</option>
              <option value="Aggressive">Aggressive</option>
            </select>
          </div>

          <div>
            <button onClick={() => doScan()} className="px-3 py-1 rounded-xl bg-accent/20">Scan Now</button>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={auto} onChange={(e)=>setAuto(e.target.checked)} />
              Auto-Scan
            </label>
          </div>
        </div>
        <div className="mt-2 text-xs text-white/60">Auto-scan is 4 minutes to avoid Binance throttling.</div>
      </section>

      <main className="mt-4 space-y-6">
        {grouped(signals, useStore.getState().onlyBest).map(([title, list]) => (
          <section key={title}>
            <h2 className="text-lg font-semibold mb-2">{title}</h2>
            <div className="grid gap-3">
              {list.map((s: any) => (
                <SignalCard key={`${s.symbol}-${s.category}`} s={s} />
              ))}
            </div>
          </section>
        ))}
        {signals.length === 0 && <div className="text-white/60 text-sm">No signals yet. Try Scan Now and check backend console for 429 counts.</div>}
      </main>
    </div>
  )
}

function grouped(sigs: any[], onlyBest: boolean) {
  const best  = sigs.filter(s => s.category === 'BEST_ENTRY')
  const ready = onlyBest ? [] : sigs.filter(s => s.category === 'READY_TO_BUY')
  const early = onlyBest ? [] : sigs.filter(s => s.category === 'EARLY_READY')
  const watch = onlyBest ? [] : sigs.filter(s => s.category === 'WATCH')
  const out: [string, any[]][] = []
  if (best.length) out.push(['Best Entry', best])
  if (ready.length) out.push(['Ready to BUY', ready])
  if (early.length) out.push(['Early Ready (½ size)', early])
  if (watch.length) out.push(['Pre-BUY Watch', watch])
  return out
}
