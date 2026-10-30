import fs from 'node:fs';
import path from 'node:path';
import {
  ASSET_NAME,
  ASSETS_DIR,
  PV_DIR,
  VIDEO_TYPES,
  type HubConfig,
  type LinkConfig,
  type PromoConfig,
} from './config';
import { DEFAULT_TIMING, Game, type GameStatus, type Timing } from './game';
import type { Logger } from './log';

export const HUB_VERSION = '0.2.0';

/** A trailer in assets/pv, matched to the game whose id starts its file name (- and _ ignored). */
export interface Trailer {
  file: string;
  url: string;
  game: string | null;
  title: string;
}

export interface HubStatus {
  title: string;
  version: string;
  uptime: number;
  games: GameStatus[];
  links: LinkConfig[];
  promo: PromoConfig;
  ads: Trailer[];
}

/** What survives a hub restart: whether each game should run, and the process it runs as. */
interface Saved {
  games: Record<string, { want?: 'run' | 'stop'; pid?: number | null }>;
}

export class Hub {
  readonly games: Game[];
  private timer: NodeJS.Timeout | null = null;
  /** thumbnails, served at /assets/<file> */
  readonly assetsDir: string;
  private readonly stateFile: string;
  private readonly started = Date.now();

  constructor(
    readonly config: HubConfig,
    root: string,
    readonly log: Logger,
    timing: Timing = DEFAULT_TIMING,
  ) {
    this.stateFile = path.join(root, 'hub-state.json');
    this.assetsDir = path.join(root, ASSETS_DIR);
    const saved = this.load();
    this.games = config.games.map((cfg) => {
      const g = new Game(cfg, root, log, timing, saved.games[cfg.id]?.want);
      g.onChange = () => this.save();
      return g;
    });
  }

  /** Takes back games an earlier run started, then looks after every game once a second. */
  async start(intervalMs = 1000): Promise<void> {
    for (const g of this.games) {
      if (g.imageFile && !fs.existsSync(g.imageFile)) {
        this.log(`[注意] 找不到 ${g.cfg.name} 的縮圖 ${ASSETS_DIR}/${g.cfg.image}，入口先用文字代替`);
      }
    }
    const saved = this.load();
    for (const g of this.games) {
      const pid = saved.games[g.cfg.id]?.pid;
      if (pid) await g.adopt(pid);
    }
    this.save();
    await this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  /** Stops supervising. The games keep running; the next hub takes them back. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    await Promise.all(this.games.map((g) => g.tick()));
  }

  byId(id: string): Game | undefined {
    return this.games.find((g) => g.cfg.id === id);
  }

  status(): HubStatus {
    const now = Date.now();
    return {
      title: this.config.title,
      version: HUB_VERSION,
      uptime: Math.round((now - this.started) / 1000),
      games: this.games.map((g) => g.status(now)),
      links: this.config.links,
      promo: this.config.promo,
      ads: this.trailers(),
    };
  }

  /** Videos in assets/pv: bnb-pv.mp4 advertises the game "bnb", Space_Race_PV.mp4 the game "space-race". */
  trailers(): Trailer[] {
    const dir = path.join(this.assetsDir, PV_DIR);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    return names
      .filter((n) => ASSET_NAME.test(n) && VIDEO_TYPES[path.extname(n).toLowerCase()])
      .sort()
      .flatMap((file) => {
        let mtime: number;
        try {
          const st = fs.statSync(path.join(dir, file));
          if (!st.isFile()) return [];
          mtime = Math.round(st.mtimeMs);
        } catch {
          return [];
        }
        const base = path.basename(file, path.extname(file));
        // the longest matching id wins, so "bnb2-pv" goes to bnb2 rather than bnb
        const game = this.config.games
          .filter((g) => key(base).startsWith(key(g.id)))
          .sort((a, b) => key(b.id).length - key(a.id).length)[0];
        return [
          {
            file,
            url: `/${ASSETS_DIR}/${PV_DIR}/${encodeURIComponent(file)}?v=${mtime}`,
            game: game?.id ?? null,
            title: game?.name ?? base,
          },
        ];
      });
  }

  private load(): Saved {
    try {
      const v = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as Saved;
      return v && typeof v.games === 'object' ? v : { games: {} };
    } catch {
      return { games: {} };
    }
  }

  private save(): void {
    const games: Saved['games'] = {};
    for (const g of this.games) games[g.cfg.id] = { want: g.want, pid: g.pid };
    try {
      fs.writeFileSync(this.stateFile, `${JSON.stringify({ games }, null, 2)}\n`);
    } catch (err) {
      this.log(`無法寫入 hub-state.json：${(err as Error).message}`);
    }
  }
}
