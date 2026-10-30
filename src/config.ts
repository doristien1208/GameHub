import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface GameConfig {
  /** short id used in the API and log file names: letters, digits, - and _ */
  id: string;
  name: string;
  desc?: string;
  /** port players open in the browser */
  port: number;
  /** page to open on that port (default "/") */
  path?: string;
  /** the game's folder, relative to the hub folder; also where MAINTENANCE.txt goes */
  dir?: string;
  /**
   * Start command, run inside `dir`. "node" means the Node.js that runs the hub. Without a command
   * the hub does not start or stop the game: it only shows whether the port answers, and the link.
   */
  command?: string;
  args?: string[];
  /** extra environment; PORT is always set to `port` */
  env?: Record<string, string>;
  /** HTTP path that answers 200 while healthy, ideally JSON {version, online, playing}; without it the port is checked */
  health?: string;
  /** start when the hub starts (default true); the admin page overrides this and the hub remembers */
  autoStart?: boolean;
  /** thumbnail for the list: a picture file in the hub's assets folder, e.g. "bnb.png" (200 x 200) */
  image?: string;
}

export interface LinkConfig {
  name: string;
  url: string;
  desc?: string;
}

/**
 * YBOX Game Pass: a parody subscription the portal advertises (a banner over the list, a pop-up, and now and
 * then an ad before a game opens). Nothing is sold or collected: "subscribing" only puts a badge in that browser.
 */
export interface PromoConfig {
  enabled: boolean;
  /** banner lines, shown in turn; {games} becomes the number of games */
  slogans: string[];
  /** member perks in the plans dialog: Core gets the first, Standard the first two, Ultimate all of them */
  perks: string[];
  finePrint: string;
  /** chance (0–1) that 進入遊戲 first plays the ad; Ultimate members never see it */
  preroll: number;
  /** seconds without a mouse move or key press before closed ads come back (trailers too); 0 = never */
  idle: number;
}

export const DEFAULT_PROMO: PromoConfig = {
  enabled: true,
  slogans: ['一個月 NT$0，玩到忘記下班', '所有遊戲本來就免費，現在更免費了', '收錄 {games} 款遊戲，每週不一定新增'],
  perks: ['電腦玩家看到你會手下留情（不會）', 'Boss 狂暴時間 +0 秒', '雲端存檔：存在你的記憶裡', '優先排隊（反正沒人排）'],
  finePrint: '* YBOX Game Pass 並不存在。訂閱即表示您同意午休多玩一場。',
  preroll: 0.1,
  idle: 60,
};

export interface HubConfig {
  port: number;
  title: string;
  /** password for the admin buttons (start, stop, restart, maintenance, logs) */
  adminPassword: string;
  games: GameConfig[];
  links: LinkConfig[];
  promo: PromoConfig;
}

const ID = /^[A-Za-z0-9_-]{1,32}$/;

/** Folder next to dist/ with the games' thumbnails, served at /assets/<file>. */
export const ASSETS_DIR = 'assets';
/** Game trailers inside the assets folder, served at /assets/pv/<file>: the portal pops them up as ads. */
export const PV_DIR = 'pv';
export const VIDEO_TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.webm': 'video/webm' };
/** A file name in the assets folder: no folders, no leading dot. */
export const ASSET_NAME = /^\w[\w.-]*$/;
export const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

const isPort = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 65536;

