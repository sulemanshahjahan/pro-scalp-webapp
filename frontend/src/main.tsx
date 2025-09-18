import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './pages/App'
import './styles.css'
import {  playAlert, isSoundEnabled } from './services/sound';

// Ensure we init early
import './services/sound';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (evt: MessageEvent) => {
    if (evt.data?.type === 'PUSH_SIGNAL') {
      // Play the custom sound if the page window is open and user unlocked audio
      if (isSoundEnabled()) playAlert();
    }
  });
}

createRoot(document.getElementById('root')!).render(<App />)
