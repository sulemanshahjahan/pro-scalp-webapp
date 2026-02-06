const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'dist', 'src', 'server.js');
const dest = path.join(__dirname, '..', 'dist', 'server.js');

if (!fs.existsSync(src)) {
  console.error('[postbuild] missing', src);
  process.exit(1);
}

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(src, dest);
console.log('[postbuild] copied', src, '->', dest);
