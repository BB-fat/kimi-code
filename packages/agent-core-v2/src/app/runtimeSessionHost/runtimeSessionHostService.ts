/**
 * `runtimeSessionHost` domain (L6) — `IRuntimeSessionHostService`
 * implementation.
 *
 * M8a: this is THE session activation path — the legacy `sessionLifecycle`
 * machine is gone, and `ISessionLifecycleService` survives only as a thin
 * bare-id facade that delegates HERE. The routing half delegates to
 * `ISessionService` / the registry (the runtime is always already
 * registered); the assembly half delegates to
 * `IRuntimeSessionActivationService`; everything else — live map, main
 * agent, plan-mode auto-enter, additional dirs, hooks, telemetry, archived
 * publication, rollback — is the App-level side effect layer the activation
 * service deliberately does not own.
 *
 * Deliberate tightenings versus the retired legacy branches (never
 * observable on a success path):
 *
 *  - a failed resume disposes the half-built scope and closes the lease —
 *    the legacy `doResume` left a half-materialized handle in its live map
 *    when the main-agent create rejected;
 *  - a failed create/fork rolls back through `runtime.sessions.delete(force)`
 *    — the local equivalent of the legacy `hostFs.remove(sessionDir)`; the
 *    append-only `session_index.jsonl` keeps its historical line, which the
 *    index tolerates exactly like an externally removed directory.
 */

import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { DEFAULT_PLAN_MODE_SECTION } from '#/agent/plan/configSection';
import { IAgentPlanService } from '#/agent/plan/plan';
import { IConfigService } from '#/app/config/config';
import { IEventService } from '#/app/event/event';
import { IProjectLocalConfigService } from '#/app/projectLocalConfig/projectLocalConfig';
import {
  type IRuntimeSessionScope,
  IRuntimeSessionActivationService,
} from '#/app/runtimeSession/runtimeSessionActivation';
import { ISessionLifecycleService } from '#/app/sessionLifecycle/sessionLifecycle';
import { ISessionHostRuntimeRegistry } from '#/app/sessionHostRuntime/sessionHostRuntimeRegistry';
import { ISessionService } from '#/app/sessionHostRuntime/sessionService';
import { sessionRefKey, type SessionRef } from '#/app/sessionHostRuntime/sessionRef';
import type { ISessionRuntimeContext } from '#/app/sessionHostRuntime/sessionRuntimeContext';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ErrorCodes, isError2 } from '#/errors';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ensureMainAgent } from '#/session/agentLifecycle/mainAgent';
import { labelsFromAgentMeta } from '#/session/agentLifecycle/subagentMetadata';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

import {
  IRuntimeSessionHostService,
  type RuntimeSessionActivatedEvent,
  type RuntimeSessionHostClosedEvent,
  type RuntimeSessionHostCreateOptions,
  type RuntimeSessionHostForkedEvent,
  type RuntimeSessionHostForkOptions,
  type RuntimeSessionHostResumeOptions,
} from './runtimeSessionHost';

export class RuntimeSessionHostService extends Disposable implements IRuntimeSessionHostService {
  declare readonly _serviceBrand: undefined;

  /** Live runtime-activated scopes, keyed by the FULL `SessionRef`. */
  private readonly live = new Map<string, IRuntimeSessionScope>();
  /** In-flight resumes, folded per ref — the legacy `resuming` semantics. */
  private readonly resuming = new Map<string, Promise<IRuntimeSessionScope | undefined>>();
  /**
   * `ISessionLifecycleService.trackActivated` registrations, per live ref:
   * they publish runtime-activated sessions into the process-wide live lookup
   * the kap-server edge (broadcaster, transcript, snapshot, facts) reads.
   * Detached on close/archive BEFORE the scope teardown begins — the legacy
   * ordering (map removal precedes dispose).
   */
  private readonly trackings = new Map<string, IDisposable>();

  private readonly _onDidActivateSession = this._register(
    new Emitter<RuntimeSessionActivatedEvent>(),
  );
  readonly onDidActivateSession: Event<RuntimeSessionActivatedEvent> =
    this._onDidActivateSession.event;
  private readonly _onDidCloseSession = this._register(
    new Emitter<RuntimeSessionHostClosedEvent>(),
  );
  readonly onDidCloseSession: Event<RuntimeSessionHostClosedEvent> =
    this._onDidCloseSession.event;
  private readonly _onDidArchiveSession = this._register(
    new Emitter<RuntimeSessionHostClosedEvent>(),
  );
  readonly onDidArchiveSession: Event<RuntimeSessionHostClosedEvent> =
    this._onDidArchiveSession.event;
  private readonly _onDidForkSession = this._register(
    new Emitter<RuntimeSessionHostForkedEvent>(),
  );
  readonly onDidForkSession: Event<RuntimeSessionHostForkedEvent> =
    this._onDidForkSession.event;

