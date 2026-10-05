// Stand-in game for the hub tests. /healthz reports version, online and playing.
// CRASH_FILE: if it exists at start, it is deleted and the process exits shortly after (crashes once).
// PLAYING_FILE: while it exists, /healthz reports a round in progress. HANG=1: /healthz never answers.
import fs from 'node:fs';
import http from 'node:http';

const port = Number(process.env.PORT);
const crash = process.env.CRASH_FILE && fs.existsSync(process.env.CRASH_FILE);
if (crash) fs.rmSync(process.env.CRASH_FILE);

http
  .createServer((req, res) => {
    if (req.url === '/healthz') {
      if (process.env.HANG === '1') return;
      const playing = process.env.PLAYING_FILE && fs.existsSync(process.env.PLAYING_FILE) ? 1 : 0;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: process.env.GAME_VERSION ?? '1.0.0', online: 2, playing }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('fake game');
  })
  .listen(port, '127.0.0.1', () => console.log(`fake game listening on ${port}`));

if (crash) setTimeout(() => process.exit(7), 300);
