import { execFile } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';

export interface HealthInfo {
  version?: string;
  online?: number;
  playing?: number;
}

/** GET http://127.0.0.1:<port><path>; ok on 2xx. A JSON body may report version / online / playing. */
export function probeHttp(port: number, path: string, timeoutMs: number): Promise<{ ok: boolean; info: HealthInfo }> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs, headers: { accept: 'application/json' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        if (body.length < 16384) body += chunk;
      });
      res.on('end', () => {
        const ok = (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300;
        resolve({ ok, info: ok ? parseHealth(body) : {} });
      });
      res.on('error', () => resolve({ ok: false, info: {} }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ ok: false, info: {} }));
  });
}

export function parseHealth(body: string): HealthInfo {
  try {
    const v = JSON.parse(body) as Record<string, unknown>;
    const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : undefined);
    return {
      version: typeof v.version === 'string' ? v.version.slice(0, 32) : undefined,
      online: num(v.online),
      playing: num(v.playing),
    };
  } catch {
    return {};
  }
}

/** Does anything accept connections on the port? */
export function probeTcp(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/** PID of the process listening on a TCP port, or null (netstat on Windows, lsof elsewhere). */
export function pidOnPort(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 5000 }, (err, out) => {
        if (err) return resolve(null);
        for (const line of out.split(/\r?\n/)) {
          const cols = line.trim().split(/\s+/);
          if (cols.length >= 5 && cols[0] === 'TCP' && cols[3] === 'LISTENING' && cols[1]!.endsWith(`:${port}`)) {
            const pid = Number(cols[4]);
            if (Number.isInteger(pid) && pid > 0) return resolve(pid);
          }
        }
        resolve(null);
      });
      return;
    }
    execFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { timeout: 5000 }, (err, out) => {
      if (err) return resolve(null);
      const pid = Number(out.trim().split(/\s+/)[0]);
      resolve(Number.isInteger(pid) && pid > 0 ? pid : null);
    });
  });
}

/** Is a process with this PID alive? */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
