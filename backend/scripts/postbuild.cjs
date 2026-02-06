const fs = require('fs');
const path = require('path');

const srcRoot = path.join(__dirname, '..', 'dist', 'src');
const destRoot = path.join(__dirname, '..', 'dist');

function copyDir(src, dest) {
  if (!fs.existsSync(src)) {
    console.error('[postbuild] missing', src);
    process.exit(1);
  }
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

copyDir(srcRoot, destRoot);
console.log('[postbuild] copied dist/src -> dist');
