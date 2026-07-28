/**
 * `workspaceRegistration` domain (L6) — the Workspace Session facade contract
 * (plan §4.2).
 *
 * `IWorkspaceSessionService` is the Workspace domain's INTERNAL application
 * service for session operations: every method performs exactly two steps —
 *
 *   1. resolve the ALREADY-REGISTERED `IWorkspaceRuntime` of the workspace
 *      from the registration manager (`requireRuntime`);
 *   2. delegate to that runtime's `runtime.sessions.*`.
 *
 * The facade maintains no second session catalog, copies no metadata, issues
 * no extra owner records and creates no transient runtimes. It NEVER calls
 * `IWorkspaceProvider.open` / `ensureRegistered` — ordinary CRUD reuses the
 * registered runtime, and the single sanctioned createOrTouch registration
 * path is the kap-server v1 create compatibility adapter (plan §4.2/§6.2,
 * §9.4). Milestone 1 maps it to NO HTTP/RPC/WebSocket route.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

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
import type { SessionDescriptor } from '#/app/sessionHostRuntime/sessionRuntimeContext';

export interface IWorkspaceSessionService {
  readonly _serviceBrand: undefined;

  create(workspaceId: string, input: CreateSessionInput): Promise<SessionDescriptor>;
  list(workspaceId: string, query?: SessionListQuery): Promise<SessionPage>;
  get(workspaceId: string, sessionId: string): Promise<SessionDescriptor | undefined>;
  update(
    workspaceId: string,
    sessionId: string,
    patch: UpdateSessionPatch,
  ): Promise<SessionDescriptor>;
  delete(workspaceId: string, sessionId: string, options?: DeleteSessionOptions): Promise<void>;

  open(workspaceId: string, sessionId: string, options: OpenSessionOptions): Promise<ISessionHandle>;
  resume(
    workspaceId: string,
    sessionId: string,
    options: ResumeSessionOptions,
  ): Promise<ISessionHandle>;

  /** Same-runtime fork only; the target descriptor shares the workspace runtime id. */
  fork(
    workspaceId: string,
    sourceSessionId: string,
    input: SameRuntimeForkInput,
  ): Promise<SessionDescriptor>;
}

export const IWorkspaceSessionService: ServiceIdentifier<IWorkspaceSessionService> =
  createDecorator<IWorkspaceSessionService>('workspaceSessionService');
