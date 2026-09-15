import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { hostname } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { Fault } from './vmix.js';

export interface Operation {
  id: string;
  fingerprint: string;
  status: 'running' | 'completed' | 'failed' | 'partial' | 'unconfirmed';
  startedAt: string;
  finishedAt?: string;
  steps: unknown[];
  result?: unknown;
  error?: unknown;
}
export interface Stored {
  operations: Record<string, Operation>;
  transitions: Record<string, any>;
  triggers: Record<string, any>;
}
export const fingerprint = (x: unknown) =>
  createHash('sha256').update(JSON.stringify(x)).digest('hex');
export class Store {
  data: Stored = { operations: {}, transitions: {}, triggers: {} };
  private lock?: Awaited<ReturnType<typeof open>>;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(public dir: string) {}
  async init() {
    await mkdir(this.dir, { recursive: true });
    try {
      this.lock = await open(path.join(this.dir, 'process.lock'), 'wx');
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      await this.recoverDeadOwner();
    }
    if (!this.lock) throw new Fault('STATE_LOCKED', 'Failed to acquire state directory lock');
    await this.lock.writeFile(
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        token: randomUUID(),
        startedAt: new Date().toISOString(),
      }),
    );
    try {
      const raw = JSON.parse(await readFile(path.join(this.dir, 'state.json'), 'utf8'));
      if (!raw.operations || !raw.transitions || !raw.triggers) throw new Error('bad state');
      this.data = raw;
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        await this.close();
        throw new Fault(
          'STATE_CORRUPT',
          'Cannot load state.json; preserve it and repair before starting',
        );
      }
    }
    for (const op of Object.values(this.data.operations))
      if (op.status === 'running') {
        op.status = 'unconfirmed';
        op.error = {
          code: 'RESTART',
          message: 'Interrupted operation: inspect vMix before issuing a new request',
        };
      }
    await this.save();
  }
  private async recoverDeadOwner() {
    const lockPath = path.join(this.dir, 'process.lock'),
      claimPath = path.join(this.dir, 'recovery.lock');
    let claim;
    try {
      claim = await open(claimPath, 'wx');
    } catch {
      throw new Fault('STATE_LOCKED', 'Another process owns/recovering this data directory');
    }
    try {
      const raw = await readFile(lockPath, 'utf8');
      let owner;
      try {
        owner = JSON.parse(raw);
      } catch {
        throw new Fault(
          'STATE_LOCKED',
          'Unrecognised lock; verify no server is running before removing process.lock',
        );
      }
      if (owner.host !== hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0)
        throw new Fault('STATE_LOCKED', 'Unknown or remote lock owner; manual inspection required');
      let dead = false;
      try {
        process.kill(owner.pid, 0);
      } catch (error: any) {
        dead = error.code === 'ESRCH';
      }
      if (!dead) throw new Fault('STATE_LOCKED', 'Another process still owns this data directory');
      // The recovery claim serializes stale-owner recovery. A normal concurrent opener
      // may win after unlink; exclusive open below then fails without touching its lock.
      if ((await readFile(lockPath, 'utf8')) !== raw)
        throw new Fault('STATE_LOCKED', 'Lock owner changed during recovery');
      await unlink(lockPath);
      try {
        this.lock = await open(lockPath, 'wx');
      } catch {
        throw new Fault('STATE_LOCKED', 'Another process acquired the data directory');
      }
    } finally {
      await claim.close();
      await unlink(claimPath);
    }
  }
  async save() {
    const content = JSON.stringify(this.data, null, 2);
    const job = this.tail.then(async () => {
      const temp = path.join(this.dir, `${randomUUID()}.tmp`);
      const file = await open(temp, 'wx');
      try {
        await file.writeFile(content, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, path.join(this.dir, 'state.json'));
    });
    this.tail = job.catch(() => {});
    await job;
  }
  async close() {
    await this.tail;
    if (this.lock) {
      await this.lock.close();
      this.lock = undefined;
      await unlink(path.join(this.dir, 'process.lock'));
    }
  }
}
