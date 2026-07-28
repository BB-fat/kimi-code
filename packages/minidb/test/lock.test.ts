import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { test } from 'vitest';

import { MiniDb } from '../src/index.js';
import { LockError, LockFile } from '../src/lockfile.js';
import type { FileLockHandle } from '../src/lockfile.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-lock-'));
}

async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

test('a second writer on the same dir is rejected with LockError', async () => {
  const dir = await tmpDir();
  const db1 = await MiniDb.open({ dir, valueCodec: 'string' });
  try {
    await assert.rejects(() => MiniDb.open({ dir, valueCodec: 'string' }), LockError);
  } finally {
    await db1.close();
    await cleanup(dir);
  }
});

test('lock is released on close, allowing another writer', async () => {
  const dir = await tmpDir();
  const db1 = await MiniDb.open({ dir, valueCodec: 'string' });
  await db1.set('a', '1');
  await db1.close();

  const db2 = await MiniDb.open({ dir, valueCodec: 'string' });
  assert.equal(db2.get('a'), '1');
  await db2.close();
  await cleanup(dir);
});

test('readOnly open succeeds alongside a writer and rejects writes', async () => {
  const dir = await tmpDir();
  const db1 = await MiniDb.open({ dir, valueCodec: 'string' });
  await db1.set('a', '1');
  try {
    const ro = await MiniDb.open({ dir, valueCodec: 'string', readOnly: true });
    assert.equal(ro.readOnly, true);
    assert.equal(ro.get('a'), '1');
    await assert.rejects(() => ro.set('b', '2'), /read-only/);
    await ro.close();
  } finally {
    await db1.close();
    await cleanup(dir);
  }
});

test("onLockFail: 'readonly' degrades instead of throwing", async () => {
  const dir = await tmpDir();
  const db1 = await MiniDb.open({ dir, valueCodec: 'string' });
  try {
    const db2 = await MiniDb.open({ dir, valueCodec: 'string', onLockFail: 'readonly' });
    assert.equal(db2.readOnly, true);
    await db2.close();
  } finally {
    await db1.close();
    await cleanup(dir);
  }
});

test('a pre-existing lock file whose owner pid is dead is taken over', async () => {
  const dir = await tmpDir();
  const lockPath = path.join(dir, 'db.lock');
  // A corpse left by a crashed holder: the recorded pid is certainly dead
  // (the child already exited by the time spawnSync returned).
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
  await fs.writeFile(lockPath, JSON.stringify({ pid: deadPid, lock_id: 'legacy' }));

  const db = await MiniDb.open({ dir, valueCodec: 'string' });
  await db.set('a', '1');
  assert.equal(db.get('a'), '1');
  // The takeover replaced the corpse through the bid-rename: the lock file now
  // carries this process's live pid and its own token.
  const content = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { pid?: number; token?: string };
  assert.equal(content.pid, process.pid);
  assert.equal(typeof content.token, 'string');
  await db.close();

  // Release deletes the lock file (there is no permanent sentinel).
  assert.equal(await fs.readFile(lockPath, 'utf8').then(() => 'present', () => 'absent'), 'absent');
  assert.equal((await fs.readdir(dir)).some((entry) => entry.includes('.stale.')), false);
  await cleanup(dir);
});

test('releaseSync is idempotent', async () => {
  const dir = await tmpDir();
  const lock = new LockFile(path.join(dir, 'db.lock'));
  assert.doesNotThrow(() => lock.releaseSync());
  assert.equal(await lock.acquire(), true);
  lock.releaseSync();
  assert.doesNotThrow(() => lock.releaseSync());
  await cleanup(dir);
});

test('an injected acquirer returning undefined rejects the second writer', async () => {
  const dir = await tmpDir();
  // A fake primitive that holds every path forever: the second open must be
  // rejected without minidb knowing anything about the real lock mechanism.
  const heldHandle: FileLockHandle = { checkHeld: () => true, release: () => {} };
  let taken = false;
  const tryAcquire = (): FileLockHandle | undefined => {
    if (taken) return undefined;
    taken = true;
    return heldHandle;
  };
  const db1 = await MiniDb.open({ dir, valueCodec: 'string', tryAcquireLock: tryAcquire });
  try {
    await assert.rejects(() => MiniDb.open({ dir, valueCodec: 'string', tryAcquireLock: tryAcquire }), LockError);
  } finally {
    await db1.close();
    await cleanup(dir);
  }
});

test("an explicit null acquirer opts out: single-writer assumption, nothing protected", async () => {
  const dir = await tmpDir();
  // Documented behavior, NOT protection: with locking explicitly disabled,
  // two writers open the same directory concurrently.
  const db1 = await MiniDb.open({ dir, valueCodec: 'string', tryAcquireLock: null });
  const db2 = await MiniDb.open({ dir, valueCodec: 'string', tryAcquireLock: null });
  assert.equal(db1.readOnly, false);
  assert.equal(db2.readOnly, false);
  await db1.close();
  await db2.close();
  await cleanup(dir);
});
