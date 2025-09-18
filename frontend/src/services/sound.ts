// services/sound.ts
export type SoundKind = 'EARLY_READY' | 'WATCH' | 'READY_TO_BUY' | 'BEST_ENTRY';

let unlocked = false;
const audios: Partial<Record<SoundKind, HTMLAudioElement>> = {};

function mk(src: string) {
  const a = new Audio(src);
  a.preload = 'auto';
  return a;
}
function ensure(kind: SoundKind) {
  if (!audios[kind]) {
    const src =
      kind === 'EARLY_READY' ? '/sounds/beep-watch.mp3' :
      kind === 'WATCH' ? '/sounds/beep-watch.mp3' :
      kind === 'READY_TO_BUY' ? '/sounds/beep-buy.mp3' :
      '/sounds/beep-best.mp3';
    audios[kind] = mk(src);
  }
}

function dispatchUnlocked() {
  window.dispatchEvent(new CustomEvent('sound-unlocked', { detail: { unlocked: true } }));
}

export function enableSoundSync(): boolean {
  if (unlocked) return true;
  // use BEST_ENTRY file to unlock; any file works
  ensure('BEST_ENTRY');
  const a = audios['BEST_ENTRY']!;
  try {
    const p = a.play();
    if (p && typeof p.then === 'function') {
      p.then(() => {
        try { a.pause(); a.currentTime = 0; } catch {}
        unlocked = true;
        localStorage.setItem('ps_soundWanted', '1');
        dispatchUnlocked();
      }).catch(() => {});
      return false;
    } else {
      try { a.pause(); a.currentTime = 0; } catch {}
      unlocked = true;
      localStorage.setItem('ps_soundWanted', '1');
      dispatchUnlocked();
      return true;
    }
  } catch {
    return false;
  }
}

export function playAlert(kind: SoundKind = 'BEST_ENTRY') {
  if (!unlocked) return;
  ensure(kind);
  const src = audios[kind]!.src;
  try {
    const clone = new Audio(src);
    clone.volume = 1.0;
    void clone.play();
  } catch {}
}

export function isSoundEnabled() {
  return unlocked;
}
