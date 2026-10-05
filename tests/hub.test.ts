import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { validateConfig, type GameConfig } from '../src/config';
import type { Timing } from '../src/game';
import { Hub } from '../src/hub';
import { alive } from '../src/probe';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-game.mjs');
const FAST: Timing = { healthTimeout: 400, startGrace: 1500, unresponsiveAfter: 1200, drainMax: 60_000, backoffMax: 2 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/** A hub folder with one game folder next to it, like games/GameHub and games/BnB. */
async function setup(game: Partial<GameConfig> = {}, env: Record<string, string> = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
  const root = path.join(base, 'GameHub');
  const dir = path.join(base, 'Game');
  fs.mkdirSync(root);
  fs.mkdirSync(dir);
  const port = await freePort();
  const cfg = validateConfig({
    port: 1,
    adminPassword: 'secret',
    games: [{ id: 'g', name: '測試遊戲', dir: '../Game', command: 'node', args: [FAKE], port, health: '/healthz', env, ...game }],
  });
  const hubs: Hub[] = [];
  const make = () => {
    const hub = new Hub(cfg, root, () => {}, FAST);
    hubs.push(hub);
    return hub;
  };
  cleanup.push(() => {
    for (const h of hubs) {
      h.stop();
      for (const g of h.games) if (g.pid && alive(g.pid)) process.kill(g.pid, 'SIGKILL');
    }
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { root, dir, port, make };
}

/** Ticks the hub until `cond` holds (or fails after `ms`). */
async function until(hub: Hub, cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    await hub.tick();
    if (cond()) return;
    if (Date.now() > end) throw new Error(`timed out; state ${hub.games[0]?.state}`);
    await sleep(100);
  }
}

function runOutside(port: number): ChildProcess {
  const p = spawn(process.execPath, [FAKE], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  cleanup.push(() => p.kill('SIGKILL'));
  return p;
}

describe('hub', () => {
  it('starts a game and reports what its /healthz says', async () => {
    const { make } = await setup({}, { GAME_VERSION: '0.2.0' });
    const hub = make();
    const g = hub.games[0]!;
    await until(hub, () => g.state === 'running');
    expect(g.status()).toMatchObject({ state: 'running', version: '0.2.0', online: 2, playing: 0, managed: true });
    expect(g.recent().join('\n')).toContain('fake game listening');
  });

  it('starts a game again after it crashes', async () => {
    const { dir, make } = await setup({}, {});
    const hub = make();
    const g = hub.games[0]!;
    g.cfg.env = { CRASH_FILE: path.join(dir, 'crash') };
    fs.writeFileSync(path.join(dir, 'crash'), '');
    await until(hub, () => g.state === 'crashed');
    expect(g.status().restartIn).toBeGreaterThanOrEqual(0);
    await until(hub, () => g.state === 'running');
    expect(g.restarts).toBe(1);
  });

  it('takes a game down while maintenance.txt is in its folder, in any letter case', async () => {
    const { dir, make, port } = await setup();
    const hub = make();
    const g = hub.games[0]!;
    await until(hub, () => g.state === 'running');
    const pid = g.pid!;
    fs.writeFileSync(path.join(dir, 'Maintenance.TXT'), '更新到 v0.3，約 10 分鐘\n');
    await until(hub, () => g.state === 'maintenance');
    expect(g.message).toBe('更新到 v0.3，約 10 分鐘');
    expect(alive(pid)).toBe(false);
    expect(g.start()).toMatch(/維護/); // the admin page cannot start it while the file is there
    fs.rmSync(path.join(dir, 'Maintenance.TXT'));
    await until(hub, () => g.state === 'running');
    expect(g.message).toBeNull();
    expect(g.status().port).toBe(port);
  });

  it('lets the round in progress finish before maintenance stops the game', async () => {
    const { dir, make } = await setup();
    const hub = make();
    const g = hub.games[0]!;
    g.cfg.env = { PLAYING_FILE: path.join(dir, 'playing') };
    await until(hub, () => g.state === 'running');
    fs.writeFileSync(path.join(dir, 'playing'), '');
    fs.writeFileSync(path.join(dir, 'maintenance.txt'), '');
    await until(hub, () => g.state === 'draining');
    expect(g.message).toBe('維護中');
    expect(alive(g.pid!)).toBe(true);
    fs.rmSync(path.join(dir, 'playing'));
    await until(hub, () => g.state === 'maintenance');
  });

  it('keeps a game the admin stopped switched off, also after the hub restarts', async () => {
    const { make } = await setup();
    const first = make();
    const g = first.games[0]!;
    await until(first, () => g.state === 'running');
    expect(g.stopByAdmin()).toBeNull();
    await until(first, () => g.state === 'stopped');
    first.stop();
    const second = make();
    const g2 = second.games[0]!;
    await second.tick();
    await sleep(300);
    await second.tick();
    expect(g2.state).toBe('stopped');
    expect(g2.start()).toBeNull();
    await until(second, () => g2.state === 'running');
  });

  it('takes back the games of an earlier run instead of starting them twice', async () => {
    const { make } = await setup();
    const first = make();
    await until(first, () => first.games[0]!.state === 'running');
    const pid = first.games[0]!.pid!;
    first.stop(); // the hub goes away; the game keeps running
    const second = make();
    await second.start(60_000);
    const g = second.games[0]!;
    expect(g.pid).toBe(pid);
    expect(g.state).toBe('running');
    expect(g.restart()).toBeNull();
    await until(second, () => g.state === 'running' && g.pid !== pid);
    expect(alive(pid)).toBe(false);
  });

  it('leaves a port held by another program alone until the admin takes it over', async () => {
    const { port, make } = await setup();
    const outside = runOutside(port);
    const hub = make();
    const g = hub.games[0]!;
    await until(hub, () => g.state === 'external');
    expect(g.pid).toBeNull();
    expect(await g.takeOver()).toBeNull();
    await until(hub, () => g.state === 'running' && g.pid !== null);
    await sleep(200);
    expect(outside.exitCode !== null || outside.signalCode !== null).toBe(true);
  });

  it('restarts a game that stops answering', async () => {
    const { make } = await setup({}, { HANG: '1' });
    const hub = make();
    const g = hub.games[0]!;
    await until(hub, () => g.pid !== null);
    const pid = g.pid!;
    await until(hub, () => g.pid !== null && g.pid !== pid, 10_000);
    expect(alive(pid)).toBe(false);
  });

  it('only watches games without a command', async () => {
    const { port, root } = await setup();
    const cfg = validateConfig({ adminPassword: 'secret', games: [{ id: 'w', name: '只看狀態', port }] });
    const hub = new Hub(cfg, root, () => {}, FAST);
    const g = hub.games[0]!;
    await hub.tick();
    expect(g.state).toBe('offline');
    expect(g.start()).toMatch(/不由主控制器/);
    runOutside(port);
    await until(hub, () => g.state === 'running');
  });
});

describe('config', () => {
  it('refuses settings that cannot work', () => {
    expect(() => validateConfig({ adminPassword: '' , games: [] })).toThrow(/adminPassword/);
    expect(() => validateConfig({ adminPassword: 'abcd', games: [{ id: 'a b', name: 'x', port: 1 }] })).toThrow(/id/);
    expect(() =>
      validateConfig({ adminPassword: 'abcd', games: [{ id: 'a', name: 'x', port: 1 }, { id: 'a', name: 'y', port: 2 }] }),
    ).toThrow(/重複/);
    expect(() => validateConfig({ adminPassword: 'abcd', games: [{ id: 'a', name: 'x', port: 1, command: 'node' }] })).toThrow(/dir/);
    expect(() => validateConfig({ port: 3000, adminPassword: 'abcd', games: [{ id: 'a', name: 'x', port: 3000 }] })).toThrow(/重複/);
    for (const image of ['../a.png', 'pics/a.png', '.a.png', 'a.exe', 3]) {
      expect(() => validateConfig({ adminPassword: 'abcd', games: [{ id: 'a', name: 'x', port: 1, image }] })).toThrow(/image/);
    }
    const ok = validateConfig({ adminPassword: 'abcd', games: [{ id: 'a', name: 'x', port: 1, image: 'A_1.JPG' }] });
    expect(ok.games[0]!.image).toBe('A_1.JPG');
    expect(ok.port).toBe(4300);
  });
});
