import 'dotenv/config';
import Database from 'better-sqlite3';
import { emailNotify } from './src/emailNotifier.js';

async function main() {
  const db = new Database(process.env.DB_PATH || './db/app.db');

  const fake: any = {
    symbol: 'BTCUSDT',
    category: 'BEST_ENTRY',  // or READY_TO_BUY
    price: 61234.56,
    rsi9: 58.2,
    vwapDistancePct: 0.0021,
    ema200: 60987.42,
    volume: 123456,
    chartUrl: 'https://www.tradingview.com/chart/?symbol=BINANCE:BTCUSDT'
  };

  console.log('Sending fake email signal:', fake.symbol, fake.category);
  await emailNotify(db, fake);
  console.log('Done — check inbox/spam. If nothing, cooldown may have blocked it.');
}

main().catch(e => { console.error(e); process.exit(1); });