/** Checks a parsed config and fills in defaults; throws with a message that says what to fix. */
export function validateConfig(raw: unknown): HubConfig {
  if (!raw || typeof raw !== 'object') throw new Error('設定檔不是 JSON 物件');
  const c = raw as Record<string, unknown>;
  const fail = (msg: string): never => {
    throw new Error(`設定檔錯誤：${msg}`);
  };
  const port = c.port ?? 4300;
  if (!isPort(port)) fail('port 必須是 1–65535 的整數');
  if (typeof c.adminPassword !== 'string' || c.adminPassword.length < 4) fail('adminPassword 至少 4 個字');
  if (!Array.isArray(c.games)) fail('games 必須是陣列');
  const ids = new Set<string>();
  const games = (c.games as unknown[]).map((g, k): GameConfig => {
    if (!g || typeof g !== 'object') fail(`games[${k}] 不是物件`);
    const x = g as Record<string, unknown>;
    if (typeof x.id !== 'string' || !ID.test(x.id)) fail(`games[${k}].id 只能用英數字、- 和 _`);
    const id = x.id as string;
    if (ids.has(id)) fail(`遊戲 id「${id}」重複`);
    ids.add(id);
    if (typeof x.name !== 'string' || !x.name) fail(`遊戲 ${id} 缺少 name`);
    if (!isPort(x.port)) fail(`遊戲 ${id} 的 port 不正確`);
    if (x.command !== undefined && (typeof x.command !== 'string' || !x.command)) fail(`遊戲 ${id} 的 command 不正確`);
    if (x.command !== undefined && typeof x.dir !== 'string') fail(`遊戲 ${id} 有 command 就要有 dir`);
    if (x.args !== undefined && !(Array.isArray(x.args) && x.args.every((a) => typeof a === 'string'))) {
      fail(`遊戲 ${id} 的 args 必須是字串陣列`);
    }
    if (x.health !== undefined && (typeof x.health !== 'string' || !x.health.startsWith('/'))) {
      fail(`遊戲 ${id} 的 health 要以 / 開頭`);
    }
    if (
      x.image !== undefined &&
      (typeof x.image !== 'string' || !ASSET_NAME.test(x.image) || !IMAGE_TYPES[path.extname(x.image).toLowerCase()])
    ) {
      fail(`遊戲 ${id} 的 image 要填 ${ASSETS_DIR} 資料夾裡的圖檔名稱（英數字檔名，例如 bnb.png）`);
    }
    return {
      id,
      name: x.name as string,
      desc: typeof x.desc === 'string' ? x.desc : undefined,
      port: x.port as number,
      path: typeof x.path === 'string' && x.path.startsWith('/') ? x.path : '/',
      dir: typeof x.dir === 'string' ? x.dir : undefined,
      command: x.command as string | undefined,
      args: (x.args as string[] | undefined) ?? [],
      env: x.env && typeof x.env === 'object' ? (x.env as Record<string, string>) : {},
      health: x.health as string | undefined,
      autoStart: x.autoStart !== false,
      image: x.image as string | undefined,
    };
  });
  const ports = games.map((g) => g.port);
  if (ports.includes(port as number)) fail(`入口的 port ${port} 跟某個遊戲重複`);
  const links = Array.isArray(c.links)
    ? (c.links as unknown[]).flatMap((l) => {
        const x = l as Record<string, unknown>;
        return x && typeof x.name === 'string' && typeof x.url === 'string'
          ? [{ name: x.name, url: x.url, desc: typeof x.desc === 'string' ? x.desc : undefined }]
          : [];
      })
    : [];
  return {
    port: port as number,
    title: typeof c.title === 'string' && c.title ? c.title : '更萊姆遊戲',
    adminPassword: c.adminPassword as string,
    games,
    links,
    promo: validatePromo(c.promo, fail),
  };
}

/** The optional `promo` block: every field may be left out (the built-in copy is used). */
function validatePromo(raw: unknown, fail: (msg: string) => never): PromoConfig {
  if (raw === undefined) return DEFAULT_PROMO;
  if (!raw || typeof raw !== 'object') fail('promo 必須是物件');
  const x = raw as Record<string, unknown>;
  const lines = (k: 'slogans' | 'perks'): string[] => {
    const v = x[k];
    if (v === undefined) return DEFAULT_PROMO[k];
    if (!Array.isArray(v) || !v.length || !v.every((s) => typeof s === 'string' && s)) fail(`promo.${k} 必須是至少一句的字串陣列`);
    return v as string[];
  };
  if (x.enabled !== undefined && typeof x.enabled !== 'boolean') fail('promo.enabled 只能是 true 或 false');
  if (x.finePrint !== undefined && typeof x.finePrint !== 'string') fail('promo.finePrint 必須是字串');
  if (x.preroll !== undefined && !(typeof x.preroll === 'number' && x.preroll >= 0 && x.preroll <= 1)) {
    fail('promo.preroll 必須是 0 到 1 之間的數字（例如 0.1 = 十次出現一次）');
  }
  if (x.idle !== undefined && !(typeof x.idle === 'number' && x.idle >= 0)) {
    fail('promo.idle 必須是 0 以上的秒數（0 = 關掉的廣告不會自己回來）');
  }
  return {
    enabled: x.enabled !== false,
    slogans: lines('slogans'),
    perks: lines('perks'),
    finePrint: (x.finePrint as string | undefined) ?? DEFAULT_PROMO.finePrint,
    preroll: (x.preroll as number | undefined) ?? DEFAULT_PROMO.preroll,
    idle: (x.idle as number | undefined) ?? DEFAULT_PROMO.idle,
  };
}

/**
 * Reads hub.config.json in `root`. On first run it is created from hub.config.example.json with a
 * random admin password, so a fresh install starts without anyone editing JSON.
 */
export function loadConfig(root: string): { config: HubConfig; file: string; created: boolean } {
  const file = path.join(root, 'hub.config.json');
  let created = false;
  if (!fs.existsSync(file)) {
    const example = path.join(root, 'hub.config.example.json');
    if (!fs.existsSync(example)) throw new Error(`找不到 ${file}，也沒有 hub.config.example.json 可以複製`);
    const raw = JSON.parse(fs.readFileSync(example, 'utf8')) as Record<string, unknown>;
    raw.adminPassword = randomBytes(6).toString('hex');
    fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
    created = true;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    throw new Error(`hub.config.json 不是正確的 JSON：${(err as Error).message}`);
  }
  return { config: validateConfig(raw), file, created };
}
