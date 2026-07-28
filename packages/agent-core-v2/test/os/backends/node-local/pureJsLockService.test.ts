/**
 * `crossProcessLock` domain — node-local lock integration tests.
 *
 * Exercises acquisition, diagnostic owner metadata, fail-fast and waiting
 * acquisition, takeover, and release behavior of the pure-JS lock service
 * against a real temporary directory: contract cases first, then the
 * primitive-specific shapes (lock file deleted on release, PID-liveness
 * takeover).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CrossProcessLockErrorCode,
  type CrossProcessLockServiceDeps,
  type ICrossProcessLockHandle,
  type ICrossProcessLockService,
} from '#/os/interface/crossProcessLock';

import { realCrossProcessLock } from '../../stubs';

let tmpDir: string;
let lockPath: string;
const handles: ICrossProcessLockHandle[] = [];

function service(
  instanceId: string,
  pid: number,
  deps: Pick<CrossProcessLockServiceDeps, 'now' | 'sleep'> = {},
): ICrossProcessLockService {
  let sequence = 0;
  return realCrossProcessLock({
    ...deps,
    instanceId,
    selfPid: pid,
    newLockId: () => `${instanceId}-${++sequence}`,
  });
}

function ownerPath(): string {
  return `${lockPath}.owner.json`;
}

/** A pid that is certainly dead: a child that already exited by the time
 *  spawnSync returned. */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-lock-'));
  lockPath = join(tmpDir, 'resource.lock');
});

afterEach(() => {
  for (const handle of handles.splice(0)) handle.release();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('crossProcessLock contract', () => {
  it('rejects a second holder in the same process', async () => {
    const first = await service('alpha', 1001).acquire(lockPath);
    handles.push(first);

    await expect(service('beta', 2002).acquire(lockPath)).rejects.toMatchObject({
      code: CrossProcessLockErrorCode.Held,
      details: { path: lockPath, reason: 'held' },
    });
  });

  it('reports creating when a holder has no readable owner metadata', async () => {
    const lock = service('alpha', 1001);
    const handle = await lock.acquire(lockPath);
    handles.push(handle);
    writeFileSync(ownerPath(), '{');

    expect(lock.inspect(lockPath)).toEqual({ state: 'creating' });
  });

  it('times out waiting for a held lock', async () => {
    const first = await service('alpha', 1001).acquire(lockPath);
    handles.push(first);

    await expect(
      service('beta', 2002).withLock(lockPath, { wait: { timeoutMs: 15, retryIntervalMs: 5 } }, () => {}),
    ).rejects.toMatchObject({ code: CrossProcessLockErrorCode.WaitTimeout });
  });

  it('withLock releases after the callback throws', async () => {
    const lock = service('alpha', 1001);
    await expect(
      lock.withLock(lockPath, { wait: { timeoutMs: 100 } }, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const next = await service('beta', 2002).acquire(lockPath);
    handles.push(next);
    expect(next.checkHeld()).toBe(true);
  });

  it('release is idempotent and checkHeld fails closed afterwards', async () => {
    const handle = await service('alpha', 1001).acquire(lockPath);
    handle.release();
    handle.release();

    expect(handle.checkHeld()).toBe(false);
  });
});

describe('pure-JS primitive shape', () => {
  it('release deletes the lock file and owner metadata', async () => {
    const handle = await service('alpha', 1001).acquire(lockPath);
    handle.release();

    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(ownerPath())).toBe(false);
  });

  it('takes over a lock whose owner pid is dead', async () => {
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: deadPid(),
        hostname: 'example.test',
        createdAt: new Date().toISOString(),
      }),
    );

    const lock = service('alpha', 1001);
    const handle = await lock.acquire(lockPath);
    handles.push(handle);

    expect(handle.checkHeld()).toBe(true);
    // The corpse was replaced by our own live-pid lock file...
    const content = JSON.parse(readFileSync(lockPath, 'utf8')) as { token?: string; pid?: number };
    expect(content.pid).toBe(process.pid);
    expect(typeof content.token).toBe('string');
    // ...and owner metadata was published, so inspect classifies as held.
    const inspection = lock.inspect(lockPath);
    expect(inspection.state).toBe('held');
    expect(inspection.ownerMetadata).toMatchObject({ instanceId: 'alpha', pid: 1001 });
  });

  it("leaves a live owner's lock untouched", async () => {
    const corpse = JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() });
    writeFileSync(lockPath, corpse);

    await expect(service('beta', 2002).acquire(lockPath)).rejects.toMatchObject({
      code: CrossProcessLockErrorCode.Held,
    });
    expect(readFileSync(lockPath, 'utf8')).toBe(corpse);
  });

  it("a dead owner's lock is taken over by exactly one racer", async () => {
    writeFileSync(lockPath, JSON.stringify({ pid: deadPid() }));

    const [a, b] = await Promise.allSettled([
      service('alpha', 1001).acquire(lockPath),
      service('beta', 2002).acquire(lockPath),
    ]);

    const winners = [a, b].filter((r) => r.status === 'fulfilled');
    const losers = [a, b].filter((r) => r.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as PromiseRejectedResult).reason).toMatchObject({
      code: CrossProcessLockErrorCode.Held,
    });
    const winner = (winners[0] as PromiseFulfilledResult<ICrossProcessLockHandle>).value;
    handles.push(winner);
    expect(winner.checkHeld()).toBe(true);
  });

  it('fails checkHeld after the lock file is replaced externally', async () => {
    const first = await service('alpha', 1001).acquire(lockPath);
    handles.push(first);
    // Simulate an external replacement (a supervisor re-plant, a takeover
    // after this process's death): the inode the handle holds is gone.
    rmSync(lockPath);
    const second = await service('beta', 2002).acquire(lockPath);
    handles.push(second);

    expect(first.checkHeld()).toBe(false);
    expect(second.checkHeld()).toBe(true);
  });
});
