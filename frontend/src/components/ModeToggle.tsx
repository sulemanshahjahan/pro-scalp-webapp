import { useEffect, useState, useCallback } from 'react';

export type OutcomeModeUI = 'executed' | 'paper' | 'both';

const LABELS: Record<OutcomeModeUI, { title: string; sub: string }> = {
  executed: { title: 'Bot View', sub: 'What was actually traded' },
  paper: { title: 'Signal View', sub: 'Original signal prices' },
  both: { title: 'Both', sub: 'Compare side-by-side' },
};

interface ModeToggleProps {
  value: OutcomeModeUI;
  onChange: (v: OutcomeModeUI) => void;
}

export function ModeToggle({ value, onChange }: ModeToggleProps) {
  const items: OutcomeModeUI[] = ['executed', 'paper', 'both'];

  return (
    <div className="inline-flex rounded-xl border border-white/10 bg-white/5 p-1">
      {items.map((k) => (
        <button
          key={k}
          onClick={() => onChange(k)}
          className={[
            'px-3 py-1.5 rounded-lg text-left transition-all min-w-[110px]',
            value === k
              ? 'bg-white/90 text-black'
              : 'text-white/70 hover:bg-white/5 hover:text-white',
          ].join(' ')}
        >
          <div className="text-sm font-semibold leading-tight">{LABELS[k].title}</div>
          <div className={['text-[10px] leading-tight mt-0.5', value === k ? 'text-black/60' : 'text-white/40'].join(' ')}>
            {LABELS[k].sub}
          </div>
        </button>
      ))}
    </div>
  );
}

// Hook to sync mode with URL search params
const MODE_PARAM = 'mode';
const VALID_MODES: OutcomeModeUI[] = ['executed', 'paper', 'both'];

export function useOutcomeModeFromURL(): [OutcomeModeUI, (v: OutcomeModeUI) => void] {
  const getModeFromURL = useCallback((): OutcomeModeUI => {
    if (typeof window === 'undefined') return 'executed';
    const params = new URLSearchParams(window.location.search);
    const mode = params.get(MODE_PARAM) as OutcomeModeUI | null;
    return VALID_MODES.includes(mode as OutcomeModeUI) ? (mode as OutcomeModeUI) : 'executed';
  }, []);

  const [mode, setMode] = useState<OutcomeModeUI>(getModeFromURL);

  // Sync from URL on popstate
  useEffect(() => {
    const onPopState = () => {
      setMode(getModeFromURL());
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [getModeFromURL]);

  const setModeWithURL = useCallback((newMode: OutcomeModeUI) => {
    setMode(newMode);
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    url.searchParams.set(MODE_PARAM, newMode);
    window.history.pushState({}, '', url);
  }, []);

  return [mode, setModeWithURL];
}
