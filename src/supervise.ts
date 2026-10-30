import { spawn } from 'node:child_process';

export interface SuperviseOptions {
  /** program and arguments that run the hub */
  command: string;
  args: string[];
  cwd: string;
  log: (msg: string) => void;
  /** ms before the next start after the hub found its port taken (exit 2) or the config wrong (exit 3) */
  waitBlocked?: number;
  /** ms before the next start after any other stop */
  waitNormal?: number;
}

/**
 * Keeps the hub running: starts it, and starts it again whenever it stops, whatever the reason (a config
 * change, a crash, a Ctrl+C). Returns a function that stops supervising; a hub that is running stays up.
 */
export function supervise(opts: SuperviseOptions): () => void {
  const waitBlocked = opts.waitBlocked ?? 30_000;
  const waitNormal = opts.waitNormal ?? 5_000;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const later = (ms: number) => {
    if (!stopped) timer = setTimeout(start, ms);
  };
  function start(): void {
    if (stopped) return;
    opts.log('starting hub');
    let ended = false; // a failed start can report both 'error' and 'exit'
    const child = spawn(opts.command, opts.args, { cwd: opts.cwd, stdio: 'ignore', windowsHide: true });
    child.on('error', (err) => {
      if (ended) return;
      ended = true;
      opts.log(`could not start the hub: ${err.message}`);
      later(waitNormal);
    });
    child.on('exit', (code, signal) => {
      if (ended) return;
      ended = true;
      opts.log(`hub exited with code ${code ?? signal}`);
      later(code === 2 || code === 3 ? waitBlocked : waitNormal);
    });
  }
  start();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
