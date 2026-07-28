/**
 * `sessionHostRuntime` domain — the host-runtime registry (plan §3.1).
 *
 * The registry holds LONG-LIVED, multi-session host runtimes — never
 * per-session wrappers. It owns no session catalog, merges no metadata and
 * does no persistence; it only maps `runtimeId → ISessionHostRuntime` and
 * reports status, so routing failures can be accurate:
 *
 *   - unknown id      → `session.runtime_not_found`
 *   - registered but
 *     offline entry   → `session.runtime_unavailable` (entries are kept, not
 *                       dropped, exactly so this distinction survives)
 *
 * One `runtimeId` hosts ONE runtime instance: registering a different
 * instance under a taken id fails with `session.runtime_id_conflict`.
 * Disposing a registration only removes routing — it never deletes the
 * runtime's session data.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter } from '#/_base/event';

import {
  SessionHostRuntimeError,
  SessionHostRuntimeErrors,
} from './errors';
import type {
  ISessionHostRuntime,
  SessionRuntimeCapability,
  SessionRuntimeStatus,
} from './sessionHostRuntime';

export interface SessionHostRuntimeSummary {
  readonly id: string;
  readonly kind: string;
  readonly status: SessionRuntimeStatus;
  readonly capabilities: readonly SessionRuntimeCapability[];
}

export interface SessionHostRuntimeRegistryEvent {
  readonly kind: 'registered' | 'unregistered';
  readonly runtime: SessionHostRuntimeSummary;
}

export interface ISessionHostRuntimeRegistry {
  readonly _serviceBrand: undefined;

  /**
   * Register a long-lived runtime. Returns the registration lease; disposing
   * it unregisters the runtime (routing only — session data is untouched).
   * Throws `session.runtime_id_conflict` when a DIFFERENT instance already
   * holds the id; re-registering the same instance is a no-op.
   */
  register(runtime: ISessionHostRuntime): IDisposable;
  get(runtimeId: string): ISessionHostRuntime | undefined;
  /**
   * Like `get`, but throws `session.runtime_not_found` for unknown ids and
   * `session.runtime_unavailable` for offline entries.
   */
  require(runtimeId: string): ISessionHostRuntime;
  list(): readonly SessionHostRuntimeSummary[];
  watch(listener: (event: SessionHostRuntimeRegistryEvent) => void): IDisposable;
}

export const ISessionHostRuntimeRegistry: ServiceIdentifier<ISessionHostRuntimeRegistry> =
  createDecorator<ISessionHostRuntimeRegistry>('sessionHostRuntimeRegistry');

function summarize(runtime: ISessionHostRuntime): SessionHostRuntimeSummary {
  return {
    id: runtime.id,
    kind: runtime.kind,
    status: runtime.status(),
    capabilities: [...runtime.capabilities()],
  };
}

/**
 * The in-process registry implementation. Registered as an App-scope service
 * but activated on demand: nothing instantiates it until a composition root
 * (M1+) actually injects it.
 */
export class SessionHostRuntimeRegistry implements ISessionHostRuntimeRegistry {
  declare readonly _serviceBrand: undefined;

  private readonly runtimes = new Map<string, ISessionHostRuntime>();
  private readonly emitter = new Emitter<SessionHostRuntimeRegistryEvent>();

  register(runtime: ISessionHostRuntime): IDisposable {
    const existing = this.runtimes.get(runtime.id);
    if (existing !== undefined) {
      if (existing === runtime) return Disposable.None;
      throw new SessionHostRuntimeError(
        SessionHostRuntimeErrors.codes.SESSION_RUNTIME_ID_CONFLICT,
        `session host runtime '${runtime.id}' is already registered`,
        { details: { runtimeId: runtime.id } },
      );
    }
    this.runtimes.set(runtime.id, runtime);
    this.emitter.fire({ kind: 'registered', runtime: summarize(runtime) });
    return toDisposable(() => {
      // Only the instance that registered may unregister: a stale lease must
      // not evict a later registration under the same id.
      if (this.runtimes.get(runtime.id) !== runtime) return;
      this.runtimes.delete(runtime.id);
      this.emitter.fire({ kind: 'unregistered', runtime: summarize(runtime) });
    });
  }

  get(runtimeId: string): ISessionHostRuntime | undefined {
    return this.runtimes.get(runtimeId);
  }

  require(runtimeId: string): ISessionHostRuntime {
    const runtime = this.runtimes.get(runtimeId);
    if (runtime === undefined) {
      throw new SessionHostRuntimeError(
        SessionHostRuntimeErrors.codes.SESSION_RUNTIME_NOT_FOUND,
        `session host runtime '${runtimeId}' is not registered`,
        { details: { runtimeId } },
      );
    }
    if (runtime.status() === 'offline') {
      throw new SessionHostRuntimeError(
        SessionHostRuntimeErrors.codes.SESSION_RUNTIME_UNAVAILABLE,
        `session host runtime '${runtimeId}' is unavailable (offline)`,
        { details: { runtimeId, status: runtime.status() } },
      );
    }
    return runtime;
  }

  list(): readonly SessionHostRuntimeSummary[] {
    return [...this.runtimes.values()].map(summarize);
  }

  watch(listener: (event: SessionHostRuntimeRegistryEvent) => void): IDisposable {
    return this.emitter.event(listener);
  }
}

registerScopedService(
  LifecycleScope.App,
  ISessionHostRuntimeRegistry,
  SessionHostRuntimeRegistry,
  ScopeActivation.OnDemand,
  'sessionHostRuntime',
);
