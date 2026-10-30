import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { supervise } from '../src/supervise';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const count = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').length : 0);

describe('service', () => {
  it('starts the hub again whenever it stops, and waits longer after the port was taken', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-'));
    const runs = path.join(dir, 'runs.txt');
    // a stand-in hub: notes each start, exits with 2 (port taken) the first time and 0 after that
    const fake = path.join(dir, 'fake-hub.mjs');
    fs.writeFileSync(
      fake,
      "import fs from 'node:fs'; const f = process.argv[2]; const n = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').length : 0; fs.appendFileSync(f, 'x'); process.exit(n === 0 ? 2 : 0);",
    );
    const lines: string[] = [];
    const stop = supervise({ command: process.execPath, args: [fake, runs], cwd: dir, log: (m) => lines.push(m), waitBlocked: 800, waitNormal: 50 });
    await sleep(500);
    expect(count(runs)).toBe(1); // still waiting after the blocked start
    await sleep(1500);
    stop();
    expect(count(runs)).toBeGreaterThanOrEqual(3);
    expect(lines).toContain('hub exited with code 2');
    expect(lines).toContain('hub exited with code 0');
    await sleep(400); // a start just before stop() may still be running
    const after = count(runs);
    await sleep(400);
    expect(count(runs)).toBe(after);
  });

  it('keeps trying when the hub cannot be started at all', async () => {
    const lines: string[] = [];
    const stop = supervise({ command: path.join(os.tmpdir(), 'no-such-node'), args: [], cwd: os.tmpdir(), log: (m) => lines.push(m), waitNormal: 50 });
    await sleep(400);
    stop();
    expect(lines.filter((l) => l.startsWith('could not start the hub')).length).toBeGreaterThanOrEqual(2);
  });
});
