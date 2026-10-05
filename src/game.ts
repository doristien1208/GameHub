import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ASSETS_DIR, type GameConfig } from './config';
import type { Logger } from './log';
import { alive, pidOnPort, probeHttp, probeTcp, type HealthInfo } from './probe';

export type GameState =
  | 'running' // started by the hub and answering
  | 'starting' // started, waiting for its first answer
  | 'unresponsive' // was answering, now is not; restarted if it stays that way
  | 'stopping'
  | 'stopped' // turned off from the admin page (or autoStart is false)
  | 'crashed' // exited on its own; started again after a back-off
  | 'draining' // maintenance asked for, waiting for the round in progress to end
  | 'maintenance' // stopped because maintenance.txt is in the game's folder
  | 'external' // the port answers, but the hub did not start that process (e.g. a window someone opened by hand)
  | 'offline'; // link-only game whose port does not answer

export interface GameStatus {
  id: string;
  name: string;
  desc: string | null;
  port: number;
  path: string;
  /** started and stopped by the hub (has a command) */
  managed: boolean;
  state: GameState;
  /** maintenance message, while maintenance.txt exists */
  message: string | null;
  version: string | null;
  online: number | null;
  playing: number | null;
  /** when the state last changed (ms) */
  since: number;
  /** seconds until the next start attempt after a crash */
  restartIn: number | null;
  restarts: number;
  /** thumbnail address (/assets/<file>?v=<modified time>); null without one or while the file is missing */
  image: string | null;
}

export interface Timing {
  /** ms a health check may take */
  healthTimeout: number;
  /** ms a freshly started game may take before it has to answer */
  startGrace: number;
  /** ms without an answer before a running game is restarted */
  unresponsiveAfter: number;
  /** ms maintenance waits for the round in progress before it stops the game anyway */
  drainMax: number;
  /** longest wait between restarts after crashes, s */
  backoffMax: number;
}

export const DEFAULT_TIMING: Timing = {
  healthTimeout: 2000,
  startGrace: 60_000,
  unresponsiveAfter: 60_000,
  drainMax: 15 * 60_000,
  backoffMax: 60,
};

/** Put into a game's folder to take it down for maintenance; its text is shown on the portal. Any letter case. */
export const MAINTENANCE_FILE = 'maintenance.txt';
const LOG_MAX = 5 * 1024 * 1024;

/** Ends a process and everything it started. */
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    try {
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }, 3000).unref();
}

/**
 * One game the hub looks after. Managed games (with a command) are started, stopped, restarted and
 * put into maintenance; link-only games are just watched. Games run detached with their output in
 * logs/<id>.log, so restarting the hub never interrupts a round: the next hub takes them back.
 */
export class Game {
  readonly managed: boolean;
  readonly dir: string | null;
  readonly logFile: string;
  readonly imageFile: string | null;
  state: GameState;
  want: 'run' | 'stop';
  message: string | null = null;
  info: HealthInfo = {};
  restarts = 0;
  since = Date.now();
  /** called when `want` or the process id changes, so the hub can save them */
  onChange: () => void = () => {};

  private child: ChildProcess | null = null;
  private procId: number | null = null;
  private stopping = false;
  private restartNow = false;
  private startedAt = 0;
  private answeredAt = 0;
  private backoff = 0;
  private restartAt = 0;
  private drainSince = 0;
  private busy = false;

  constructor(
    readonly cfg: GameConfig,
    root: string,
    private readonly log: Logger,
    private readonly timing: Timing = DEFAULT_TIMING,
    want?: 'run' | 'stop',
  ) {
    this.managed = !!cfg.command;
    this.dir = cfg.dir ? path.resolve(root, cfg.dir) : null;
    this.logFile = path.join(root, 'logs', `${cfg.id}.log`);
    this.imageFile = cfg.image ? path.join(root, ASSETS_DIR, cfg.image) : null;
    this.want = want ?? (cfg.autoStart === false ? 'stop' : 'run');
    this.state = this.managed ? 'stopped' : 'offline';
  }

  /** Process id of the game the hub runs (spawned now or taken back from an earlier hub run). */
  get pid(): number | null {
    return this.procId;
  }

  /** Takes back a game an earlier hub run started, once its process is confirmed to own the port. */
  async adopt(pid: number): Promise<boolean> {
    if (!this.managed || !alive(pid) || (await pidOnPort(this.cfg.port)) !== pid) return false;
    this.procId = pid;
    this.startedAt = Date.now();
    this.answeredAt = Date.now();
    this.state = 'running';
    this.log(`接回執行中的 ${this.cfg.name}（pid ${pid}）`);
    return true;
  }

  /** One supervision step; the hub calls it every second. */
  async tick(now = Date.now()): Promise<void> {
    if (this.busy) return; // a slow health check is still running
    this.busy = true;
    try {
      await this.step(now);
    } finally {
      this.busy = false;
    }
  }

