// main.js
navigator.serviceWorker.register('/sw.js');

const audio = new Audio('/ding.mp3');
let soundReady = false;

// User must click once to allow audio
document.getElementById('enable-sound-btn').addEventListener('click', async () => {
  try {
    await audio.play();      // plays once to unlock
    audio.pause();
    audio.currentTime = 0;
    soundReady = true;
    alert('Sound enabled!');
  } catch (e) {
    console.error('Audio unlock failed', e);
  }
});

// Listen for SW messages (e.g., after a push)
navigator.serviceWorker.addEventListener('message', (evt) => {
  if (evt.data?.type === 'PLAY_SOUND' && soundReady) {
    // Play without await to avoid blocking
    audio.play().catch(console.warn);
  }
});

// Ask for notification permission (once)
async function ensureNotifPerm() {
  if (Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}
ensureNotifPerm();
