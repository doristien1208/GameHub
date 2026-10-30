import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ASSET_NAME, ASSETS_DIR, IMAGE_TYPES, PV_DIR, VIDEO_TYPES } from './config';
import { HUB_VERSION, type Hub } from './hub';

const FAIL_LIMIT = 8; // wrong passwords allowed per address per window
const FAIL_WINDOW = 10 * 60_000;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function notFound(res: http.ServerResponse): void {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('找不到頁面');
}

/** Contents of a regular file, or null (missing, a folder, unreadable). */
function readFile(file: string): Buffer | null {
  try {
    return fs.statSync(file).isFile() ? fs.readFileSync(file) : null;
  } catch {
    return null;
  }
}

/**
 * A video, streamed rather than read whole, and in ranges: browsers ask for byte ranges to start playing
 * before the rest has arrived (Safari plays nothing without them).
 */
function sendVideo(req: http.IncomingMessage, res: http.ServerResponse, file: string, type: string, immutable: boolean): void {
  let size: number;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return notFound(res);
    size = st.size;
  } catch {
    return notFound(res);
  }
  const headers = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  };
  let start = 0;
  let end = size - 1;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m && m[1]) {
      start = Number(m[1]);
      if (m[2]) end = Math.min(Number(m[2]), size - 1);
    } else if (m && m[2]) {
      start = Math.max(0, size - Number(m[2])); // the last N bytes
    } else {
      start = NaN;
    }
    if (!(start <= end)) {
      res.writeHead(416, { 'content-range': `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
  } else {
    res.writeHead(200, { ...headers, 'content-length': size });
  }
  fs.createReadStream(file, { start, end })
    .on('error', () => res.destroy())
    .pipe(res);
}

/**
 * Portal page and API on one port:
 * - GET /, /assets/<picture>, /assets/pv/<video>, /api/status, /healthz: open to everyone
 * - POST /api/login, POST /api/games/<id>/start|stop|restart|takeover, GET /api/games/<id>/log:
 *   need the admin password in the `x-hub-key` header
 */
export function createServer(hub: Hub, publicDir: string): http.Server {
  const fails = new Map<string, { n: number; since: number }>();
  const digest = (s: string) => createHash('sha256').update(s).digest();
  const key = digest(hub.config.adminPassword);

  return http.createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      hub.log(`[錯誤] ${req.method} ${req.url}：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      if (!res.headersSent) json(res, 500, { error: '主控制器內部錯誤' });
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://hub');
    const p = url.pathname;
    if (req.method === 'GET' && p.startsWith(`/${ASSETS_DIR}/`)) {
      let name = '';
      try {
        name = decodeURIComponent(p.slice(ASSETS_DIR.length + 2));
      } catch {
        /* malformed escape: not found */
      }
      if (name.startsWith(`${PV_DIR}/`)) {
        const video = name.slice(PV_DIR.length + 1);
        const vtype = VIDEO_TYPES[path.extname(video).toLowerCase()];
        if (!ASSET_NAME.test(video) || !vtype) return notFound(res);
        return sendVideo(req, res, path.join(hub.assetsDir, PV_DIR, video), vtype, url.searchParams.has('v'));
      }
      const type = IMAGE_TYPES[path.extname(name).toLowerCase()];
      const body = ASSET_NAME.test(name) && type ? readFile(path.join(hub.assetsDir, name)) : null;
      if (!body) return notFound(res);
      res.writeHead(200, {
        'content-type': type!,
        // the status gives addresses with ?v=<modified time>, so a replaced picture gets a new address
        'cache-control': url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'no-cache',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", // an .svg never runs scripts here
      });
      res.end(body);
      return;
    }
    if (req.method === 'GET' && !p.startsWith('/api/') && p !== '/healthz') {
      const file = p === '/' ? 'index.html' : p.slice(1);
      const full = path.join(publicDir, file);
      const body = /^[\w.-]+$/.test(file) && TYPES[path.extname(file)] ? readFile(full) : null;
      if (!body) return notFound(res);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)]!, 'cache-control': 'no-cache' });
      res.end(body);
      return;
    }
    if (req.method === 'GET' && p === '/healthz') return json(res, 200, { ok: true, version: HUB_VERSION, games: hub.games.length });
    if (req.method === 'GET' && p === '/api/status') return json(res, 200, hub.status());

    // everything else needs the admin password
    const ip = req.socket.remoteAddress ?? '?';
    const now = Date.now();
    const f = fails.get(ip);
    if (f && now - f.since > FAIL_WINDOW) fails.delete(ip);
    if (f && f.n >= FAIL_LIMIT && now - f.since <= FAIL_WINDOW) return json(res, 429, { error: '密碼錯太多次，10 分鐘後再試' });
    const given = req.headers['x-hub-key'];
    if (typeof given !== 'string' || !timingSafeEqual(digest(given), key)) {
      const cur = fails.get(ip);
      fails.set(ip, cur ? { n: cur.n + 1, since: cur.since } : { n: 1, since: now });
      return json(res, 401, { error: '管理密碼不對' });
    }
    fails.delete(ip);
    if (req.method === 'POST' && p === '/api/login') return json(res, 200, { ok: true });

    const m = /^\/api\/games\/([A-Za-z0-9_-]+)\/(start|stop|restart|takeover|log)$/.exec(p);
    const game = m ? hub.byId(m[1]!) : undefined;
    if (!m || !game) return json(res, 404, { error: '找不到這個遊戲或操作' });
    const action = m[2]!;
    if (action === 'log') {
      if (req.method !== 'GET') return json(res, 405, { error: '請用 GET' });
      return json(res, 200, { lines: game.recent() });
    }
    if (req.method !== 'POST') return json(res, 405, { error: '請用 POST' });
    const err =
      action === 'start'
        ? game.start()
        : action === 'stop'
          ? game.stopByAdmin()
          : action === 'restart'
            ? game.restart()
            : await game.takeOver();
    if (err) return json(res, 409, { error: err });
    const label = { start: '啟動', stop: '停止', restart: '重啟', takeover: '接管' }[action];
    hub.log(`管理：${label} ${game.cfg.name}（來自 ${ip}）`);
    await game.tick(); // act now instead of on the next second
    return json(res, 200, { ok: true, game: game.status() });
  }
}