  constructor(
    @ISessionService private readonly sessions: ISessionService,
    @ISessionHostRuntimeRegistry private readonly registry: ISessionHostRuntimeRegistry,
    @IRuntimeSessionActivationService private readonly activation: IRuntimeSessionActivationService,
    @ISessionLifecycleService private readonly lifecycle: ISessionLifecycleService,
    @IConfigService private readonly config: IConfigService,
    @IProjectLocalConfigService private readonly projectLocalConfig: IProjectLocalConfigService,
    @IEventService private readonly event: IEventService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {
    super();
  }

  /* ---------------------------------------------------------------------- */
  /* Create (legacy `create` parity)                                         */
  /* ---------------------------------------------------------------------- */

  async create(opts: RuntimeSessionHostCreateOptions): Promise<IRuntimeSessionScope> {
    const descriptor = await this.sessions.create(opts.runtimeId, {
      sessionId: opts.sessionId,
      metadata: opts.metadata,
    });
    const ref = descriptor.ref;
    let lease: ISessionRuntimeContext | undefined;
    let scope: IRuntimeSessionScope | undefined;
    try {
      lease = (await this.sessions.open(ref, {})).context;
      scope = await this.activation.activate(lease, {
        mcpServers: opts.mcpServers,
        // Legacy create builds the main agent ONLY when a binding is given.
        mainAgent:
          opts.mainAgentBinding === undefined ? undefined : { binding: opts.mainAgentBinding },
      });
      await this.seedAdditionalDirs(scope, opts.additionalDirs);
      // The legacy `defaultPlanMode` auto-enter: fresh sessions only, and
      // only where the runtime owns the plan working document (the
      // transitional `session.host_files` capability).
      if (
        this.config.get<boolean>(DEFAULT_PLAN_MODE_SECTION) === true &&
        lease.capabilities.has('session.host_files')
      ) {
        const planAgent =
          scope.handle.accessor.get(IAgentLifecycleService).get(MAIN_AGENT_ID) ??
          (await ensureMainAgent(scope.handle));
        await planAgent.accessor.get(IAgentPlanService).enter();
      }
    } catch (error) {
      await this.teardownActivation(scope, lease);
      await this.sessions.delete(ref, { force: true }).catch(() => {});
      throw error;
    }
    this.live.set(sessionRefKey(ref), scope);
    this.trackLive(ref, scope);
    await this.announceActivated({ ref, scope, source: 'startup' });
    return scope;
  }

  /* ---------------------------------------------------------------------- */
  /* Lookup                                                                  */
  /* ---------------------------------------------------------------------- */

  get(ref: SessionRef): IRuntimeSessionScope | undefined {
    const key = sessionRefKey(ref);
    if (this.resuming.has(key)) return undefined;
    return this.live.get(key);
  }

  list(): readonly IRuntimeSessionScope[] {
    const ready: IRuntimeSessionScope[] = [];
    for (const [key, scope] of this.live) {
      if (!this.resuming.has(key)) ready.push(scope);
    }
    return ready;
  }

  /* ---------------------------------------------------------------------- */
  /* Resume / restore (legacy `resume` / `restore` parity)                   */
  /* ---------------------------------------------------------------------- */

  resume(
    ref: SessionRef,
    opts?: RuntimeSessionHostResumeOptions,
  ): Promise<IRuntimeSessionScope | undefined> {
    const key = sessionRefKey(ref);
    const inflight = this.resuming.get(key);
    if (inflight !== undefined) return inflight;
    const live = this.live.get(key);
    if (live !== undefined) return Promise.resolve(live);
    const promise = this.doResume(ref, opts)
      .catch((error: unknown) => {
        this.telemetry
          .withContext({ sessionId: ref.sessionId })
          .track2('session_load_failed', {
            reason: isError2(error) ? error.code : error instanceof Error ? error.name : 'unknown',
          });
        throw error;
      })
      .finally(() => this.resuming.delete(key));
    this.resuming.set(key, promise);
    return promise;
  }

  private async doResume(
    ref: SessionRef,
    opts?: RuntimeSessionHostResumeOptions,
  ): Promise<IRuntimeSessionScope | undefined> {
    const live = this.live.get(sessionRefKey(ref));
    if (live !== undefined) return live;
    // An unknown runtime means the session is not resolvable at all — the
    // legacy `resume` answers `undefined` for unknown sessions. A registered
    // but OFFLINE runtime instead propagates `session.runtime_unavailable`
    // (plan §5.3), exactly what the v1 edge maps onto its frozen envelope.
    if (this.registry.get(ref.runtimeId) === undefined) return undefined;

    let lease: ISessionRuntimeContext;
    try {
      lease = (
        await this.sessions.resume(ref, { expectedRevision: opts?.expectedRevision })
      ).context;
    } catch (error) {
      if (isError2(error) && error.code === ErrorCodes.SESSION_NOT_FOUND) return undefined;
      throw error;
    }
    let scope: IRuntimeSessionScope | undefined;
    try {
      scope = await this.activation.activate(lease, {
        mcpServers: opts?.mcpServers,
        // Legacy resume ensures the main agent (no binding).
        mainAgent: {},
      });
      await this.seedAdditionalDirs(scope, opts?.additionalDirs);
    } catch (error) {
      await this.teardownActivation(scope, lease);
      throw error;
    }
    this.live.set(sessionRefKey(ref), scope);
    this.trackLive(ref, scope);
    await this.announceActivated({ ref, scope, source: 'resume' });
    return scope;
  }

  async restore(
    ref: SessionRef,
    opts?: RuntimeSessionHostResumeOptions,
  ): Promise<IRuntimeSessionScope | undefined> {
    const scope = await this.resume(ref, opts);
    if (scope === undefined) return undefined;
    await scope.handle.accessor.get(ISessionMetadata).setArchived(false);
    return scope;
  }

  /* ---------------------------------------------------------------------- */
  /* Fork (legacy `fork` parity)                                             */
  /* ---------------------------------------------------------------------- */

  async fork(ref: SessionRef, opts?: RuntimeSessionHostForkOptions): Promise<IRuntimeSessionScope> {
    const runtime = this.registry.require(ref.runtimeId);
    // The runtime owns the fork data plane: directory copy, per-agent wire
    // rewrite, cron duplication, state.json re-anchor and the index line —
    // the same semantics the legacy fork performs by hand (a live source
    // lease is flushed by the runtime first).
    const descriptor = await runtime.sessions.fork(ref.sessionId, {
      sessionId: opts?.newSessionId,
      metadata: { title: opts?.title, custom: opts?.metadata },
    });
    const targetRef = descriptor.ref;
    let lease: ISessionRuntimeContext | undefined;
    let scope: IRuntimeSessionScope | undefined;
    try {
      lease = await runtime.sessions.open(targetRef.sessionId, {});
      scope = await this.activation.activate(lease, { mcpServers: opts?.mcpServers });
      await this.seedAdditionalDirs(scope, undefined);
      // Rebuild the live agent roster from the persisted metadata — the
      // legacy fork recreates every source agent (main included) with its
      // provenance labels.
      const meta = await scope.handle.accessor.get(ISessionMetadata).read();
      const agents = scope.handle.accessor.get(IAgentLifecycleService);
      for (const [agentId, agentMeta] of Object.entries(meta.agents ?? {})) {
        await agents.create({
          agentId,
          forkedFrom: agentMeta.forkedFrom,
          labels: labelsFromAgentMeta(agentMeta),
        });
      }
    } catch (error) {
      await this.teardownActivation(scope, lease);
      await runtime.sessions.delete(targetRef.sessionId, { force: true }).catch(() => {});
      throw error;
    }
    this.live.set(sessionRefKey(targetRef), scope);
    this.trackLive(targetRef, scope);
    this._onDidForkSession.fire({ source: ref, ref: targetRef, scope });
    await this.announceActivated({ ref: targetRef, scope, source: 'fork' });
    return scope;
  }

  /* ---------------------------------------------------------------------- */
  /* Archive / close (legacy `archive` / `close` parity)                     */
  /* ---------------------------------------------------------------------- */

  async archive(ref: SessionRef): Promise<void> {
    const key = sessionRefKey(ref);
    const scope = this.live.get(key);
    // Legacy archive acts on live sessions only; a cold session is a no-op.
    if (scope === undefined) return;
    await scope.handle.accessor.get(ISessionMetadata).setArchived(true);
    await this.drainAgents(scope);
    this.event.publish({
      type: 'event.session.archived',
      payload: { sessionId: ref.sessionId },
    });
    await this.announceWillClose(ref, scope);
    this.live.delete(key);
    this.untrackLive(key);
    await scope.close('explicit');
    this._onDidArchiveSession.fire({ ref });
  }

  async close(ref: SessionRef): Promise<void> {
    const key = sessionRefKey(ref);
    const scope = this.live.get(key);
    if (scope === undefined) return;
    await this.announceWillClose(ref, scope);
    this.live.delete(key);
    this.untrackLive(key);
    await scope.close('explicit');
    this._onDidCloseSession.fire({ ref });
  }

  /* ---------------------------------------------------------------------- */
  /* Side effects                                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * Publish a freshly-activated scope into the process-wide live lookup
   * (`ISessionLifecycleService.get/list/resume`) BEFORE the activation is
   * announced, so every consumer reacting to the hooks/events — the
   * kap-server broadcaster, transcript service, snapshot reader, wire-facts
   * projection — already observes the session as live.
   */
  private trackLive(ref: SessionRef, scope: IRuntimeSessionScope): void {
    this.trackings.set(sessionRefKey(ref), this.lifecycle.trackActivated(ref, scope.handle));
  }

  /** Detach the live-lookup registration (idempotent per ref). */
  private untrackLive(key: string): void {
    const tracking = this.trackings.get(key);
    if (tracking === undefined) return;
    this.trackings.delete(key);
    tracking.dispose();
  }

  /**
   * The legacy `announceCreated`: run the shared lifecycle hook slot (the
   * Session-scoped external-hooks adapter listens HERE for its `SessionStart`
   * command), fire the host event, then track `session_started` through the
   * session's own telemetry view.
   */
  private async announceActivated(event: RuntimeSessionActivatedEvent): Promise<void> {
    await this.lifecycle.hooks.onDidCreateSession.run({
      sessionId: event.ref.sessionId,
      handle: event.scope.handle,
      source: event.source,
    });
    this._onDidActivateSession.fire(event);
    event.scope.handle.accessor
      .get(ITelemetryService)
      .track2('session_started', { resumed: event.source === 'resume' });
  }

  private async announceWillClose(ref: SessionRef, scope: IRuntimeSessionScope): Promise<void> {
    await this.lifecycle.hooks.onWillCloseSession.run({
      sessionId: ref.sessionId,
      handle: scope.handle,
      reason: 'exit',
    });
  }

  private async drainAgents(scope: IRuntimeSessionScope): Promise<void> {
    const agents = scope.handle.accessor.get(IAgentLifecycleService);
    for (const agent of agents.list()) {
      await agents.remove(agent.id);
    }
  }

  /** Dispose a (possibly half-built) activation and release its lease. */
  private async teardownActivation(
    scope: IRuntimeSessionScope | undefined,
    lease: ISessionRuntimeContext | undefined,
  ): Promise<void> {
    if (scope !== undefined) {
      await scope.close('explicit').catch(() => {});
      return;
    }
    // A failed `activate` disposes its half-built DI scope but leaves the
    // lease with the caller (its documented contract) — close it here.
    await lease?.close('explicit').catch(() => {});
  }

  /**
   * The legacy `materializeSession` additional-dirs seeding: project-local
   * config dirs plus caller dirs, resolved against the session's workspace
   * root (the lease's `os.cwd`). Headless leases have no root — and no dirs.
   */
  private async seedAdditionalDirs(
    scope: IRuntimeSessionScope,
    callerAdditionalDirs: readonly string[] | undefined,
  ): Promise<void> {
    const cwd = scope.lease.os?.cwd ?? '';
    if (cwd === '') return;
    const localWorkspaceDirs = await this.projectLocalConfig.readAdditionalDirs(cwd);
    const resolvedCallerDirs = await this.projectLocalConfig.resolveAdditionalDirs(
      cwd,
      callerAdditionalDirs ?? [],
    );
    const additionalDirs = [...localWorkspaceDirs.additionalDirs, ...resolvedCallerDirs];
    if (additionalDirs.length > 0) {
      scope.handle.accessor.get(ISessionWorkspaceContext).setAdditionalDirs(additionalDirs);
    }
  }
}

registerScopedService(
  LifecycleScope.App,
  IRuntimeSessionHostService,
  RuntimeSessionHostService,
  ScopeActivation.OnDemand,
  'runtimeSessionHost',
);
