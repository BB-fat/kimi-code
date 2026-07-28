// src/lockfile.ts
//
// Writer-exclusion lock for MiniDb: a pure-Node.js cross-process lock built on
// atomic filesystem primitives (zero dependencies, no native addons), with the
// primitive INVERTIBLE so tests and hosts can inject a different one.
//
// The built-in protocol below is the default. Acquisition registers a
// `watch-<pid>-<seq>` sidecar BEFORE touching the lock — every contender is
// visible to every other for its whole attempt, regardless of where the
// scheduler stalls it — and reaps sidecars whose owner pid died. It then
// publishes the lock file atomically (tmp write + hard link, EEXIST-safe); the
// file carries JSON `{token, pid, hostname, createdAt}`. A held lock is taken
// over only when the recorded pid is DEAD (`process.kill(pid, 0)`: ESRCH or a
// missing/garbage pid = dead, EPERM = alive) — never merely because it is old.
// Takeover replaces the corpse through an atomic bid-rename (never
// unlink-then-create, which left a window where a loser could delete the
// winner's just-linked file), re-inspecting the corpse before EVERY rename
// attempt so a late retry cannot overwrite an already-verified winner, with
// the Windows EPERM rename retry of the original. After the rename lands, the
// winner waits out an ADAPTIVE settle — 4x its own attempt's wall clock (a
// stalled machine stalls every bidder), floored at 60ms and capped at 2s — and
// re-verifies both that the file still carries its own bid token and that no
// live foreign watch remains (a contender still in flight registered that
// watch before its attempt, so waiting for it is what makes exactly-one-winner
// a construction rather than a timing bet). Held handles are released on
// `beforeExit` as a safety net.
//
// Known boundaries of the built-in protocol, by construction: liveness rests
// on PID probing, so it is only meaningful for processes in the SAME pid
// namespace — a lock directory shared across hosts (NFS) or containers
// (separate namespaces) makes a live holder look dead; a reused PID makes a
// dead holder look alive (the lock then waits for the unrelated process to
// exit — safe direction); a crashed holder leaves the lock file (and possibly
// sidecars) behind for the next acquirer's takeover path; and a bidder whose
// bid write is delayed past the winner's final verify can still double-win —
// the watch sweep shrinks that window to "competitor had not even started
// writing its bid yet", effectively a process-level pause.
//
// Injection contract (OpenOptions.tryAcquireLock / ClusterOpenOptions
// .tryAcquireLock): a function replaces the built-in primitive; undefined
// falls back to the process-wide default (setDefaultTryAcquireFileLock) and
// then to the built-in protocol; null explicitly opts out — the single-writer
// assumption, nothing is protected. That is a documented assumption, not a
// degraded mode: do not rely on it to detect concurrent writers.

import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';

/** A held exclusive lock on `path`. Implementations must be safe to release
 *  more than once and must report a lost lock via checkHeld() === false. */
export interface FileLockHandle {
  checkHeld(): boolean;
  release(): void;
}

/** Try to take the exclusive lock on `lockPath` exactly once. Returns the held
 *  handle, or undefined when the lock is held by someone else. May complete
 *  asynchronously (e.g. a takeover protocol that waits out a settle window).
 *  I/O failures must throw, not resolve undefined. */
export type TryAcquireFileLock = (
  lockPath: string,
) => FileLockHandle | undefined | Promise<FileLockHandle | undefined>;

// Process-wide default acquirer: test suites and multi-process helpers
// (bench/mp workers) install a primitive once here instead of threading the
// option through hundreds of open() call sites. Production code leaves it
// unset and gets the built-in pure-JS protocol.
let defaultTryAcquire: TryAcquireFileLock | undefined;

/** Install (or clear, with undefined) the process-wide default lock acquirer. */
export function setDefaultTryAcquireFileLock(tryAcquire: TryAcquireFileLock | undefined): void {
  defaultTryAcquire = tryAcquire;
}

export class LockError extends Error {
  readonly code = 'ELOCKED';

  constructor(message: string) {
    super(message);
    this.name = 'LockError';
  }
}

// ---------------------------------------------------------------------------
// Built-in pure-JS lock protocol (see the file header for the full narrative)
// ---------------------------------------------------------------------------

const TAKEOVER_SETTLE_BASE_MS = 60;
const TAKEOVER_SETTLE_MAX_MS = 2_000;

const HOSTNAME = hostname();

interface LockFileContent {
  token?: string;
  pid?: number;
}

interface LockIdentity {
  dev: number;
  ino: number;
}

interface LockInspection extends LockIdentity {
  alive: boolean;
  mine: boolean;
}

