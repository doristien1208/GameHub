// Bundles the hub (dist/hub.js) and the service that keeps it running (dist/service.js), with no runtime
// dependencies, and copies the portal page.
import { build } from 'esbuild';
import { cpSync, rmSync, writeFileSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
await build({
  entryPoints: { hub: 'src/index.ts', service: 'src/service.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outdir: 'dist',
  sourcemap: true,
  logLevel: 'info',
});
cpSync('public', 'dist/public', { recursive: true });
writeFileSync('dist/package.json', '{ "type": "module" }\n');