  private async step(now: number): Promise<void> {
    this.message = this.readMaintenance();
    const answer = this.cfg.health
      ? await probeHttp(this.cfg.port, this.cfg.health, this.timing.healthTimeout)
      : { ok: await probeTcp(this.cfg.port, this.timing.healthTimeout), info: {} };
    this.info = answer.ok ? answer.info : {};
    if (answer.ok) this.answeredAt = now;

    if (!this.managed) {
      this.set(this.message !== null ? 'maintenance' : answer.ok ? 'running' : 'offline', now);
      return;
    }
    // a game taken back from an earlier hub run has no exit event: notice it is gone
    if (this.procId !== null && !this.child && !alive(this.procId)) this.exited(null, now);

    const shouldRun = this.want === 'run' && this.message === null;
    if (this.procId !== null) {
      if (this.stopping) return;
      if (!shouldRun) {
        // maintenance lets a round in progress finish when the game reports one (e.g. BnB's `playing`)
        if (this.message !== null && (this.info.playing ?? 0) > 0) {
          this.drainSince ||= now;
          if (now - this.drainSince < this.timing.drainMax) {
            this.set('draining', now);
            return;
          }
        }
        this.stop(now, this.message !== null ? '維護，停止' : '停止');
        return;
      }
      this.drainSince = 0;
      if (answer.ok) {
        this.set('running', now);
        if (now - this.startedAt > 60_000) this.backoff = 0; // stable again: the next crash restarts quickly
        return;
      }
      if (this.state === 'starting' && now - this.startedAt < this.timing.startGrace) return;
      if (now - Math.max(this.answeredAt, this.startedAt) > this.timing.unresponsiveAfter) {
        this.log(`${this.cfg.name} 超過 ${Math.round(this.timing.unresponsiveAfter / 1000)} 秒沒有回應，重新啟動`);
        this.restartNow = true;
        this.stop(now, '重啟');
        return;
      }
      if (this.state !== 'starting') this.set('unresponsive', now);
      return;
    }

    this.drainSince = 0;
    // something else holds the port (a window opened by hand): leave it alone
    if (answer.ok || (await probeTcp(this.cfg.port, this.timing.healthTimeout))) {
      this.set('external', now);
      return;
    }
    if (!shouldRun) {
      this.set(this.message !== null ? 'maintenance' : 'stopped', now);
      return;
    }
    if (now < this.restartAt) {
      this.set('crashed', now);
      return;
    }
    this.spawn(now);
  }

  private set(state: GameState, now: number): void {
    if (state === this.state) return;
    this.state = state;
    this.since = now;
  }

