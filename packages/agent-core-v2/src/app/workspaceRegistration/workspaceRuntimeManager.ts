/**
 * `workspaceRegistration` domain (L6) — the Workspace registration/runtime
 * manager contract (plan §4.1/§7.7).
 *
 * `IWorkspaceRuntimeManager` owns the LONG-LIVED `IWorkspaceRuntimeRegistration`
 * leases: it opens a workspace runtime ONCE through the matching
 * `IWorkspaceProvider`, registers it into `ISessionHostRuntimeRegistry` and
 * keeps the pair (provider registration + registry lease) for the runtime's
 * whole life. Session create/CRUD never goes through this manager's
 * `ensureRegistered` — ordinary callers use `getRuntime`/`requireRuntime` and
 * reuse the already-registered runtime (plan §9.4: two internal creates must
 * NOT re-open the provider). The ONE allowed registration path beside
 * composition is the kap-server v1 create compatibility adapter's
 * createOrTouch flow (plan §4.2/§6.2).
 *
 * Unregister follows plan §7.7 and never deletes session data:
 *
 *   1. the workspace is detached from the manager first, so no NEW child
 *      lease is handed out through the manager/facade;
 *   2. the provider registration is disposed — `runtime.close(...)` flips the
 *      runtime offline (every subsequent `sessions.*` call fails with
 *      `session.runtime_unavailable`, which blocks new child leases at the
 *      runtime boundary too) and closes the live session leases
 *      (`runtime_lost`);
 *   3. the registry lease is disposed, removing routing only — the offline
 *      registry-entry semantics of `ISessionHostRuntimeRegistry` mean refs
 *      keep failing accurately, and re-registering under the SAME runtime id
 *      later revives them (plan §9.2).
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type {
  IWorkspaceProvider,
  IWorkspaceRuntime,
} from '#/app/workspace/workspaceRuntime';

/** The workspace facts a registration is keyed by (catalog-resolved). */
export interface WorkspaceRuntimeRef {
  /** The canonical (alias-folded) workspace id — determines the runtime id. */
  readonly workspaceId: string;
  /** The canonical workspace root (the v1 `metadata.cwd` fact). */
  readonly root: string;
}

export interface WorkspaceRuntimeRegistrationSummary {
  readonly workspaceId: string;
  readonly runtimeId: string;
  readonly kind: string;
}

export interface IWorkspaceRuntimeManager {
  readonly _serviceBrand: undefined;

  /**
   * Register an additional provider under a workspace kind (composition roots
   * and test harnesses; the `'local'` provider is built in). Providers are
   * ONLY invoked by `ensureRegistered` — never by session CRUD.
   */
  registerProvider(kind: string, provider: IWorkspaceProvider): void;

  /**
   * Resolve the already-registered runtime of a workspace, or `undefined`.
   * This is the ordinary two-step lookup (plan §4.2 step 1): it never opens a
   * provider and never registers a runtime.
   */
  getRuntime(workspaceId: string): IWorkspaceRuntime | undefined;

  /**
   * Like `getRuntime`, but throws `session.runtime_not_found` when the
   * workspace has no registered runtime (never registered or unregistered).
   */
  requireRuntime(workspaceId: string): IWorkspaceRuntime;

  /**
   * Return the registered runtime of a workspace, opening and registering it
   * through the workspace-kind provider when absent. Idempotent: an existing
   * registration is reused as-is (deterministic provider runtime ids make a
   * same-workspace re-open collapse onto the same identity; the registry's
   * `session.runtime_id_conflict` stands as the sentinel against duplicate
   * instances). Concurrent calls for one workspace fold onto one open.
   */
  ensureRegistered(
    workspace: WorkspaceRuntimeRef,
    options?: { readonly kind?: string },
  ): Promise<IWorkspaceRuntime>;

  /**
   * Composition catch-up (plan §3.1/§7.7): ensure every LOCALLY discoverable
   * session bucket has a registered runtime, so bare-id lookups cover the
   * same session set the legacy session index sees — including buckets whose
   * workspace was tombstoned or never cataloged (their sessions stay
   * readable under the v1 rules). Already-registered workspaces are reused;
   * buckets with no recoverable root are skipped. Returns every runtime
   * currently registered with the manager.
   *
   * This opens/registers runtimes — it belongs to composition and to the v1
   * compatibility edge's resolver, never to ordinary session CRUD.
   */
  ensureDiscovered(): Promise<readonly IWorkspaceRuntime[]>;

  /**
   * Detach the workspace's runtime: block new child leases, close live
   * session leases and the runtime, then drop registry routing. Session data
   * is retained — re-registering the same workspace revives it. A no-op for
   * a workspace with no registration.
   */
  unregister(workspaceId: string): Promise<void>;

  list(): readonly WorkspaceRuntimeRegistrationSummary[];
}

export const IWorkspaceRuntimeManager: ServiceIdentifier<IWorkspaceRuntimeManager> =
  createDecorator<IWorkspaceRuntimeManager>('workspaceRuntimeManager');
