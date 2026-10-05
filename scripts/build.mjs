// Bundles the hub into one file (dist/hub.js, no runtime dependencies) and copies the portal page.
import { build } from 'esbuild';
import { cpSync, rmSync, writeFileSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/hub.js',
  sourcemap: true,
  logLevel: 'info',
});
cpSync('public', 'dist/public', { recursive: true });
writeFileSync('dist/package.json', '{ "type": "module" }\n');