function readErrno(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
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

// Distinct sidecar names per acquire attempt: two lock users in the same
// process (e.g. independent shard pools) must never share a tmp/bid/watch
// path, or one user's cleanup would delete the other's in-flight file.
let sidecarSeq = 0;
const nextSidecarSeq = (): number => ++sidecarSeq;

// Track held locks so we can release them on process exit as a safety net.
const HELD = new Set<PureJsFileLockHandle>();
let exitHooked = false;
function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on('beforeExit', () => {
    for (const handle of HELD) handle.release();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read the lock file and decide its state. null = the file vanished. */
async function inspect(lockPath: string, token: string): Promise<LockInspection | null> {
  let raw: string;
  let st: LockIdentity;
  try {
    [raw, st] = await Promise.all([fs.readFile(lockPath, 'utf8'), fs.stat(lockPath)]);
  } catch (error) {
    if (readErrno(error) === 'ENOENT') return null;
    throw error;
  }
  let pid: unknown;
  let fileToken: unknown;
  try {
    const content = JSON.parse(raw) as LockFileContent;
    pid = content.pid;
    fileToken = content.token;
  } catch {
    // Unparsable content looks abandoned, same as a dead PID.
    pid = undefined;
    fileToken = undefined;
  }
  return { dev: st.dev, ino: st.ino, alive: pidAlive(pid), mine: fileToken === token };
}

/** Atomic create-if-absent publish: tmp write + hard link (EEXIST-safe). */
async function tryCreate(lockPath: string, content: string): Promise<LockIdentity | undefined> {
  const tmp = `${lockPath}.tmp-${process.pid}-${nextSidecarSeq()}`;
  try {
    await fs.writeFile(tmp, content);
    await fs.link(tmp, lockPath);
    const st = await fs.stat(lockPath);
    return { dev: st.dev, ino: st.ino };
  } catch (error) {
    if (readErrno(error) !== 'EEXIST') throw error;
    return undefined;
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

/** Delete watch registrations whose owner pid is no longer alive. */
async function reapDeadWatches(lockPath: string): Promise<void> {
  const dir = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.watch-`;
  for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
    if (!f.startsWith(prefix)) continue;
    const pid = Number(f.slice(prefix.length).split('-')[0]);
    if (Number.isInteger(pid) && pid !== process.pid && !pidAlive(pid)) {
      await fs.unlink(path.join(dir, f)).catch(() => {});
    }
  }
}

/** True when any OTHER process's liveness watch exists (reaping dead ones on sight). */
async function hasLiveForeignWatch(lockPath: string): Promise<boolean> {
  const dir = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.watch-`;
  for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
    if (!f.startsWith(prefix)) continue;
    const pid = Number(f.slice(prefix.length).split('-')[0]);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    if (pidAlive(pid)) return true;
    await fs.unlink(path.join(dir, f)).catch(() => {});
  }
  return false;
}

/** Take over a dead owner's lock via atomic bid-replace, then prove the win by
 *  waiting out an adaptive settle window (see the file header). */
async function takeOver(
  lockPath: string,
  token: string,
  content: string,
): Promise<LockIdentity | undefined> {
  const bid = `${lockPath}.bid-${process.pid}-${nextSidecarSeq()}`;
  const attemptStart = Date.now();
  try {
    await fs.writeFile(bid, content);
    for (let attempt = 0; ; attempt++) {
      // The corpse must still be there and dead. A competitor who landed wins
      // by being alive in the file now — back off instead of overwriting
      // their lock. (Unconditional, not just win32: the same overwrite hazard
      // exists on POSIX when a co-bidder is descheduled between its first
      // inspect and its rename.)
      const gate = await inspect(lockPath, token);
      if (gate === null || gate.alive || gate.mine) {
        await fs.unlink(bid).catch(() => {});
        return undefined;
      }
      try {
        await fs.rename(bid, lockPath);
        break;
      } catch (error) {
        const code = readErrno(error);
        // Windows cannot rename over a destination while ANY process holds it
        // open (co-racers reading/stat'ing the corpse make the rename EPERM),
        // so the rename is retried with jitter.
        const epermRetryable = code === 'EPERM' && process.platform === 'win32' && attempt < 50;
        if (!epermRetryable) {
          await fs.unlink(bid).catch(() => {});
          // EEXIST races another creator; a persistent EPERM (Windows retries
          // exhausted) means some holder kept the path pinned — either way the
          // corpse could not be displaced this round, so decline like a live
          // lock and let callers retry higher up.
          if (code === 'EEXIST' || code === 'EPERM') return undefined;
          throw error;
        }
        await sleep(20 + Math.floor(Math.random() * 30));
      }
    }
  } catch (error) {
    await fs.unlink(bid).catch(() => {});
    throw error;
  }

  // Adaptive settle: scale with how long our own attempt took (a stalled
  // machine stalls every bidder), floored and capped (see the constants).
  const elapsedMs = Date.now() - attemptStart;
  let settleMs = Math.min(TAKEOVER_SETTLE_MAX_MS, Math.max(TAKEOVER_SETTLE_BASE_MS, elapsedMs * 4));
  let verified: LockInspection;
  for (;;) {
    await sleep(settleMs);
    const cur = await inspect(lockPath, token);
    if (cur === null || !cur.mine) return undefined;
    verified = cur;
    // Any live foreign watch means a contender is still in flight (its
    // registration precedes its whole attempt): wait for its loop to finish
    // instead of claiming on stale evidence. This is the check that makes
    // exactly-one a construction, not a timing bet.
    if (!(await hasLiveForeignWatch(lockPath))) break;
    settleMs = Math.min(TAKEOVER_SETTLE_MAX_MS, settleMs * 2);
  }
  return { dev: verified.dev, ino: verified.ino };
}

class PureJsFileLockHandle implements FileLockHandle {
  private released = false;

  constructor(
    private readonly lockPath: string,
    private readonly identity: LockIdentity,
  ) {
    HELD.add(this);
    hookExit();
  }

  checkHeld(): boolean {
    return !this.released && this.inodeMatches();
  }

  private inodeMatches(): boolean {
    try {
      const st = fsSync.statSync(this.lockPath);
      return st.dev === this.identity.dev && st.ino === this.identity.ino;
    } catch {
      return false;
    }
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    HELD.delete(this);
    // Unlink ONLY the file this handle actually owns. The content at this
    // path may have been replaced since we acquired it (a concurrent
    // takeover…), and deleting such a file would drop a lock that no longer
    // belongs to us. The dev/ino recorded at acquisition is the proof.
    if (!this.inodeMatches()) return;
    try {
      fsSync.unlinkSync(this.lockPath);
    } catch {}
  }
}

/** The built-in pure-JS lock primitive: try to take the exclusive lock on
 *  `lockPath` exactly once; undefined when a live holder (or a competing
 *  takeover) beat us to it. */
async function tryAcquirePureJsFileLock(lockPath: string): Promise<FileLockHandle | undefined> {
  const token = randomUUID();
  const content = JSON.stringify({
    token,
    pid: process.pid,
    hostname: HOSTNAME,
    createdAt: new Date().toISOString(),
  });
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  const watch = `${lockPath}.watch-${process.pid}-${nextSidecarSeq()}`;
  await fs.writeFile(watch, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  try {
    await reapDeadWatches(lockPath);

    const created = await tryCreate(lockPath, content);
    if (created !== undefined) return new PureJsFileLockHandle(lockPath, created);

    // The lock exists. Only a DEAD owner's lock may be taken over; everything
    // else (a live owner, or a takeover bid made by another racer in the
    // meantime) is respected.
    const seen = await inspect(lockPath, token);
    if (seen === null || seen.alive) return undefined;

    const identity = await takeOver(lockPath, token, content);
    return identity === undefined ? undefined : new PureJsFileLockHandle(lockPath, identity);
  } finally {
    await fs.unlink(watch).catch(() => {});
  }
}

export class LockFile {
  readonly path: string;
  held = false;

  private handle: FileLockHandle | undefined;
  private readonly tryAcquire: TryAcquireFileLock | undefined;

  /** `tryAcquire` tri-state: a function injects the primitive, undefined falls
   *  back to the process-wide default and then to the built-in pure-JS
   *  protocol, and null explicitly opts out (the single-writer assumption,
   *  ignoring any installed default). */
  constructor(path: string, tryAcquire?: TryAcquireFileLock | null) {
    this.path = path;
    this.tryAcquire =
      tryAcquire === null
        ? undefined
        : (tryAcquire ?? defaultTryAcquire ?? tryAcquirePureJsFileLock);
  }

  async acquire(): Promise<boolean> {
    if (this.held) return true;
    // Explicit opt-out: single-writer assumption, nothing is acquired.
    if (this.tryAcquire === undefined) {
      this.held = true;
      return true;
    }
    const handle = await this.tryAcquire(this.path);
    if (handle === undefined) return false;
    this.handle = handle;
    this.held = true;
    return true;
  }

  checkHeld(): boolean {
    if (!this.held) return false;
    if (this.handle === undefined) return true; // single-writer assumption
    if (this.handle.checkHeld()) return true;
    this.markLost();
    return false;
  }

  assertHeld(): void {
    if (!this.checkHeld()) throw new LockError(`database write lock was lost: ${this.path}`);
  }

  releaseSync(): void {
    if (!this.held) return;
    this.held = false;
    const handle = this.handle;
    this.handle = undefined;
    handle?.release();
  }

  private markLost(): void {
    this.releaseSync();
  }
}
