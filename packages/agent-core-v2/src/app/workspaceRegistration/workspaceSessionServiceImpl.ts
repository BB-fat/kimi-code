/**
 * `workspaceRegistration` domain (L6) — `IWorkspaceSessionService` implementation.
 *
 * Every method is the plan §4.2 two-step: `requireRuntime(workspaceId)` from
 * the registration manager (throwing `session.runtime_not_found` when the
 * workspace has no live registration), then a straight delegate into
 * `runtime.sessions.*`. Nothing here opens a provider, registers a runtime,
 * or keeps any session state of its own. Bound at App scope, activated on
 * demand.
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';

import type {
  CreateSessionInput,
  DeleteSessionOptions,
  OpenSessionOptions,
  ResumeSessionOptions,
  SameRuntimeForkInput,
  SessionListQuery,
  SessionPage,
  UpdateSessionPatch,
} from '#/app/sessionHostRuntime/sessionManager';
import type { ISessionHandle } from '#/app/sessionHostRuntime/sessionService';
import type { SessionRef } from '#/app/sessionHostRuntime/sessionRef';
import type {
  ISessionRuntimeContext,
  SessionCloseReason,
  SessionDescriptor,
} from '#/app/sessionHostRuntime/sessionRuntimeContext';

import { IWorkspaceRuntimeManager } from './workspaceRuntimeManager';
import { IWorkspaceSessionService } from './workspaceSessionService';

/** The lease-backed handle (plan §3.4/§5.4): closing it closes only the child lease. */
function handleOf(context: ISessionRuntimeContext): ISessionHandle {
  const ref: SessionRef = context.ref;
  return {
    ref,
    context,
    close: (reason: SessionCloseReason) => context.close(reason),
  };
}

export class WorkspaceSessionServiceImpl implements IWorkspaceSessionService {
  declare readonly _serviceBrand: undefined;

  constructor(@IWorkspaceRuntimeManager private readonly manager: IWorkspaceRuntimeManager) {}

  async create(workspaceId: string, input: CreateSessionInput): Promise<SessionDescriptor> {
    return this.manager.requireRuntime(workspaceId).sessions.create(input);
  }

  async list(workspaceId: string, query?: SessionListQuery): Promise<SessionPage> {
    return this.manager.requireRuntime(workspaceId).sessions.list(query);
  }

  async get(workspaceId: string, sessionId: string): Promise<SessionDescriptor | undefined> {
    return this.manager.requireRuntime(workspaceId).sessions.get(sessionId);
  }

  async update(
    workspaceId: string,
    sessionId: string,
    patch: UpdateSessionPatch,
  ): Promise<SessionDescriptor> {
    return this.manager.requireRuntime(workspaceId).sessions.update(sessionId, patch);
  }

  async delete(
    workspaceId: string,
    sessionId: string,
    options?: DeleteSessionOptions,
  ): Promise<void> {
    await this.manager.requireRuntime(workspaceId).sessions.delete(sessionId, options);
  }

  async open(
    workspaceId: string,
    sessionId: string,
    options: OpenSessionOptions,
  ): Promise<ISessionHandle> {
    const context = await this.manager.requireRuntime(workspaceId).sessions.open(sessionId, options);
    return handleOf(context);
  }

  async resume(
    workspaceId: string,
    sessionId: string,
    options: ResumeSessionOptions,
  ): Promise<ISessionHandle> {
    const context = await this.manager
      .requireRuntime(workspaceId)
      .sessions.resume(sessionId, options);
    return handleOf(context);
  }

  async fork(
    workspaceId: string,
    sourceSessionId: string,
    input: SameRuntimeForkInput,
  ): Promise<SessionDescriptor> {
    return this.manager.requireRuntime(workspaceId).sessions.fork(sourceSessionId, input);
  }
}

registerScopedService(
  LifecycleScope.App,
  IWorkspaceSessionService,
  WorkspaceSessionServiceImpl,
  ScopeActivation.OnDemand,
  'workspaceRegistration',
);
