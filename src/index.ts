import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config';
import { HUB_VERSION, Hub } from './hub';
import { hubLogger } from './log';
import { createServer } from './server';

// Built: <root>/dist/hub.js with the page in dist/public. Development: <root>/src/index.ts with <root>/public.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const publicDir = fs.existsSync(path.join(here, 'public')) ? path.join(here, 'public') : path.join(root, 'public');
const log = hubLogger(root);

process.on('uncaughtException', (err) => {
  log(`[錯誤] 主控制器發生未預期的錯誤：${err.stack ?? String(err)}`);
  process.exit(1); // the launcher starts it again; the games keep running and are taken back
});
process.on('unhandledRejection', (err) => log(`[錯誤] 未處理的 Promise 錯誤：${String(err)}`));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    log('主控制器結束；遊戲繼續執行，下次啟動時會接回');
    process.exit(0);
  });
}

let loaded: ReturnType<typeof loadConfig>;
try {
  loaded = loadConfig(root);
} catch (err) {
  log(`[錯誤] ${(err as Error).message}`);
  process.exit(3);
}
const { config, file, created } = loaded;
if (created) log(`第一次啟動：已建立 ${file}，管理密碼寫在裡面（adminPassword），可自行修改`);
try {
  fs.writeFileSync(path.join(root, 'hub.pid'), String(process.pid)); // lets remove-autostart.bat end this process
} catch {
  /* not essential */
}

// An edited hub.config.json takes effect by itself: the hub exits, the launcher starts it again within a
// few seconds, and the running games are taken back. A config with mistakes is reported and ignored.
let configText = fs.readFileSync(file, 'utf8');
fs.watchFile(file, { interval: 2000 }, () => {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  if (text === configText) return;
  configText = text;
  try {
    loadConfig(root);
  } catch (err) {
    log(`[錯誤] hub.config.json 改過了但有錯，先不套用：${(err as Error).message}`);
    return;
  }
  log('hub.config.json 已變更，重新啟動主控制器套用設定（遊戲不受影響）');
  process.exit(0);
});

const hub = new Hub(config, root, log);
const server = createServer(hub, publicDir);
const port = Number(process.env.HUB_PORT ?? config.port);

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    log(`[錯誤] 埠 ${port} 已經有程式在用（可能主控制器已經開著），請改 hub.config.json 的 port`);
    process.exit(2); // the launcher stops retrying on 2
  }
  log(`[錯誤] 主控制器無法啟動：${err.message}`);
  process.exit(1);
});

server.listen(port, '0.0.0.0', () => {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => `http://${a!.address}:${port}`);
  log(`遊戲入口主控制器 v${HUB_VERSION} 已啟動（Node ${process.version}），管理 ${config.games.length} 個遊戲`);
  log(`  本機：http://localhost:${port}`);
  for (const url of lan) log(`  同事：${url}`);
  void hub.start();
});
