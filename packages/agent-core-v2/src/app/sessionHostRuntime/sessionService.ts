/**
 * `sessionHostRuntime` domain — the internal session routing service
 * (plan §3.4).
 *
 * `ISessionService` is a thin INTERNAL routing layer — not an HTTP/RPC API
 * and not the owner of any v1 schema. It owns no persistence, resolves no
 * `workspace_id`/cwd, creates no workspace registration and makes no runtime
 * lifecycle decisions: every method simply resolves the target runtime from
 * the registry and delegates to `runtime.sessions.*`. Runtime registration
 * belongs to composition/provider registration (and, for the legacy v1
 * create flow alone, to the kap-server workspace compatibility adapter) —
 * never to this service.
 *
 * M0 ships the interface plus the registry-based routing skeleton; real
 * runtimes land from M1 on.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';

import { SessionHostRuntimeError, SessionHostRuntimeErrors } from './errors';
import type {
  CreateSessionInput,
  DeleteSessionOptions,
  OpenSessionOptions,
  ResumeSessionOptions,
  SameRuntimeForkInput,
  SessionListQuery,
  UpdateSessionPatch,
} from './sessionManager';
import { ISessionHostRuntimeRegistry } from './sessionHostRuntimeRegistry';
import type { SessionRef } from './sessionRef';
import type {
  ISessionRuntimeContext,
  SessionCloseReason,
  SessionDescriptor,
} from './sessionRuntimeContext';
import { ISessionTransferService } from './sessionTransferService';

/* ------------------------------------------------------------------------ */
/* Global list                                                               */
/* ------------------------------------------------------------------------ */

/**
 * Internal cross-runtime list query (plan §3.4). Every returned item keeps
 * its full `SessionRef`; the internal cursor may fold per-runtime opaque
 * cursors and never enters a v1 schema (the v1 list adapter re-projects
 * pagination onto the existing wire semantics).
 */
export interface GlobalSessionListQuery {
  /** Restrict the query to one runtime; absent fans out across the registry. */
  readonly runtimeId?: string;
  /** Forwarded verbatim to each runtime's `sessions.list`. */
  readonly query?: SessionListQuery;
}

export interface GlobalSessionPage {
  readonly items: readonly SessionDescriptor[];
  /** Opaque internal cursor; absent means no more items. */
  readonly cursor?: string;
}

/* ------------------------------------------------------------------------ */
/* Session handle                                                            */
/* ------------------------------------------------------------------------ */

/**
 * A live session obtained through `open`/`resume` (plan §3.4/§5.4): the
 * runtime-issued context plus the identity it was opened under. Closing the
 * handle closes only this session's child lease — sibling sessions and the
 * host runtime stay up.
 */
export interface ISessionHandle {
  readonly ref: SessionRef;
  readonly context: ISessionRuntimeContext;
  close(reason: SessionCloseReason): Promise<void>;
}

/* ------------------------------------------------------------------------ */
/* Fork                                                                      */
/* ------------------------------------------------------------------------ */

/**
 * Internal fork input (plan §3.4): a `targetRuntimeId` equal to the source's
 * (or absent) routes to `runtime.sessions.fork`; a different one goes through
 * the transfer service's export/import data plane.
 */
export interface ForkSessionInput extends SameRuntimeForkInput {
  readonly targetRuntimeId?: string;
}

/* ------------------------------------------------------------------------ */
/* The service                                                               */
/* ------------------------------------------------------------------------ */

export interface ISessionService {
  readonly _serviceBrand: undefined;

  /**
   * Create a session on an ALREADY-REGISTERED runtime. This path never
   * opens/registers/clones a runtime — the v1 `workspace_id`/cwd resolution
   * and createOrTouch behavior lives in the kap-server compatibility adapter.
   */
  create(runtimeId: string, input: CreateSessionInput): Promise<SessionDescriptor>;
  list(query?: GlobalSessionListQuery): Promise<GlobalSessionPage>;
  get(ref: SessionRef): Promise<SessionDescriptor | undefined>;
  update(ref: SessionRef, patch: UpdateSessionPatch): Promise<SessionDescriptor>;
  delete(ref: SessionRef, options?: DeleteSessionOptions): Promise<void>;
  open(ref: SessionRef, options: OpenSessionOptions): Promise<ISessionHandle>;
  resume(ref: SessionRef, options: ResumeSessionOptions): Promise<ISessionHandle>;
  fork(ref: SessionRef, input: ForkSessionInput): Promise<SessionDescriptor>;
}

