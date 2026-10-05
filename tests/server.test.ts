import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config';
import { Hub, type HubStatus } from '../src/hub';
import { createServer } from '../src/server';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PICTURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
let base = '';
let server: http.Server;
let url = '';
let hub: Hub;

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-api-'));
  fs.mkdirSync(path.join(base, 'Game'));
  fs.mkdirSync(path.join(base, 'assets'));
  fs.writeFileSync(path.join(base, 'assets', 'g.png'), PICTURE);
  fs.writeFileSync(path.join(base, 'assets', 'notes.txt'), 'not a picture');
  fs.writeFileSync(path.join(base, 'hub-state.json'), '{"games":{}}');
  const cfg = validateConfig({
    title: '測試入口',
    adminPassword: 'open-sesame',
    games: [
      // a command that is never run: autoStart is off and the tests never start it
      { id: 'g', name: '遊戲', dir: path.join(base, 'Game'), command: 'node', args: ['missing.js'], port: 1, autoStart: false, image: 'g.png' },
      { id: 'h', name: '沒圖的遊戲', port: 2, image: 'missing.png' },
    ],
    links: [{ name: '說明', url: 'https://example.com' }],
  });
  hub = new Hub(cfg, base, () => {});
  server = createServer(hub, PUBLIC);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(base, { recursive: true, force: true });
});

const post = (p: string, key?: string) =>
  fetch(url + p, { method: 'POST', headers: key === undefined ? {} : { 'x-hub-key': key } });

describe('portal server', () => {
  it('serves the page and the public status', async () => {
    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>更萊姆遊戲</title>');
    const status = (await (await fetch(`${url}/api/status`)).json()) as HubStatus;
    expect(status.title).toBe('測試入口');
    expect(status.games[0]).toMatchObject({ id: 'g', name: '遊戲', state: 'stopped', managed: true });
    expect(status.links).toEqual([{ name: '說明', url: 'https://example.com' }]);
    expect(JSON.stringify(status)).not.toContain('open-sesame');
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
  });

  it('does not serve files outside the page folder', async () => {
    expect((await fetch(`${url}/..%2Fpackage.json`)).status).toBe(404);
    expect((await fetch(`${url}/hub.config.json`)).status).toBe(404);
  });

  it('serves the thumbnails in the assets folder, with an address that changes with the file', async () => {
    const status = (await (await fetch(`${url}/api/status`)).json()) as HubStatus;
    const [g, h] = status.games;
    expect(g!.image).toMatch(/^\/assets\/g\.png\?v=\d+$/);
    expect(h!.image).toBeNull(); // configured, but the file is not there
    const res = await fetch(url + g!.image);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PICTURE);
    for (const bad of ['/assets/notes.txt', '/assets/missing.png', '/assets/..%2Fhub-state.json', '/assets/%E0%A4%A', '/assets/']) {
      expect((await fetch(url + bad)).status, bad).toBe(404);
    }
  });

  it('needs the admin password for every action', async () => {
    expect((await post('/api/login')).status).toBe(401);
    expect((await post('/api/login', 'wrong')).status).toBe(401);
    expect((await post('/api/games/g/stop')).status).toBe(401);
    expect((await fetch(`${url}/api/games/g/log`)).status).toBe(401);
    expect((await post('/api/login', 'open-sesame')).status).toBe(200);
    const stop = await post('/api/games/g/stop', 'open-sesame');
    expect(stop.status).toBe(200);
    expect((await post('/api/games/nope/stop', 'open-sesame')).status).toBe(404);
    const log = await fetch(`${url}/api/games/g/log`, { headers: { 'x-hub-key': 'open-sesame' } });
    expect(((await log.json()) as { lines: string[] }).lines).toEqual([]);
  });

  it('locks out an address after too many wrong passwords', async () => {
    for (let k = 0; k < 8; k++) await post('/api/login', `guess${k}`);
    expect((await post('/api/login', 'open-sesame')).status).toBe(429);
  });
});
