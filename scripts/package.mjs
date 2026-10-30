// Assembles release/game-hub/ for the test machine: dist + thumbnails + launchers + example config + notes,
// plus a zip. hub.config.json is never in the package, so copying a new version over an old one keeps the
// live config; pictures already in assets/ there are kept too (copying only adds or replaces files).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

if (!existsSync('dist/hub.js') || !existsSync('dist/public/index.html')) {
  console.error('dist/ is missing: run `npm run build` first');
  process.exit(1);
}
const out = 'release/game-hub';
rmSync('release', { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync('dist', `${out}/dist`, { recursive: true });
mkdirSync(`${out}/assets`);
if (existsSync('assets')) cpSync('assets', `${out}/assets`, { recursive: true, filter: (src) => !basename(src).startsWith('.') });
cpSync('hub.config.example.json', `${out}/hub.config.example.json`);

const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
for (const script of ['start-hub.bat', 'open-firewall.bat', 'install-autostart.bat', 'remove-autostart.bat', 'autostart.ps1']) {
  const text = readFileSync(`deploy/${script}`, 'utf8');
  // Non-ASCII text in .bat / .ps1 files breaks depending on the PC's code page and the editor's encoding.
  if (/[^\x00-\x7f]/.test(text)) throw new Error(`${script} must stay plain ASCII`);
  writeFileSync(`${out}/${script}`, crlf(text));
}
writeFileSync(`${out}/README-DEPLOY.txt`, '﻿' + crlf(readFileSync('deploy/README-DEPLOY.txt', 'utf8')));

try {
  execFileSync('zip', ['-qrX', 'game-hub.zip', 'game-hub'], { cwd: 'release' });
  console.log('Package ready: release/game-hub/ and release/game-hub.zip');
} catch {
  console.log('Package ready: release/game-hub/ (no zip tool found)');
}
