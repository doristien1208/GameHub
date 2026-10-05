import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 5 * 1024 * 1024;

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** Appends lines to a file, keeping one older copy (`.1`) once it passes 5 MB. */
export class LogFile {
  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  write(line: string): void {
    try {
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > MAX_BYTES) {
        fs.renameSync(this.file, `${this.file}.1`);
      }
      fs.appendFileSync(this.file, `[${stamp()}] ${line}\n`);
    } catch {
      /* a full or locked disk must not stop the hub */
    }
  }
}

export type Logger = (msg: string) => void;

/** Hub log: the console window (when there is one) plus logs/hub.log. */
export function hubLogger(root: string, quiet = false): Logger {
  const file = new LogFile(path.join(root, 'logs', 'hub.log'));
  return (msg) => {
    if (!quiet) console.log(`[${stamp()}] ${msg}`);
    file.write(msg);
  };
}
