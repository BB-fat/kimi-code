/**
 * `crossProcessLock` domain (L1) — pure-JS `ICrossProcessLockService` implementation.
 *
 * A/B experiment (branch `lock-control-purejs`): the historical pre-kernel
 * lock protocol from `packages/minidb` (removed when the kernel-lock PR
 * landed), ported faithfully and adapted to the `ICrossProcessLockService`
 * contract, so the kernel-backed `CrossProcessLockService` can be swapped for
 * it via `KIMI_LOCK_IMPL=purejs` with the lock primitive as the only changed
 * variable. The DI binding in `crossProcessLockService.ts` reads the env var;
 * delete this file and revert that binding when the experiment ends. Bound at
 * App scope.
 *
 * Protocol (identical to the historical minidb `LockFile`). Acquisition
 * registers a `watch-<pid>-<seq>` sidecar BEFORE touching the lock — every
 * contender is visible to every other for its whole attempt, regardless of
 * where the scheduler stalls it — and reaps sidecars whose owner pid died.
 * It then publishes the lock file atomically (tmp write + hard link,
 * EEXIST-safe); the file carries JSON `{token, pid, hostname, createdAt}`.
 * The `pid` is always the REAL process pid: it is the liveness identity the
 * exclusion rests on, exactly like the kernel implementation's exclusion
 * identity is the real process's open fd (the injectable `selfPid` only feeds
 * the diagnostic owner metadata, on both sides). A held lock is taken over
 * only when that recorded pid is DEAD (`process.kill(pid, 0)`: ESRCH or a
 * missing/garbage pid = dead, EPERM = alive) — never merely because it is
 * old. Takeover replaces the corpse through an atomic bid-rename (never
 * unlink-then-create, which left a window where a loser could delete the
 * winner's just-linked file), re-inspecting the corpse before EVERY rename
 * attempt so a late retry cannot overwrite an already-verified winner, with
 * the Windows EPERM rename retry of the original. After the rename lands,
 * the winner waits out an ADAPTIVE settle — 4x its own attempt's wall clock
 * (a stalled machine stalls every bidder), floored at 60ms and capped at 2s —
 * and re-verifies both that the file still carries its own bid token and that
 * no live foreign watch remains (a contender still in flight registered that
 * watch before its attempt, so waiting for it is what makes exactly-one-winner
 * a construction rather than a timing bet). Residual, inherent to file-based
 * takeover: a bidder whose bid write is delayed past the winner's final
 * verify can still double-win; the watch sweep shrinks the window to
 * "competitor had not even started writing its bid yet", effectively a
 * process-level pause. Held handles are released on `beforeExit` as a
 * safety net.
 *
 * Adaptation to the service contract: `checkHeld()` compares the lock file's
 * dev/ino recorded at acquisition against the current stat (a sentinel that
 * was taken over, replaced, or removed fails closed); `release()` is
 * idempotent, deletes the owner metadata first and the lock file second
 * (the kernel implementation's order), and touches neither once the inode is
 * no longer ours; `inspect()` is a pure advisory read that classifies a
 * dead-pid lock file as 'free' (the next acquire would take it over,
 * mirroring the kernel probe succeeding on a lock the OS already released)
 * and never creates, replaces, or deletes anything; `acquireWithWait` and
 * `withLock` reproduce the kernel implementation's deadline semantics. The
 * protocol's internal waits (rename-retry jitter, adaptive settle) are
 * wall-clock logic and always use real timers; only the acquireWithWait
 * deadline bookkeeping uses the injected clock.
 *
 * Differences from the kernel implementation, by construction: the lock file
 * is DELETED on release (there is no permanent sentinel); exclusion
 * ultimately rests on PID liveness, which misjudges a reused PID; and a
 * crashed holder leaves the lock file (and possibly sidecars) behind for the
 * next acquirer's takeover path. The owner-metadata sidecar
 * (`<lock>.owner.json`) carries the same diagnostic/routing payload as the
 * kernel implementation and is likewise never consulted for lock correctness.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { hostname } from 'node:os';

import { basename, dirname } from 'pathe';
import { ulid } from 'ulid';

import {
  CrossProcessLockError,
  CrossProcessLockErrorCode,
  type CrossProcessLockAcquireOptions,
  type CrossProcessLockInspection,
  type CrossProcessLockOwnerMetadata,
  type CrossProcessLockServiceDeps,
  type CrossProcessLockWaitOptions,
  type ICrossProcessLockHandle,
  ICrossProcessLockService,
} from '#/os/interface/crossProcessLock';

const DEFAULT_WAIT_RETRY_INTERVAL_MS = 50;

const TAKEOVER_SETTLE_BASE_MS = 60;
const TAKEOVER_SETTLE_MAX_MS = 2_000;

const HOSTNAME = hostname();

interface LockFileContent {
  token?: string;
  pid?: number;
  hostname?: string;
  createdAt?: string;
}

interface PrimitiveIdentity {
  dev: number;
  ino: number;
}

interface PrimitiveInspection extends PrimitiveIdentity {
  alive: boolean;
  mine: boolean;
}

interface PersistedLockOwnerMetadata {
  lock_id?: string;
  instance_id?: string;
  pid?: number;
  address?: string;
}

function readErrno(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ownerMetadataPath(lockPath: string): string {
  return `${lockPath}.owner.json`;
}

function toPersistedOwnerMetadata(
  ownerMetadata: CrossProcessLockOwnerMetadata,
): PersistedLockOwnerMetadata {
  return {
    lock_id: ownerMetadata.lockId,
    instance_id: ownerMetadata.instanceId,
    pid: ownerMetadata.pid,
    address: ownerMetadata.address,
  };
}

function fromPersistedOwnerMetadata(
  persistedOwner: PersistedLockOwnerMetadata,
): CrossProcessLockOwnerMetadata | undefined {
  if (
    typeof persistedOwner.lock_id !== 'string' ||
    typeof persistedOwner.instance_id !== 'string' ||
    typeof persistedOwner.pid !== 'number'
  ) {
    return undefined;
  }
  return {
    lockId: persistedOwner.lock_id,
    instanceId: persistedOwner.instance_id,
    pid: persistedOwner.pid,
    address: typeof persistedOwner.address === 'string' ? persistedOwner.address : undefined,
  };
}

function readOwnerMetadata(lockPath: string): CrossProcessLockOwnerMetadata | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(ownerMetadataPath(lockPath), 'utf8'));
    return parsed !== null && typeof parsed === 'object'
      ? fromPersistedOwnerMetadata(parsed as PersistedLockOwnerMetadata)
      : undefined;
  } catch (error) {
    if (readErrno(error) === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function writeOwnerMetadata(
  lockPath: string,
  ownerMetadata: CrossProcessLockOwnerMetadata,
): void {
  const path = ownerMetadataPath(lockPath);
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(toPersistedOwnerMetadata(ownerMetadata)), {
      mode: 0o600,
    });
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

function toLockIoError(error: unknown, path: string, op: string): CrossProcessLockError {
  if (error instanceof CrossProcessLockError) return error;
  return new CrossProcessLockError(
    CrossProcessLockErrorCode.Io,
    `${op} failed on lock ${path}: ${errorMessage(error)}`,
    { details: { path, op, errno: readErrno(error) }, cause: error },
  );
}

function heldError(
  lockPath: string,
  inspection: CrossProcessLockInspection,
): CrossProcessLockError {
  return new CrossProcessLockError(
    CrossProcessLockErrorCode.Held,
    `cross-process lock unavailable (${inspection.state})`,
    { details: { path: lockPath, reason: inspection.state, holder: inspection.ownerMetadata } },
  );
}

function waitTimeoutError(
  lockPath: string,
  timeoutMs: number,
  cause: unknown,
): CrossProcessLockError {
  return new CrossProcessLockError(
    CrossProcessLockErrorCode.WaitTimeout,
    `timed out waiting for the cross-process lock (${timeoutMs}ms)`,
    { details: { path: lockPath, timeoutMs }, cause },
  );
}

function pidAlive(pid: unknown): boolean {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return readErrno(error) === 'EPERM';
  }
}

let sidecarSeq = 0;
const nextSidecarSeq = (): number => ++sidecarSeq;

const HELD = new Set<PureJsLockHandle>();
let exitHooked = false;
function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on('beforeExit', () => {
    for (const handle of HELD) handle.release();
  });
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseLockFile(raw: string, st: PrimitiveIdentity, token: string): PrimitiveInspection {
  let pid: unknown;
  let fileToken: unknown;
  try {
    const content = JSON.parse(raw) as LockFileContent;
    pid = content.pid;
    fileToken = content.token;
  } catch {
    pid = undefined;
    fileToken = undefined;
  }
  return {
    dev: st.dev,
    ino: st.ino,
    alive: pidAlive(pid),
    mine: typeof fileToken === 'string' && fileToken === token,
  };
}

class PureJsLockHandle implements ICrossProcessLockHandle {
  private released = false;

  constructor(
    readonly lockPath: string,
    readonly lockId: string,
    private readonly identity: PrimitiveIdentity,
  ) {
    HELD.add(this);
    hookExit();
  }

  checkHeld(): boolean {
    return !this.released && this.inodeMatches();
  }

  private inodeMatches(): boolean {
    try {
      const st = statSync(this.lockPath);
      return st.dev === this.identity.dev && st.ino === this.identity.ino;
    } catch {
      return false;
    }
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    HELD.delete(this);
    const stillOurs = this.inodeMatches();
    try {
      if (stillOurs) {
        try {
          rmSync(ownerMetadataPath(this.lockPath), { force: true });
        } catch {}
      }
    } finally {
      if (stillOurs) {
        try {
          unlinkSync(this.lockPath);
        } catch {}
      }
    }
  }
}

export class PureJsLockService implements ICrossProcessLockService {
  declare readonly _serviceBrand: undefined;

  private readonly selfPid: number;
  private readonly now: () => number;
  private readonly newLockId: () => string;
  private readonly instanceId: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: CrossProcessLockServiceDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.selfPid = deps.selfPid ?? process.pid;
    this.newLockId = deps.newLockId ?? ulid;
    this.instanceId = deps.instanceId ?? ulid();
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async acquire(
    lockPath: string,
    options: CrossProcessLockAcquireOptions = {},
  ): Promise<ICrossProcessLockHandle> {
    const token = randomUUID();
    const content: LockFileContent = {
      token,
      pid: process.pid,
      hostname: HOSTNAME,
      createdAt: new Date().toISOString(),
    };
    let identity: PrimitiveIdentity | undefined;
    try {
      await fsp.mkdir(dirname(lockPath), { recursive: true });
      identity = await this.acquirePrimitive(lockPath, token, content);
    } catch (error) {
      throw toLockIoError(error, lockPath, 'acquire');
    }
    if (identity === undefined) throw heldError(lockPath, this.inspectHeld(lockPath));

    const lockId = this.newLockId();
    const ownerMetadata: CrossProcessLockOwnerMetadata = {
      lockId,
      instanceId: this.instanceId,
      pid: this.selfPid,
      address: options.address,
    };
    try {
      rmSync(ownerMetadataPath(lockPath), { force: true });
      writeOwnerMetadata(lockPath, ownerMetadata);
      return new PureJsLockHandle(lockPath, lockId, identity);
    } catch (error) {
      try {
        const st = statSync(lockPath);
        if (st.dev === identity.dev && st.ino === identity.ino) unlinkSync(lockPath);
      } catch {}
      throw toLockIoError(error, lockPath, 'write-owner');
    }
  }

  private async acquirePrimitive(
    lockPath: string,
    token: string,
    content: LockFileContent,
  ): Promise<PrimitiveIdentity | undefined> {
    const watch = `${lockPath}.watch-${process.pid}-${nextSidecarSeq()}`;
    await fsp.writeFile(watch, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    try {
      await this.reapDeadWatches(lockPath);

      const created = await this.tryCreate(lockPath, content);
      if (created !== undefined) return created;

      const seen = await this.inspectPrimitive(lockPath, token);
      if (seen === null || seen.alive) return undefined;

      return await this.takeOver(lockPath, token, content);
    } finally {
      await fsp.unlink(watch).catch(() => {});
    }
  }

  private async tryCreate(
    lockPath: string,
    content: LockFileContent,
  ): Promise<PrimitiveIdentity | undefined> {
    const tmp = `${lockPath}.tmp-${process.pid}-${nextSidecarSeq()}`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(content));
      await fsp.link(tmp, lockPath);
      const st = await fsp.stat(lockPath);
      return { dev: st.dev, ino: st.ino };
    } catch (error) {
      if (readErrno(error) !== 'EEXIST') throw error;
      return undefined;
    } finally {
      await fsp.unlink(tmp).catch(() => {});
    }
  }

  private async takeOver(
    lockPath: string,
    token: string,
    content: LockFileContent,
  ): Promise<PrimitiveIdentity | undefined> {
    const bid = `${lockPath}.bid-${process.pid}-${nextSidecarSeq()}`;
    const attemptStart = Date.now();
    try {
      await fsp.writeFile(bid, JSON.stringify(content));
      for (let attempt = 0; ; attempt++) {
        const gate = await this.inspectPrimitive(lockPath, token);
        if (gate === null || gate.alive || gate.mine) {
          await fsp.unlink(bid).catch(() => {});
          return undefined;
        }
        try {
          await fsp.rename(bid, lockPath);
          break;
        } catch (error) {
          const code = readErrno(error);
          const epermRetryable = code === 'EPERM' && process.platform === 'win32' && attempt < 50;
          if (!epermRetryable) {
            await fsp.unlink(bid).catch(() => {});
            if (code === 'EEXIST' || code === 'EPERM') return undefined;
            throw error;
          }
          await realSleep(20 + Math.floor(Math.random() * 30));
        }
      }
    } catch (error) {
      await fsp.unlink(bid).catch(() => {});
      throw error;
    }

    const elapsedMs = Date.now() - attemptStart;
    let settleMs = Math.min(
      TAKEOVER_SETTLE_MAX_MS,
      Math.max(TAKEOVER_SETTLE_BASE_MS, elapsedMs * 4),
    );
    let verified: PrimitiveInspection;
    for (;;) {
      await realSleep(settleMs);
      const cur = await this.inspectPrimitive(lockPath, token);
      if (cur === null || !cur.mine) return undefined;
      verified = cur;
      if (!(await this.hasLiveForeignWatch(lockPath))) break;
      settleMs = Math.min(TAKEOVER_SETTLE_MAX_MS, settleMs * 2);
    }
    return { dev: verified.dev, ino: verified.ino };
  }

  private async inspectPrimitive(
    lockPath: string,
    token: string,
  ): Promise<PrimitiveInspection | null> {
    let raw: string;
    let st: PrimitiveIdentity;
    try {
      [raw, st] = await Promise.all([fsp.readFile(lockPath, 'utf8'), fsp.stat(lockPath)]);
    } catch (error) {
      if (readErrno(error) === 'ENOENT') return null;
      throw error;
    }
    return parseLockFile(raw, st, token);
  }

  private async reapDeadWatches(lockPath: string): Promise<void> {
    const dir = dirname(lockPath);
    const prefix = `${basename(lockPath)}.watch-`;
    for (const f of await fsp.readdir(dir).catch(() => [] as string[])) {
      if (!f.startsWith(prefix)) continue;
      const pid = Number(f.slice(prefix.length).split('-')[0]);
      if (Number.isInteger(pid) && pid !== process.pid && !pidAlive(pid)) {
        await fsp.unlink(`${dir}/${f}`).catch(() => {});
      }
    }
  }

  private async hasLiveForeignWatch(lockPath: string): Promise<boolean> {
    const dir = dirname(lockPath);
    const prefix = `${basename(lockPath)}.watch-`;
    for (const f of await fsp.readdir(dir).catch(() => [] as string[])) {
      if (!f.startsWith(prefix)) continue;
      const pid = Number(f.slice(prefix.length).split('-')[0]);
      if (!Number.isInteger(pid) || pid === process.pid) continue;
      if (pidAlive(pid)) return true;
      await fsp.unlink(`${dir}/${f}`).catch(() => {});
    }
    return false;
  }

  private async acquireWithWait(
    lockPath: string,
    options: CrossProcessLockAcquireOptions & { wait: CrossProcessLockWaitOptions },
  ): Promise<ICrossProcessLockHandle> {
    const deadline = this.now() + options.wait.timeoutMs;
    const retryIntervalMs = options.wait.retryIntervalMs ?? DEFAULT_WAIT_RETRY_INTERVAL_MS;
    let firstAttempt = true;
    let lastHeldError: CrossProcessLockError | undefined;
    for (;;) {
      const isFirstAttempt = firstAttempt;
      if (!isFirstAttempt && this.now() >= deadline) {
        throw waitTimeoutError(lockPath, options.wait.timeoutMs, lastHeldError);
      }
      firstAttempt = false;
      try {
        const handle = await this.acquire(lockPath, options);
        if (!isFirstAttempt && this.now() >= deadline) {
          handle.release();
          throw waitTimeoutError(lockPath, options.wait.timeoutMs, lastHeldError);
        }
        return handle;
      } catch (error) {
        if (
          !(error instanceof CrossProcessLockError) ||
          error.code !== CrossProcessLockErrorCode.Held
        ) {
          throw error;
        }
        lastHeldError = error;
        const remainingMs = deadline - this.now();
        if (remainingMs <= 0) {
          throw waitTimeoutError(lockPath, options.wait.timeoutMs, error);
        }
        await this.sleep(Math.min(retryIntervalMs, remainingMs));
      }
    }
  }

  async withLock<T>(
    lockPath: string,
    options: CrossProcessLockAcquireOptions & { wait: CrossProcessLockWaitOptions },
    fn: (handle: ICrossProcessLockHandle) => T | Promise<T>,
  ): Promise<T> {
    const handle = await this.acquireWithWait(lockPath, options);
    try {
      return await fn(handle);
    } finally {
      handle.release();
    }
  }

  inspect(lockPath: string): CrossProcessLockInspection {
    let raw: string;
    try {
      raw = readFileSync(lockPath, 'utf8');
    } catch (error) {
      if (readErrno(error) === 'ENOENT') return { state: 'free' };
      throw toLockIoError(error, lockPath, 'inspect');
    }
    let pid: unknown;
    try {
      pid = (JSON.parse(raw) as LockFileContent).pid;
    } catch {
      pid = undefined;
    }
    if (!pidAlive(pid)) return { state: 'free' };
    return this.inspectHeld(lockPath);
  }

  private inspectHeld(lockPath: string): CrossProcessLockInspection {
    try {
      const ownerMetadata = readOwnerMetadata(lockPath);
      return ownerMetadata === undefined
        ? { state: 'creating' }
        : { state: 'held', ownerMetadata };
    } catch (error) {
      throw toLockIoError(error, lockPath, 'read-owner');
    }
  }
}