  private spawn(now: number): void {
    const cfg = this.cfg;
    if (!this.dir || !fs.existsSync(this.dir)) {
      this.crashLike(now, `找不到資料夾 ${this.dir ?? '（沒有設定 dir）'}`);
      return;
    }
    const cmd = cfg.command === 'node' ? process.execPath : cfg.command!;
    let fd: number;
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      if (fs.existsSync(this.logFile) && fs.statSync(this.logFile).size > LOG_MAX) fs.renameSync(this.logFile, `${this.logFile}.1`);
      fd = fs.openSync(this.logFile, 'a');
    } catch (err) {
      this.crashLike(now, `無法開啟紀錄檔：${(err as Error).message}`);
      return;
    }
    fs.writeSync(fd, `\n[${new Date().toLocaleString('zh-TW', { hour12: false })}] [主控制器] 啟動 ${cmd} ${(cfg.args ?? []).join(' ')}\n`);
    let child: ChildProcess;
    try {
      // detached + output into a file: the game keeps running (and logging) if the hub restarts
      child = spawn(cmd, cfg.args ?? [], {
        cwd: this.dir,
        env: { ...process.env, ...cfg.env, PORT: String(cfg.port) },
        detached: true,
        windowsHide: true,
        stdio: ['ignore', fd, fd],
      });
    } catch (err) {
      fs.closeSync(fd);
      this.crashLike(now, `無法啟動：${(err as Error).message}`);
      return;
    }
    fs.closeSync(fd);
    this.child = child;
    this.procId = child.pid ?? null;
    this.stopping = false;
    this.startedAt = now;
    this.set('starting', now);
    this.log(`啟動 ${cfg.name}（pid ${child.pid ?? '?'}）`);
    this.onChange();
    child.on('error', (err) => {
      this.note(`無法啟動：${err.message}`);
      if (this.child === child) this.exited(null, Date.now(), err.message);
    });
    child.on('exit', (code) => {
      if (this.child === child) this.exited(code, Date.now());
    });
  }

  /** A start that failed before a process existed counts like a crash (with the same back-off). */
  private crashLike(now: number, why: string): void {
    this.note(why);
    this.log(`${this.cfg.name}：${why}`);
    this.backoff = Math.min(this.timing.backoffMax, Math.max(1, this.backoff * 2));
    this.restartAt = now + this.backoff * 1000;
    this.restarts++;
    this.set('crashed', now);
  }

  private exited(code: number | null, now: number, why?: string): void {
    const wasStopping = this.stopping;
    this.child = null;
    this.procId = null;
    this.stopping = false;
    this.onChange();
    if (wasStopping) {
      if (this.restartNow) this.restartAt = 0;
      this.restartNow = false;
      return; // the next tick decides: stay stopped, wait for maintenance, or start again
    }
    this.restarts++;
    this.backoff = Math.min(this.timing.backoffMax, Math.max(1, this.backoff * 2));
    this.restartAt = now + this.backoff * 1000;
    this.set('crashed', now);
    this.log(`${this.cfg.name} 自己結束了（${why ?? `代碼 ${code ?? '?'}`}），${this.backoff} 秒後重啟`);
  }

  private stop(now: number, why: string): void {
    const pid = this.procId;
    if (pid === null) return;
    this.stopping = true;
    this.set('stopping', now);
    this.log(`${why} ${this.cfg.name}（pid ${pid}）`);
    this.note(`${why}（pid ${pid}）`);
    killTree(pid);
    if (!this.child) {
      // taken back from an earlier run: no exit event will come
      setTimeout(() => {
        if (this.procId === pid && !alive(pid)) this.exited(null, Date.now());
      }, 500).unref();
    }
  }

  /** Writes a line to the game's log, marked as coming from the hub. */
  private note(text: string): void {
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      fs.appendFileSync(this.logFile, `[${new Date().toLocaleString('zh-TW', { hour12: false })}] [主控制器] ${text}\n`);
    } catch {
      /* ignore */
    }
  }

  private readMaintenance(): string | null {
    if (!this.dir) return null;
    let text: string;
    try {
      const name = fs.readdirSync(this.dir).find((f) => f.toLowerCase() === MAINTENANCE_FILE);
      if (!name) return null;
      text = fs.readFileSync(path.join(this.dir, name), 'utf8');
    } catch {
      return null;
    }
    text = text.replace(/^﻿/, '').replace(/\s+/g, ' ').trim().slice(0, 200);
    // a file saved as Big5 by an old editor reads as garbage: show the plain word instead
    return !text || text.includes('�') ? '維護中' : text;
  }

  // ---------------------------------------------------------------- admin actions (an error message, or null)

  start(): string | null {
    if (!this.managed) return '這個遊戲不由主控制器啟動';
    if (this.message !== null) return '維護中，請先結束維護';
    this.want = 'run';
    this.restartAt = 0;
    this.backoff = 0;
    this.onChange();
    return null;
  }

  stopByAdmin(): string | null {
    if (!this.managed) return '這個遊戲不由主控制器啟動';
    this.want = 'stop';
    this.onChange();
    return null;
  }

  restart(): string | null {
    if (!this.managed) return '這個遊戲不由主控制器啟動';
    if (this.message !== null) return '維護中，請先結束維護';
    this.want = 'run';
    this.backoff = 0;
    this.restartAt = 0;
    this.onChange();
    if (this.procId !== null && !this.stopping) {
      this.restartNow = true;
      this.stop(Date.now(), '重啟');
    }
    return null;
  }

  /** Ends the process holding the game's port (one the hub did not start), so the hub can run its own. */
  async takeOver(): Promise<string | null> {
    if (!this.managed) return '這個遊戲不由主控制器啟動';
    if (this.state !== 'external') return '目前沒有外部開啟的程式占用這個埠';
    const pid = await pidOnPort(this.cfg.port);
    if (!pid) return `找不到占用埠 ${this.cfg.port} 的程式`;
    this.log(`接管 ${this.cfg.name}：結束占用埠 ${this.cfg.port} 的程式（pid ${pid}）`);
    killTree(pid);
    this.want = 'run';
    this.restartAt = 0;
    this.onChange();
    return null;
  }

  /** Last lines of the game's log file. */
  recent(maxLines = 200): string[] {
    try {
      const size = fs.statSync(this.logFile).size;
      const len = Math.min(size, 64 * 1024);
      const fd = fs.openSync(this.logFile, 'r');
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      fs.closeSync(fd);
      const lines = buf.toString('utf8').split(/\r?\n/);
      if (len < size) lines.shift(); // probably cut mid-line
      return lines.filter((l) => l.trim()).slice(-maxLines);
    } catch {
      return [];
    }
  }

  status(now = Date.now()): GameStatus {
    const c = this.cfg;
    return {
      id: c.id,
      name: c.name,
      desc: c.desc ?? null,
      port: c.port,
      path: c.path ?? '/',
      managed: this.managed,
      state: this.state,
      message: this.message,
      version: this.info.version ?? null,
      online: this.info.online ?? null,
      playing: this.info.playing ?? null,
      since: this.since,
      restartIn: this.state === 'crashed' ? Math.max(0, Math.ceil((this.restartAt - now) / 1000)) : null,
      restarts: this.restarts,
      image: this.imageUrl(),
    };
  }

  /** The modified time in the address makes browsers fetch a picture again after someone replaces it. */
  private imageUrl(): string | null {
    if (!this.imageFile || !this.cfg.image) return null;
    try {
      const mtime = Math.floor(fs.statSync(this.imageFile).mtimeMs);
      return `/${ASSETS_DIR}/${encodeURIComponent(this.cfg.image)}?v=${mtime}`;
    } catch {
      return null;
    }
  }
}
