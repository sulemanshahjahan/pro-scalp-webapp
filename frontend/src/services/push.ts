import { getVapidKey, subscribePush, unsubscribePush } from './api'

export async function ensureServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.register('/sw.js');
  return reg;
}

export async function enablePush() {
  const reg = await ensureServiceWorker();
  if (!reg) return false;
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return false;
  const vapid = await getVapidKey();
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapid)
  });
  await subscribePush(sub);
  return true;
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await unsubscribePush(sub);
    await sub.unsubscribe();
  }
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}