export const ISessionService: ServiceIdentifier<ISessionService> =
  createDecorator<ISessionService>('sessionService');

class SessionHandle implements ISessionHandle {
  constructor(readonly context: ISessionRuntimeContext) {}

  get ref(): SessionRef {
    return this.context.ref;
  }

  close(reason: SessionCloseReason): Promise<void> {
    return this.context.close(reason);
  }
}

/**
 * Registry-based routing skeleton. Every method resolves the runtime through
 * the registry (`session.runtime_not_found` / `session.runtime_unavailable`
 * surface from `require`) and delegates with the runtime-local session id.
 *
 * Registered as an App-scope service but activated on demand: a composition
 * root starts injecting it from M1 on. The transfer dependency is optional
 * in the constructor so bare test rigs can still `new SessionService(registry)`;
 * the cross-runtime fork branch fails accurately when it is absent.
 */
export class SessionService implements ISessionService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionHostRuntimeRegistry private readonly registry: ISessionHostRuntimeRegistry,
    @ISessionTransferService private readonly transfer?: ISessionTransferService,
  ) {}

  async create(runtimeId: string, input: CreateSessionInput): Promise<SessionDescriptor> {
    return this.registry.require(runtimeId).sessions.create(input);
  }

  async list(query?: GlobalSessionListQuery): Promise<GlobalSessionPage> {
    const runtimes =
      query?.runtimeId !== undefined
        ? [this.registry.require(query.runtimeId)]
        : // Offline entries cannot answer `list`; they stay registered so
          // id-targeted calls still fail accurately, but fan-out skips them.
          this.registry
            .list()
            .filter((summary) => summary.status !== 'offline')
            .map((summary) => this.registry.require(summary.id));
    const pages = await Promise.all(
      runtimes.map((runtime) => runtime.sessions.list(query?.query)),
    );
    // Cross-runtime merge + a folded cursor arrive with the v1 list adapter;
    // every item already carries its full SessionRef.
    return { items: pages.flatMap((page) => page.items) };
  }

  async get(ref: SessionRef): Promise<SessionDescriptor | undefined> {
    return this.registry.require(ref.runtimeId).sessions.get(ref.sessionId);
  }

  async update(ref: SessionRef, patch: UpdateSessionPatch): Promise<SessionDescriptor> {
    return this.registry.require(ref.runtimeId).sessions.update(ref.sessionId, patch);
  }

  async delete(ref: SessionRef, options?: DeleteSessionOptions): Promise<void> {
    return this.registry.require(ref.runtimeId).sessions.delete(ref.sessionId, options);
  }

  async open(ref: SessionRef, options: OpenSessionOptions): Promise<ISessionHandle> {
    const context = await this.registry.require(ref.runtimeId).sessions.open(ref.sessionId, options);
    return new SessionHandle(context);
  }

  async resume(ref: SessionRef, options: ResumeSessionOptions): Promise<ISessionHandle> {
    const context = await this.registry
      .require(ref.runtimeId)
      .sessions.resume(ref.sessionId, options);
    return new SessionHandle(context);
  }

  async fork(ref: SessionRef, input: ForkSessionInput): Promise<SessionDescriptor> {
    const runtime = this.registry.require(ref.runtimeId);
    const targetRuntimeId = input.targetRuntimeId ?? ref.runtimeId;
    if (targetRuntimeId === ref.runtimeId) {
      return runtime.sessions.fork(ref.sessionId, input);
    }
    // Cross-runtime fork goes through the transfer service's export/import
    // data plane (plan §5.8) — never the local directory-copy helpers.
    if (this.transfer === undefined) {
      throw new SessionHostRuntimeError(
        SessionHostRuntimeErrors.codes.SESSION_TRANSFER_FAILED,
        'cross-runtime session fork requires the session transfer service (not available in this composition)',
        { details: { runtimeId: ref.runtimeId, targetRuntimeId } },
      );
    }
    return this.transfer.forkAcrossRuntimes({
      source: ref,
      targetRuntimeId,
      sessionId: input.sessionId,
      metadata: input.metadata,
    });
  }
}

registerScopedService(
  LifecycleScope.App,
  ISessionService,
  SessionService,
  ScopeActivation.OnDemand,
  'sessionHostRuntime',
);
