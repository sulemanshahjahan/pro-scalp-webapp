import 'dotenv/config';
import { generateTuningBundle } from './generateTuningBundle.js';

function getArgValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

async function main() {
  const hoursArg = getArgValue('--hours');
  const limitArg = getArgValue('--limit');

  const hours = hoursArg ? Number(hoursArg) : undefined;
  const limit = limitArg ? Number(limitArg) : undefined;

  const result = await generateTuningBundle({ hours, limit });
  const insertedId = (result.inserted as any)?.lastInsertRowid ?? (result.inserted as any)?.id ?? null;
  console.log('[tuning] bundle created', {
    id: insertedId,
    windowHours: result.payload.windowHours,
    windowStartMs: result.payload.windowStartMs,
    windowEndMs: result.payload.windowEndMs,
  });
}

main().catch((err) => {
  console.error('[tuning] bundle failed', err);
  process.exit(1);
});

