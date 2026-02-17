const rawApiBase = (import.meta.env.VITE_API_BASE ?? '').trim();

export const API_BASE = rawApiBase.replace(/\/+$/, '');
export const apiUrl = (path: string) => API_BASE + path;

if (import.meta.env.PROD && !API_BASE) {
  // Fail loud in prod when backend base is not configured.
  console.warn('[config] Missing VITE_API_BASE; API calls will target relative /api paths.');
}
