// The Game Hub as a background service: the scheduled task "Game Hub" runs `node dist/service.js`. It keeps
// dist/hub.js running and starts it again whenever it stops: a config change, a crash, or the Ctrl+C that a
// Node.js update sends to the node.exe it replaces (then the hub comes back on the new version). The service
// itself ignores Ctrl+C, so nothing is left waiting at "Terminate batch job (Y/N)?" the way the old
// start-hub.bat loop was, which kept the hub down from 2026-10-29 until the task was ended by hand.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LogFile } from './log';
import { supervise } from './supervise';

const here = path.dirname(fileURLToPath(import.meta.url)); // <root>/dist
const root = path.resolve(here, '..');
const file = new LogFile(path.join(root, 'logs', 'launcher.log'));
const log = (msg: string) => file.write(`[service] ${msg}`);

for (const sig of ['SIGINT', 'SIGBREAK', 'SIGHUP'] as const) {
  process.on(sig, () => log(`ignored ${sig}; the hub is started again by itself`));
}
try {
  fs.writeFileSync(path.join(root, 'service.pid'), String(process.pid)); // lets the autostart scripts end it
} catch {
  /* not essential */
}
log(`service started (Node ${process.version}, pid ${process.pid})`);
supervise({ command: process.execPath, args: [path.join(here, 'hub.js')], cwd: root, log });
