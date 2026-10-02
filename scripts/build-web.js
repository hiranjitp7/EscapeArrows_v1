const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'www');
const htmlPath = path.join(root, 'index.html');
const phaserPath = path.join(root, 'node_modules', 'phaser', 'dist', 'phaser.min.js');
const nativeBridgePath = path.join(root, 'scripts', 'native-bridge.js');
const adConfigPath = path.join(root, 'scripts', 'ad-config.json');
const iconPath = path.join(root, 'assets', 'escape-arrows-icon.png');
const cdnScript = '<script src="https://cdnjs.cloudflare.com/ajax/libs/phaser/3.80.1/phaser.min.js"></script>';
const bundledScript = '<script src="./vendor/phaser.min.js"></script>';

if (!fs.existsSync(phaserPath)) {
  throw new Error('Phaser is not installed. Run npm install first.');
}
if (!fs.existsSync(iconPath)) {
  throw new Error('Escape Arrows splash artwork is missing from assets/escape-arrows-icon.png.');
}

const html = fs.readFileSync(htmlPath, 'utf8');
if (!html.includes(cdnScript)) {
  throw new Error('Could not find the expected Phaser 3.80.1 script tag in index.html.');
}
if (!html.includes('__ESCAPE_ARROWS_BUILD_ID__')) {
  throw new Error('Could not find the startup cache build ID placeholder in index.html.');
}

const buildId = createHash('sha256')
  .update(html)
  .update(fs.readFileSync(phaserPath))
  .update(fs.readFileSync(nativeBridgePath))
  .update(fs.readFileSync(adConfigPath))
  .update(fs.readFileSync(iconPath))
  .digest('hex')
  .slice(0, 16);
const builtHtml = html
  .replace('__ESCAPE_ARROWS_BUILD_ID__', buildId)
  .replace(cdnScript, bundledScript);

fs.mkdirSync(path.join(output, 'vendor'), { recursive: true });
const nativeBridgeTag = '<script src="./vendor/native-bridge.js"></script>';
fs.writeFileSync(path.join(output, 'index.html'), builtHtml.replace(bundledScript, `${bundledScript}\n${nativeBridgeTag}`));
fs.mkdirSync(path.join(output, 'assets'), { recursive: true });
fs.copyFileSync(iconPath, path.join(output, 'assets', 'escape-arrows-icon.png'));
fs.copyFileSync(phaserPath, path.join(output, 'vendor', 'phaser.min.js'));
require('esbuild').buildSync({
  entryPoints: [nativeBridgePath],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  outfile: path.join(output, 'vendor', 'native-bridge.js'),
});
console.log('Built offline-ready Android web assets in www/.');
