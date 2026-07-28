/**
 * `workspaceRegistration` domain (L6) — `IWorkspaceRuntimeManager` implementation.
 *
 * The manager is the ONLY owner of workspace-runtime registration leases
 * (plan §7.7). It builds the `'local'` provider in-process (the Local branch
 * of `IWorkspaceProvider`, imported here under the plan §10.1 target-side
 * allowlist — registration management and composition are the sanctioned
 * importers of the legacy-layout runtime) and accepts further providers via
 * `registerProvider`.
 *
 * Bound at App scope, activated on demand: compositions that never touch the
 * Workspace domain (standalone memory/server hosts, plan §0.3) never
 * instantiate it.
 */

import { type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';

import { LocalWorkspaceProvider } from '#/app/localWorkspaceRuntime/localWorkspaceProvider';
import {
  SessionHostRuntimeError,
  SessionHostRuntimeErrors,
} from '#/app/sessionHostRuntime/errors';
import { ISessionHostRuntimeRegistry } from '#/app/sessionHostRuntime/sessionHostRuntimeRegistry';
import type {
  IWorkspaceProvider,
  IWorkspaceRuntime,
  IWorkspaceRuntimeRegistration,
} from '#/app/workspace/workspaceRuntime';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ErrorCodes, Error2 } from '#/errors';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import {
  IWorkspaceRuntimeManager,
  type WorkspaceRuntimeRef,
  type WorkspaceRuntimeRegistrationSummary,
} from './workspaceRuntimeManager';

interface RegisteredWorkspaceRuntime {
  readonly workspaceId: string;
  readonly runtime: IWorkspaceRuntime;
  readonly registration: IWorkspaceRuntimeRegistration;
  readonly registryLease: IDisposable;
}

export class WorkspaceRuntimeManagerService implements IWorkspaceRuntimeManager {
  declare readonly _serviceBrand: undefined;

  private readonly providers = new Map<string, IWorkspaceProvider>();
  private readonly registrations = new Map<string, RegisteredWorkspaceRuntime>();
  /** In-flight `ensureRegistered` opens, folded per workspace. */
  private readonly inflight = new Map<string, Promise<IWorkspaceRuntime>>();
  /** In-flight `unregister` teardowns; a re-register waits for them. */
  private readonly draining = new Map<string, Promise<void>>();

  constructor(
    @ISessionHostRuntimeRegistry private readonly registry: ISessionHostRuntimeRegistry,
    @IBootstrapService bootstrap: IBootstrapService,
    @IFileSystemStorageService storage: IFileSystemStorageService,
  ) {
    this.providers.set(
      'local',
      new LocalWorkspaceProvider({ homeDir: bootstrap.homeDir, storage }),
    );
  }

  registerProvider(kind: string, provider: IWorkspaceProvider): void {
    if (this.providers.has(kind)) {
      throw new Error2(
        ErrorCodes.VALIDATION_FAILED,
        `workspace provider kind '${kind}' is already registered`,
      );
    }
    this.providers.set(kind, provider);
  }

  getRuntime(workspaceId: string): IWorkspaceRuntime | undefined {
    return this.registrations.get(workspaceId)?.runtime;
  }

  requireRuntime(workspaceId: string): IWorkspaceRuntime {
    const runtime = this.getRuntime(workspaceId);
    if (runtime === undefined) {
      throw new SessionHostRuntimeError(
        SessionHostRuntimeErrors.codes.SESSION_RUNTIME_NOT_FOUND,
        `workspace '${workspaceId}' has no registered runtime`,
        { details: { workspaceId } },
      );
    }
    return runtime;
  }

  ensureRegistered(
    workspace: WorkspaceRuntimeRef,
    options?: { readonly kind?: string },
  ): Promise<IWorkspaceRuntime> {
    const existing = this.registrations.get(workspace.workspaceId);
    if (existing !== undefined) return Promise.resolve(existing.runtime);
    const pending = this.inflight.get(workspace.workspaceId);
    if (pending !== undefined) return pending;
    const promise = this.doEnsureRegistered(workspace, options?.kind ?? 'local').finally(() =>
      this.inflight.delete(workspace.workspaceId),
    );
    this.inflight.set(workspace.workspaceId, promise);
    return promise;
  }

  private async doEnsureRegistered(
    workspace: WorkspaceRuntimeRef,
    kind: string,
  ): Promise<IWorkspaceRuntime> {
    // A concurrent unregister may still be tearing the previous runtime down:
    // wait it out so the fresh registration never collides with a stale
    // registry lease under the same runtime id.
    await this.draining.get(workspace.workspaceId);
    const existing = this.registrations.get(workspace.workspaceId);
    if (existing !== undefined) return existing.runtime;

    const provider = this.providers.get(kind);
    if (provider === undefined) {
      throw new Error2(
        ErrorCodes.VALIDATION_FAILED,
        `no workspace provider registered for kind '${kind}'`,
      );
    }
    const registration = await provider.open({
      root: workspace.root,
      workspaceId: workspace.workspaceId,
    });
    let registryLease: IDisposable;
    try {
      // The registry is the sentinel: a second live instance under this
      // runtime id fails with `session.runtime_id_conflict`.
      registryLease = this.registry.register(registration.runtime);
    } catch (error) {
      await registration.dispose().catch(() => {});
      throw error;
    }
    this.registrations.set(workspace.workspaceId, {
      workspaceId: workspace.workspaceId,
      runtime: registration.runtime,
      registration,
      registryLease,
    });
    return registration.runtime;
  }

  async unregister(workspaceId: string): Promise<void> {
    const entry = this.registrations.get(workspaceId);
    if (entry === undefined) return;
    // 1. Detach first: the manager/facade hands out no new runtime reference,
    //    so no new child lease is opened through them (plan §7.7 step 1).
    this.registrations.delete(workspaceId);
    const teardown = (async () => {
      // 2. Close the runtime: flips it offline (blocking new child leases at
      //    the runtime boundary with `session.runtime_unavailable`) and
      //    closes the live session leases (`runtime_lost`). Data is retained.
      await entry.registration.dispose();
      // 3. Drop routing only; re-registering under the same id revives refs.
      entry.registryLease.dispose();
    })().finally(() => this.draining.delete(workspaceId));
    this.draining.set(workspaceId, teardown);
    await teardown;
  }

  list(): readonly WorkspaceRuntimeRegistrationSummary[] {
    return [...this.registrations.values()].map((entry) => ({
      workspaceId: entry.workspaceId,
      runtimeId: entry.runtime.id,
      kind: entry.runtime.kind,
    }));
  }
}

registerScopedService(
  LifecycleScope.App,
  IWorkspaceRuntimeManager,
  WorkspaceRuntimeManagerService,
  ScopeActivation.OnDemand,
  'workspaceRegistration',
);
