import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_DIR = path.resolve(__dirname, '..');

export function resolveDbPath(p: string) {
  if (p === ':memory:') return p;
  return path.isAbsolute(p) ? p : path.resolve(BACKEND_DIR, p);
}

export const DB_PATH = resolveDbPath(process.env.DB_PATH || '../db/app.db');
export const DB_DIR = path.dirname(DB_PATH);
