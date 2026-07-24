// src/lockfile.ts
//
// Writer-exclusion hook for MiniDb, with the lock primitive INVERTED: minidb
// itself ships no locking implementation. The caller injects a `tryAcquire`
// function (see OpenOptions.tryAcquireLock / ClusterOpenOptions.tryAcquireLock)
// that atomically tries to take an exclusive lock on the given path and returns
// a handle, or undefined when the lock is held elsewhere. The host application
// picks the primitive (kernel advisory lock, pure-JS file protocol, ...).
//
// When no `tryAcquire` is injected the database assumes a SINGLE WRITER: every
// acquire succeeds and nothing is protected. This is a documented assumption,
// not a degraded mode — do not rely on it to detect concurrent writers.

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

// Process-wide default acquirer, mirroring kernel-file-lock's binding-loader
// hook: test suites and multi-process helpers (bench/mp workers) install a
// real primitive once here instead of threading the option through hundreds of
// open() call sites. Production code leaves it unset (single-writer assumption
// above) unless the host injects per open().
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

export class LockFile {
  readonly path: string;
  held = false;

  private handle: FileLockHandle | undefined;
  private readonly tryAcquire: TryAcquireFileLock | undefined;

  /** `tryAcquire` tri-state: a function injects the primitive, undefined falls
   *  back to the process-wide default, and null explicitly opts out (the
   *  single-writer assumption, ignoring any installed default). */
  constructor(path: string, tryAcquire?: TryAcquireFileLock | null) {
    this.path = path;
    this.tryAcquire = tryAcquire === null ? undefined : (tryAcquire ?? defaultTryAcquire);
  }

  async acquire(): Promise<boolean> {
    if (this.held) return true;
    // No injected primitive: single-writer assumption, nothing is acquired.
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
