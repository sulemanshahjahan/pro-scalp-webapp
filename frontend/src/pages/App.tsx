import { useEffect, useState, useRef } from 'react';
// ❌ avoid: import React from 'react' then React.useEffect(...)

import { useStore } from '../state/store'
import { scanNow, debugPush } from '../services/api'
import SignalCard from '../components/SignalCard'
import { enablePush, disablePush } from '../services/push'

import { enableSoundSync, isSoundEnabled } from '../services/sound'
import { playAlert } from '../services/sound';

type StorePreset = 'Conservative' | 'Balanced' | 'Aggressive';
type ApiPreset   = 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE';

const toApiPreset = (p: StorePreset): ApiPreset =>
  p === 'Conservative' ? 'CONSERVATIVE'
  : p === 'Balanced'   ? 'BALANCED'
  : 'AGGRESSIVE';
  
export default function App() {
  const { set, lastScanAt, onlyBest, vwapDistancePct, volSpikeX, atrGuardPct, preset } = useStore()
  const [signals, setSignals] = useState<any[]>([])
  const [auto, setAuto] = useState(true)
  const [pushEnabled, setPushEnabled] = useState(false)
  const [soundOn, setSoundOn] = useState(isSoundEnabled());

  // ➕ NEW: two sound group toggles (persisted)
  const [groupWatchOn, setGroupWatchOn] = useState(
    localStorage.getItem('ps_sound_group_watch') !== '0' // default ON
  );
  const [groupBuyOn, setGroupBuyOn] = useState(
    localStorage.getItem('ps_sound_group_buy') !== '0' // default ON
  );
  const groupWatchOnRef = useRef(groupWatchOn);
  const groupBuyOnRef = useRef(groupBuyOn);

  // keep refs synced & persist to localStorage
  useEffect(() => {
    groupWatchOnRef.current = groupWatchOn;
    localStorage.setItem('ps_sound_group_watch', groupWatchOn ? '1' : '0');
  }, [groupWatchOn]);
  useEffect(() => {
    groupBuyOnRef.current = groupBuyOn;
    localStorage.setItem('ps_sound_group_buy', groupBuyOn ? '1' : '0');
  }, [groupBuyOn]);

  // ➕ remember what we've already alerted for (symbol+category+price)
  const seenKeys = useRef<Set<string>>(new Set());

  // ➕ STICKY CARDS: cache entries for 5 minutes after first appearance
  const STICKY_MS = 30 * 60_000; // 5 minutes
  type CacheEntry = { s: any; firstSeenAt: number; lastSeenAt: number };
  const cacheRef = useRef<Map<string, CacheEntry>>(new Map()); // key: symbol|category

  // ---- preset thresholds (UI reflects active preset) ------------
  type Preset = 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE';
  const PRESET_THRESHOLDS: Record<StorePreset, { vwapDistancePct: number; volSpikeX: number; atrGuardPct: number; }> = {
    Conservative: { vwapDistancePct: 0.20, volSpikeX: 2.0, atrGuardPct: 1.5 },
    Balanced:     { vwapDistancePct: 0.30, volSpikeX: 1.5, atrGuardPct: 2.0 },
    Aggressive:   { vwapDistancePct: 1.00, volSpikeX: 1.0, atrGuardPct: 4.0 },
  };
  // ---------------------------------------------------------------

  // helper: check if a category is allowed by current toggles
  function canPlayByGroup(cat: 'WATCH' | 'EARLY_READY' | 'READY_TO_BUY' | 'BEST_ENTRY') {
    if (cat === 'WATCH' || cat === 'EARLY_READY') return groupWatchOnRef.current;
    if (cat === 'READY_TO_BUY' || cat === 'BEST_ENTRY') return groupBuyOnRef.current;
    return true;
  }

  // 1) SW → page sound bridge (pass category)
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      const handler = (evt: MessageEvent) => {
        if (evt.data?.type === 'PLAY_SOUND') {
          const cat = evt.data?.category as 'WATCH' | 'READY_TO_BUY' | 'BEST_ENTRY' | 'EARLY_READY' | undefined;
          const finalCat = cat ?? 'BEST_ENTRY';
          if (canPlayByGroup(finalCat)) {
            playAlert(finalCat);
          }
        }
      };
      navigator.serviceWorker.addEventListener('message', handler);
      return () => navigator.serviceWorker.removeEventListener('message', handler);
    }
  }, []);

  // 2) Flip UI ON when sound truly unlocks
  useEffect(() => {
    const onUnlocked = () => setSoundOn(true);
    window.addEventListener('sound-unlocked', onUnlocked as EventListener);
    return () => window.removeEventListener('sound-unlocked', onUnlocked as EventListener);
  }, []);

  // 3) Rehydrate SOUND preference & auto-unlock on first interaction each session
  useEffect(() => {
    const wanted = localStorage.getItem('ps_soundWanted') === '1';
    if (wanted) setSoundOn(true); // show ON immediately
    if (wanted && !isSoundEnabled()) {
      const tryUnlock = () => {
        enableSoundSync(); // dispatches 'sound-unlocked' when ready
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

  // ➕ NEW (cumulative session totals)
  const [totals, setTotals] = useState({ watch: 0, early_ready: 0,ready: 0, best: 0 });

  // ---- SCAN (uses current preset) + STICKY merge ----------------
  async function doScan() {
    const storePreset = (useStore.getState().preset as StorePreset) || 'Balanced';
    const j = await scanNow(toApiPreset(storePreset)); // map to API preset
    set({ lastScanAt: j.at });

    const now = Date.now();
    const incoming: any[] = j.signals || [];
    const seenThisScan = new Set<string>();

    // Merge incoming into sticky cache (keyed by symbol|category)
    for (const s of incoming) {
      const key = `${s.symbol}|${s.category}`;
      const prev = cacheRef.current.get(key);
      if (!prev) {
        cacheRef.current.set(key, { s, firstSeenAt: now, lastSeenAt: now });
      } else {
        cacheRef.current.set(key, {
          s,
          firstSeenAt: prev.firstSeenAt, // keep original first-seen for age
          lastSeenAt: now,
        });
      }
      seenThisScan.add(key);
    }

    // Purge entries that haven't reappeared AND exceeded sticky window
    for (const [key, entry] of cacheRef.current) {
      const reappeared = seenThisScan.has(key);
      if (!reappeared && (now - entry.firstSeenAt >= STICKY_MS)) {
        cacheRef.current.delete(key);
      }
    }

    // Build UI list and attach __firstSeenAt for age display
    const merged = Array.from(cacheRef.current.values()).map(e => ({
      ...e.s,
      __firstSeenAt: e.firstSeenAt,
    }));

    setSignals(merged);

    // In-app alert for *new* signals (same as before) — gated by toggles
    const nowList: any[] = incoming;
    for (const s of nowList) {
      const cat = s.category as 'WATCH' | 'READY_TO_BUY' | 'BEST_ENTRY' | 'EARLY_READY' | undefined
      if (!cat) continue
      const key = `${s.symbol}|${cat}|${s.price}`
      if (!seenKeys.current.has(key)) {
        seenKeys.current.add(key)

        // ✅ increment session totals only for categories requested
        if (cat === 'WATCH') {
          setTotals(t => ({ ...t, watch: t.watch + 1 }));
        } else if (cat === 'EARLY_READY') {
          setTotals(t => ({ ...t, early_ready: t.early_ready + 1 }));
        }else if (cat === 'READY_TO_BUY') {
          setTotals(t => ({ ...t, ready: t.ready + 1 }));
        } else if (cat === 'BEST_ENTRY') {
          setTotals(t => ({ ...t, best: t.best + 1 }));
        }

        if (canPlayByGroup(cat)) {
          playAlert(cat)
        }
        if (Notification.permission === 'granted') {
          try {
            new Notification(`${cat} ${s.symbol}`, {
              body: `@ ${s.price}`,
              tag: `sig-${s.symbol}-${cat}`, // coalesce duplicates
            })
          } catch {}
        }
      }
    }
    if (seenKeys.current.size > 500) {
      const fresh = new Set<string>()
      for (const s of nowList) {
        const cat = s.category as string
        if (!cat) continue
        fresh.add(`${s.symbol}|${cat}|${s.price}`)
      }
      seenKeys.current = fresh
    }
  }
  // ---------------------------------------------------------------

  useEffect(() => {
    doScan()
    let t: any
    if (auto) t = setInterval(doScan, 60_000)
    return () => t && clearInterval(t)
  }, [auto])

  // ---- preset selector handler updates store + thresholds --------
  function onPresetChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value as StorePreset; // title-case
    const th = PRESET_THRESHOLDS[next];

    useStore.getState().set({
      preset: next,
      vwapDistancePct: th.vwapDistancePct,
      volSpikeX: th.volSpikeX,
      atrGuardPct: th.atrGuardPct
    });

    // trigger scan with the new preset
    doScan();
    localStorage.setItem('preset', next);
  }
  // ----------------------------------------------------------------

  return (
    <div className="min-h-dvh px-3 pb-24 max-w-4xl mx-auto">
      <header className="sticky top-0 bg-bg/70 backdrop-blur z-10 py-3 border-b border-white/5">
        <div className="flex items-center justify-between">
          <div className="text-xl font-semibold">Pro Scalp</div>
          <div className="text-xs text-white/70">
            Exchange: <span className="text-cyan-300">Binance</span><br/>
            Last scan: {lastScanAt ? new Date(lastScanAt).toLocaleTimeString() : '—'}
            <br/>
            <span className="text-white/80">
              Watch: {totals.watch}  &nbsp;|&nbsp; Early Ready: {totals.early_ready}  &nbsp;|&nbsp; Ready: {totals.ready} &nbsp;|&nbsp; Best: {totals.best}
            </span>
          
          
          </div>
        </div>
        <div className="flex items-center justify-between">
          <div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={onlyBest} onChange={(e)=>useStore.getState().set({onlyBest: e.target.checked})} /> Only Best Entry</label>
         {!pushEnabled ? (
            <button onClick={async ()=>{ const ok = await enablePush(); setPushEnabled(ok) }} className="px-3 py-1 rounded-xl bg-success/20">Enable Push</button> 
          ) : (
            <button onClick={async ()=>{ await disablePush(); setPushEnabled(false) }} className="px-3 py-1 rounded-xl bg-white/10">Disable Push</button>
        )} 

          {/* existing enable sound button */}
          <button
            onClick={() => {
              const ok = enableSoundSync();  // no async/await here!
              setSoundOn(ok);
              alert(ok ? 'Sound enabled ✅' : '❌ Still blocked, click again');
            }}
            className="px-3 py-1 rounded-xl bg-white/10 hover:bg-white/15"
          >
            {soundOn ? 'Sound: ON' : 'Enable Sound'}
          </button>
          </div>
          <div>
          {/* ➕ NEW: Two sound-group toggles */}
          <button
            onClick={() => setGroupWatchOn(v => !v)}
            className={`px-3 py-1 rounded-xl ${groupWatchOn ? 'bg-blue-500/20 hover:bg-blue-500/30' : 'bg-white/10 hover:bg-white/15'}`}
            title="Toggle sound for WATCH + EARLY_READY"
          >
            {groupWatchOn ? '🔔 Watch/Early: ONS' : '🔕 Watch/Early: OFF'}
          </button>

          <button
            onClick={() => setGroupBuyOn(v => !v)}
            className={`px-3 py-1 rounded-xl ${groupBuyOn ? 'bg-green-500/20 hover:bg-green-500/30' : 'bg-white/10 hover:bg-white/15'}`}
            title="Toggle sound for READY_TO_BUY + BEST_ENTRY"
          >
            {groupBuyOn ? '🔔 Ready/Best: ON' : '🔕 Ready/Best: OFF'}
          </button>
        </div>
        </div>
      </header>

      <section className="sticky top-16 bg-bg/80 backdrop-blur z-10 py-3 border-b border-white/5">
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
          <div>VWAP dist ≤ <b>{vwapDistancePct}%</b></div>
          <div>Vol spike ≥ <b>{volSpikeX}×</b></div>
          <div>ATR% ≤ <b>{atrGuardPct}%</b></div>
          {/* live preset selector */}
          <div >
          
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
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={auto} onChange={(e)=>setAuto(e.target.checked)} /> Auto-Scan</label>
          </div>
        </div>
        <div className="mt-2 text-xs text-white/60">Switch presets to tighten or loosen signals for 1–2% scalp entries.</div>
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
        {signals.length === 0 && <div className="text-white/60 text-sm">No signals. Adjust filters or try scanning again.</div>}
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
