/**
 * `workspace` domain (L2) — the Workspace branch of the host-runtime contract
 * (plan §4.1).
 *
 * `IWorkspaceRuntime` is the Workspace domain's specialization of
 * `ISessionHostRuntime`: ONE instance corresponds to ONE opened workspace and
 * hosts ANY number of sessions for its lifetime (WorkspaceRuntime 1:N
 * Session). It is opened ONCE by an `IWorkspaceProvider` and handed out as a
 * complete, long-lived registration — the atomic result carries the stable
 * runtime identity, the multi-session `sessions` manager and every shared
 * resource. Callers never re-open a runtime per session operation: Workspace
 * registration/runtime management (M3) keeps the registration alive and
 * Session create/CRUD only ever touches the already-registered
 * `runtime.sessions`.
 *
 * The dependency direction is one-way: this Workspace domain imports the
 * pathless `sessionHostRuntime` contracts; the generic contracts never see
 * workspace descriptors, workspace ids or `wd_id` layout facts (plan §1.4,
 * §2.2/§2.3).
 */

import type { ISessionHostRuntime } from '#/app/sessionHostRuntime/sessionHostRuntime';
import type { ISessionManager } from '#/app/sessionHostRuntime/sessionManager';

/**
 * Workspace-level capabilities of a workspace runtime, distinct from the
 * session-level `SessionRuntimeCapability` set projected onto session leases.
 * The M2 baseline distinguishes the local filesystem-backed runtime; the
 * remote provider (M3) defines its own set (e.g. `'workspace.remote'`) and
 * the union grows as providers land.
 */
export type WorkspaceCapability =
  /** Sessions live in the local `sessions/<wd_id>/<sessionId>` layout. */
  | 'workspace.local'
  /** Sessions are hosted behind a shared remote connection (plan §4.4). */
  | 'workspace.remote';

/**
 * A long-lived host runtime belonging to the Workspace domain. Everything the
 * generic contract already says applies — one instance hosts many sessions,
 * creating a session never creates a runtime, closing the last session never
 * closes the runtime.
 */
export interface IWorkspaceRuntime extends ISessionHostRuntime {
  readonly workspaceCapabilities: ReadonlySet<WorkspaceCapability>;
  readonly sessions: ISessionManager;
}

/**
 * What a provider needs to establish a workspace runtime (plan §4.1). This
 * DTO exists only inside the Workspace domain and at the provider boundary —
 * it never enters the generic session-host-runtime contracts.
 */
export interface WorkspaceDescriptor {
  /**
   * The workspace root directory (the v1 `metadata.cwd` fact). Local
   * providers resolve the existing `wd_id` bucket from it; it must already
   * exist on the host filesystem.
   */
  readonly root: string;
  /** Display name carried by the workspace catalog entry, when one is made. */
  readonly name?: string;
  /**
   * Pre-resolved workspace id. When absent the provider resolves it from
   * `root` with the existing rules (`encodeWorkDirKey`).
   */
  readonly workspaceId?: string;
}

/**
 * The atomic, long-lived result of `IWorkspaceProvider.open` (plan §4.1):
 * stable workspace identity plus the fully-built runtime in one shot. The
 * registration is held by Workspace registration/runtime management; Session
 * operations never re-open the provider.
 *
 * The plan's `extends AsyncDisposable` is intentionally dropped for the same
 * reason as in `sessionHostRuntime/sessionRuntimeContext.ts`: the repo
 * tsconfig targets `lib: ES2023`, where the `AsyncDisposable` type does not
 * exist. `dispose()` carries the lifecycle; it tears down the runtime
 * (unregister semantics — session data is never deleted).
 */
export interface IWorkspaceRuntimeRegistration {
  readonly workspaceId: string;
  readonly runtime: IWorkspaceRuntime;
  dispose(): Promise<void>;
}

/**
 * Establishes a workspace runtime from a descriptor (plan §4.1). `open` is
 * the ONLY place a workspace runtime is built: it must return the complete
 * registration in one shot (never a bare OS object the App later supplements
 * with a session repository), and callers must reuse the returned
 * registration instead of calling `open` again per session operation.
 */
export interface IWorkspaceProvider {
  open(descriptor: WorkspaceDescriptor): Promise<IWorkspaceRuntimeRegistration>;
}
