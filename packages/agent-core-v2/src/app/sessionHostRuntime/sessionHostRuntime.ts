/**
 * `sessionHostRuntime` domain — the generic host-runtime contract (plan §3.2).
 *
 * The architectural subject is `runtime.sessions`: ONE `ISessionHostRuntime`
 * instance is a long-lived host that creates, holds and manages ANY number of
 * sessions (fixed cardinality Runtime 1:N Session). Creating a session never
 * creates, clones or exclusively claims a runtime, and closing the last
 * session never closes or unregisters the runtime.
 *
 * The contract is pathless and workspace-free (plan §1.4): no workspace
 * descriptors/ids, no `wd_id`, no cwd/`sessionDir` or other physical paths.
 * Concrete runtimes (Local workspace, remote workspace, standalone memory /
 * server) implement this interface behind their own adapters; the Workspace
 * domain's `IWorkspaceRuntime` extends it.
 */

import type { ISessionManager } from './sessionManager';

/**
 * Liveness of a registered runtime (plan §3.1). Offline entries stay
 * registered so existing `SessionRef`s fail with an accurate
 * `session.runtime_unavailable` instead of a plain not-found.
 */
export type SessionRuntimeStatus = 'online' | 'offline' | 'degraded';

/**
 * A capability a runtime may project into the sessions it hosts. Session and
 * Agent scope assembly filters service/tool contributions by this set: a
 * contribution whose `requires` is not projected is excluded before the scope
 * is built, and explicitly calling an absent capability surfaces
 * `session.capability_unavailable`.
 *
 * The `os.*` family covers the workspace OS handles of
 * `ISessionOsCapabilities` (plan §7.4); the `session.*` family covers
 * runtime-provided session data planes.
 *
 * `session.host_files` is TRANSITIONAL: it marks contributions that still
 * need the legacy per-session host directory (`logs/`, plan working
 * documents, task output files, media originals). The Local workspace runtime
 * projects it — it owns that directory and contributes the `ISessionContext`
 * replacement backing it (`localSessionContextSeed.ts`); headless runtimes
 * (memory/server) never project it, so those contributions stay off their
 * activation path. M8 re-roots the consumers in lease artifacts (plan §7.5)
 * and drops this capability.
 */
export type SessionRuntimeCapability =
  | 'os.filesystem'
  | 'os.process'
  | 'os.terminal'
  | 'os.watch'
  | 'os.stdio'
  | 'session.host_files'
  | 'artifact.model_read'
  | 'session.cold_read'
  | 'session.export'
  | 'session.import'
  | 'session.fork';

/**
 * Why a long-lived runtime is being closed (plan §3.1/§5.4). Session
 * open/close/delete never closes a runtime; only these explicit lifecycle
 * events do.
 */
export type RuntimeCloseReason =
  /** The owning registration (e.g. workspace unregister) was torn down. */
  | 'unregistered'
  /** The runtime manager evicted the runtime (policy, idle, shutdown ordering). */
  | 'evicted'
  /** The hosting process is shutting down. */
  | 'shutdown';

/**
 * A long-lived, shareable host of multiple sessions. Registered once into
 * `ISessionHostRuntimeRegistry` by composition/provider registration and held
 * for the lifetime of the runtime — never a per-session object.
 */
export interface ISessionHostRuntime {
  /** Stable, process-unique runtime id — the `runtimeId` of every hosted `SessionRef`. */
  readonly id: string;
  /** Implementation family, e.g. `'local-workspace'`, `'remote-workspace'`, `'standalone-memory'`. */
  readonly kind: string;
  /** The multi-session manager of THIS runtime. All session ids passed to it are runtime-local. */
  readonly sessions: ISessionManager;

  status(): SessionRuntimeStatus;
  capabilities(): ReadonlySet<SessionRuntimeCapability>;
  /**
   * Tear down the whole runtime. Closing individual sessions goes through
   * their own context/lease and never reaches this method.
   */
  close(reason: RuntimeCloseReason): Promise<void>;
}
