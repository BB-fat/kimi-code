/**
 * `os` test stubs — shared cross-process-lock pass-through for unit tests.
 *
 * `stubCrossProcessLock()` mirrors the real service's mutual-exclusion
 * semantics (a held path rejects further acquisitions) without touching the
 * filesystem, for tests whose suite is otherwise fully in-memory. Lives under
 * `test/` (not `src/`) so test-support code stays out of the production tree.
 * Import from a relative path (`./stubs` or `../os/stubs`).
 *
 * `realCrossProcessLock()` is the A/B experiment (branch lock-control-purejs)
 * switch point: lock-related suites run twice, once per `KIMI_LOCK_IMPL`
 * value, and construct the implementation under test through this factory so
 * the primitive is the only changed variable.
 */

import { CrossProcessLockService } from '#/os/backends/node-local/crossProcessLockService';
import { PureJsLockService } from '#/os/backends/node-local/pureJsLockService';
import {
  CrossProcessLockError,
  CrossProcessLockErrorCode,
  type CrossProcessLockInspection,
  type CrossProcessLockServiceDeps,
  type ICrossProcessLockHandle,
  type ICrossProcessLockService,
} from '#/os/interface/crossProcessLock';

/** The lock implementation under test: 'kernel' unless KIMI_LOCK_IMPL=purejs. */
export const LOCK_IMPL = process.env['KIMI_LOCK_IMPL'] === 'purejs' ? ('purejs' as const) : ('kernel' as const);

export function realCrossProcessLock(
  deps: CrossProcessLockServiceDeps = {},
): ICrossProcessLockService {
  return LOCK_IMPL === 'purejs' ? new PureJsLockService(deps) : new CrossProcessLockService(deps);
}

export function stubCrossProcessLock(): ICrossProcessLockService {
  const held = new Set<string>();
  const acquireHandle = (lockPath: string): ICrossProcessLockHandle => {
    if (held.has(lockPath)) {
      throw new CrossProcessLockError(
        CrossProcessLockErrorCode.Held,
        `cross-process lock unavailable (held): ${lockPath}`,
        { details: { path: lockPath, reason: 'held' } },
      );
    }
    held.add(lockPath);
    let released = false;
    return {
      lockPath,
      lockId: 'stub-lock',
      checkHeld: () => !released,
      release: () => {
        if (released) return;
        released = true;
        held.delete(lockPath);
      },
    };
  };
  return {
    _serviceBrand: undefined,
    acquire: (lockPath) => Promise.resolve(acquireHandle(lockPath)),
    withLock: async <T>(
      lockPath: string,
      _options: Parameters<ICrossProcessLockService['withLock']>[1],
      fn: (handle: ICrossProcessLockHandle) => T | Promise<T>,
    ): Promise<T> => {
      const handle = acquireHandle(lockPath);
      try {
        return await fn(handle);
      } finally {
        handle.release();
      }
    },
    inspect: (lockPath): CrossProcessLockInspection =>
      held.has(lockPath) ? { state: 'held' } : { state: 'free' },
  };
}
