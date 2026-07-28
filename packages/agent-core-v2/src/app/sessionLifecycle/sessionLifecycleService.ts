/**
 * `sessionLifecycle` domain (L6) — `ISessionLifecycleService` implementation.
 *
 * M8a (multi-runtime refactor, plan §15): the legacy activation machine is
 * gone. This service is now a thin v1-compatibility facade over
 * `IRuntimeSessionHostService` — every bare-id / workDir call resolves its
 * `SessionRef` and delegates:
 *
 *  - `create` resolves the workDir through the Workspace catalog
 *    (`createOrTouch`, the legacy v1 rule the in-process SDK/klient contract
 *    still depends on) and the workspace's long-lived runtime
 *    (`IWorkspaceRuntimeManager.ensureRegistered` — an existing registration
 *    is ALWAYS reused, never a per-session runtime), then
 *    `host.create({ runtimeId, ... })`;
 *  - `resume` / `fork` resolve a bare id through the live lookup first, then
 *    the `sessionIndex` read model + the runtime manager's discovery
 *    catch-up (`ensureDiscovered` — the same catch-up the kap-server v1
 *    resolver runs), then delegate;
 *  - `close` / `archive` act on live sessions only (a cold session is a
 *    no-op, the legacy semantics) and delegate by the tracked ref.
 *
 * What stays here, because every consumer shares it:
 *
 *  - the process-wide live lookup (`get` / `getByRef` / `list`), fed ONLY by
 *    `trackActivated` — the runtime session host publishes every activation
 *    here before announcing it, so the kap-server edge (broadcaster,
 *    transcript, snapshot, facts), the debug-RPC scope resolver and the
 *    klient in-process dispatcher observe runtime sessions through one map.
 *    The bare-id `get` projection answers only a UNIQUE match (plan §1.3
 *    rule 5: two runtimes hosting a same-named pair is never guessed);
 *  - the shared lifecycle hook slots (`onDidCreateSession` → `SessionStart`,
 *    `onWillCloseSession` → `SessionEnd`) — the Session-scoped external-hooks
 *    adapter registers here, and the runtime session host runs the slots, so
 *    the hook event stream is identical no matter which facade call drove
 *    the activation;
 *  - the lifecycle events (`onDidCreateSession` / `onDidCloseSession` /
 *    `onDidArchiveSession` / `onDidForkSession`), fired by the facade
 *    methods after their delegated call — in-process consumers (the node-sdk
 *    wiring) subscribe here.
 *
 * The deleted legacy machine (materialize-from-workDir, `state.json` writes,
 * `session_index.jsonl` appends, fork directory copy + wire rewrite, cron
 * duplication, directory rollback) is owned by `LocalWorkspaceRuntime`'s
 * session manager today — the M2/M5b parity tests pin the byte-identical
 * layout, and the M5b black-box comparison proves this facade is
 * indistinguishable from the old path on the wire.
 */

import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import { IInstantiationService } from '#/_base/di/instantiation';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { IRuntimeSessionHostService } from '#/app/runtimeSessionHost/runtimeSessionHost';
import {
  CHILD_SESSION_KIND,
  CHILD_SESSION_KIND_KEY,
  ISessionIndex,
  PARENT_SESSION_ID_KEY,
} from '#/app/sessionIndex/sessionIndex';
import {
  sessionRefKey,
  type SessionRef,
} from '#/app/sessionHostRuntime/sessionRef';
import { IWorkspaceRuntimeManager } from '#/app/workspaceRegistration/workspaceRuntimeManager';
import type { IWorkspaceRuntime } from '#/app/workspace/workspaceRuntime';
import { IWorkspaceService } from '#/app/workspace/workspace';
import { ErrorCodes, Error2 } from '#/errors';
import { createHooks } from '#/hooks';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import {
  type CreateChildSessionOptions,
  type CreateSessionOptions,
  type ForkSessionOptions,
  type SessionArchivedEvent,
  type SessionClosedEvent,
  type SessionCreatedEvent,
  type SessionForkedEvent,
  type SessionLifecycleHooks,
  ISessionLifecycleService,
} from './sessionLifecycle';

/** One live session published through `trackActivated`. */
interface TrackedSession {
  readonly ref: SessionRef;
  readonly handle: ISessionScopeHandle;
}

export class SessionLifecycleService extends Disposable implements ISessionLifecycleService {
  declare readonly _serviceBrand: undefined;
  /**
   * The process-wide live lookup, keyed by the FULL `SessionRef`
   * (`sessionRefKey`) — M6: two same-named sessions hosted by different
   * runtimes coexist here; the bare-id `get`/`resume` projections only
   * answer when the tracked match is UNIQUE. Lookup-only: every lifecycle
   * decision stays with the registrar (the runtime session host), which
   * detaches on close/archive.
   */
  private readonly tracked = new Map<string, TrackedSession>();
  private readonly _onDidCreateSession = this._register(new Emitter<SessionCreatedEvent>());
  readonly onDidCreateSession: Event<SessionCreatedEvent> = this._onDidCreateSession.event;
  private readonly _onDidCloseSession = this._register(new Emitter<SessionClosedEvent>());
  readonly onDidCloseSession: Event<SessionClosedEvent> = this._onDidCloseSession.event;
  private readonly _onDidArchiveSession = this._register(new Emitter<SessionArchivedEvent>());
  readonly onDidArchiveSession: Event<SessionArchivedEvent> = this._onDidArchiveSession.event;
  private readonly _onDidForkSession = this._register(new Emitter<SessionForkedEvent>());
  readonly onDidForkSession: Event<SessionForkedEvent> = this._onDidForkSession.event;
  readonly hooks = createHooks<SessionLifecycleHooks, keyof SessionLifecycleHooks>([
    'onDidCreateSession',
    'onWillCloseSession',
  ]);
  /**
   * In-flight facade resumes, folded per bare id — the host folds the
   * activation itself per ref; this fold additionally guarantees the
   * facade's `onDidCreateSession` fires exactly once for concurrent callers,
   * and keeps the legacy `get`/`list` "hidden until the resume finishes"
   * semantics.
   */
  private readonly resuming = new Map<string, Promise<ISessionScopeHandle | undefined>>();

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @ISessionIndex private readonly index: ISessionIndex,
    @IWorkspaceService private readonly workspaces: IWorkspaceService,
    @IWorkspaceRuntimeManager private readonly runtimeManager: IWorkspaceRuntimeManager,
  ) {
    super();
  }

  /**
   * The runtime session host, resolved lazily: the host injects THIS service
   * (shared hook slots + `trackActivated`), so a constructor injection here
   * would cycle the App-scope graph.
   */
  private host(): IRuntimeSessionHostService {
    return this.instantiation.invokeFunction((accessor) =>
      accessor.get(IRuntimeSessionHostService),
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Create (delegated: workspace resolve → registered runtime → host)       */
  /* ---------------------------------------------------------------------- */

  async create(opts: CreateSessionOptions): Promise<ISessionScopeHandle> {
    // The v1 create compatibility the in-process SDK/klient contract depends
    // on: register the workDir in the Workspace catalog (legacy
    // `createOrTouch` rule), then reuse the workspace's long-lived runtime —
    // `ensureRegistered` opens + registers it exactly once and every later
    // create reuses that instance (plan §4.2/§9.4).
    const workspace = await this.workspaces.createOrTouch(opts.workDir);
    const runtime = await this.runtimeManager.ensureRegistered({
      workspaceId: workspace.id,
      root: workspace.root,
    });
    const scope = await this.host().create({
      runtimeId: runtime.id,
      sessionId: opts.sessionId,
      mcpServers: opts.mcpServers,
      mainAgentBinding: opts.mainAgentBinding,
      additionalDirs: opts.additionalDirs,
    });
    this._onDidCreateSession.fire({
      sessionId: scope.ref.sessionId,
      handle: scope.handle,
      source: 'startup',
    });
    return scope.handle;
  }

  /* ---------------------------------------------------------------------- */
  /* Live lookup (tracked-only; bare id answers unique matches only)         */
  /* ---------------------------------------------------------------------- */

  get(sessionId: string): ISessionScopeHandle | undefined {
    if (this.resuming.has(sessionId)) return undefined;
    return this.liveEntryOf(sessionId)?.handle;
  }

  getByRef(ref: SessionRef): ISessionScopeHandle | undefined {
    if (this.resuming.has(ref.sessionId)) return undefined;
    return this.tracked.get(sessionRefKey(ref))?.handle;
  }

  list(): readonly ISessionScopeHandle[] {
    const ready: ISessionScopeHandle[] = [];
    for (const entry of this.tracked.values()) {
      if (!this.resuming.has(entry.ref.sessionId)) ready.push(entry.handle);
    }
    return ready;
  }

  trackActivated(ref: SessionRef, handle: ISessionScopeHandle): IDisposable {
    // Keyed by the full SessionRef (M6): two same-named sessions live at once
    // on different runtimes coexist here; the bare-id `get` projection only
    // answers unique matches (see `liveEntryOf`).
    const key = sessionRefKey(ref);
    this.tracked.set(key, { ref, handle });
    return {
      dispose: () => {
        if (this.tracked.get(key)?.handle === handle) this.tracked.delete(key);
      },
    };
  }

  /**
   * The bare-id projection over the ref-keyed tracked map: the single tracked
   * entry with this session id, or `undefined` when there is none — OR when
   * two runtimes host a same-named live pair (answering either would silently
   * route to the wrong session; plan §1.3 rule 5).
   */
  private liveEntryOf(sessionId: string): TrackedSession | undefined {
    let match: TrackedSession | undefined;
    for (const entry of this.tracked.values()) {
      if (entry.ref.sessionId !== sessionId) continue;
      if (match !== undefined) return undefined;
      match = entry;
    }
    return match;
  }

  /* ---------------------------------------------------------------------- */
  /* Resume / restore (delegated: bare id → ref → host)                      */
  /* ---------------------------------------------------------------------- */

  resume(sessionId: string): Promise<ISessionScopeHandle | undefined> {
    const inflight = this.resuming.get(sessionId);
    if (inflight !== undefined) return inflight;
    const live = this.liveEntryOf(sessionId);
    if (live !== undefined) return Promise.resolve(live.handle);
    const promise = this.doResume(sessionId).finally(() => this.resuming.delete(sessionId));
    this.resuming.set(sessionId, promise);
    return promise;
  }

  private async doResume(sessionId: string): Promise<ISessionScopeHandle | undefined> {
    const ref = await this.resolveRef(sessionId);
    if (ref === undefined) return undefined;
    // The host owns the failure telemetry (`session_load_failed`), the
    // per-ref inflight fold, the main-agent ensure, the shared hook run and
    // the `session_started` event — the facade only republishes the
    // lifecycle event for in-process subscribers.
    const scope = await this.host().resume(ref);
    if (scope === undefined) return undefined;
    this._onDidCreateSession.fire({ sessionId, handle: scope.handle, source: 'resume' });
    return scope.handle;
  }

  async restore(sessionId: string): Promise<ISessionScopeHandle | undefined> {
    // Legacy shape: `resume` (folded, single announcement) + clear the
    // archived flag — every caller performs the idempotent clear itself.
    const handle = await this.resume(sessionId);
    if (handle === undefined) return undefined;
    await handle.accessor.get(ISessionMetadata).setArchived(false);
    return handle;
  }

  /**
   * Resolve a bare session id into its owner `SessionRef`: the live lookup
   * first (a live entry already carries its exact ref), then the persisted
   * read model + the runtime manager. `undefined` when the session is
   * unknown or its runtime cannot be brought online — the legacy "unknown
   * session" answer.
   */
  private async resolveRef(sessionId: string): Promise<SessionRef | undefined> {
    const live = this.liveEntryOf(sessionId);
    if (live !== undefined) return live.ref;
    const summary = await this.index.get(sessionId);
    if (summary === undefined) return undefined;
    const runtime = await this.runtimeForWorkspace(summary.workspaceId);
    return runtime === undefined ? undefined : { runtimeId: runtime.id, sessionId };
  }

  /**
   * The workspace's long-lived runtime, registering it on first use: an
   * existing registration wins, otherwise ONE discovery catch-up runs (the
   * same `ensureDiscovered` the kap-server v1 resolver runs) so locally
   * persisted buckets — including ones whose workspace catalog entry was
   * tombstoned — become resolvable. `undefined` when no runtime owns the
   * bucket (the legacy "unresolvable workdir" answer).
   */
  private async runtimeForWorkspace(workspaceId: string): Promise<IWorkspaceRuntime | undefined> {
    const existing = this.runtimeManager.getRuntime(workspaceId);
    if (existing !== undefined) return existing;
    await this.runtimeManager.ensureDiscovered();
    return this.runtimeManager.getRuntime(workspaceId);
  }

  /* ---------------------------------------------------------------------- */
  /* Fork (delegated: source ref resolve → host.fork)                        */
  /* ---------------------------------------------------------------------- */

  async fork(opts: ForkSessionOptions): Promise<ISessionScopeHandle> {
    const sourceRef = await this.resolveRef(opts.sourceSessionId);
    if (sourceRef === undefined) {
      throw new Error2(
        ErrorCodes.SESSION_NOT_FOUND,
        `session ${opts.sourceSessionId} does not exist`,
      );
    }
    // The runtime owns the fork data plane (directory copy, per-agent wire
    // rewrite, cron duplication, the index line); the host owns activation
    // and rollback; the facade republishes the lifecycle events.
    const scope = await this.host().fork(sourceRef, {
      newSessionId: opts.newSessionId,
      title: opts.title,
      metadata: opts.metadata,
    });
    this._onDidForkSession.fire({
      sourceSessionId: opts.sourceSessionId,
      sessionId: scope.ref.sessionId,
      handle: scope.handle,
    });
    this._onDidCreateSession.fire({
      sessionId: scope.ref.sessionId,
      handle: scope.handle,
      source: 'fork',
    });
    return scope.handle;
  }

  async createChild(opts: CreateChildSessionOptions): Promise<ISessionScopeHandle> {
    const title =
      opts.title ??
      `Child: ${(await this.resolveSourceTitle(opts.sourceSessionId)) ?? opts.sourceSessionId}`;
    const metadata = {
      ...opts.metadata,
      [PARENT_SESSION_ID_KEY]: opts.sourceSessionId,
      [CHILD_SESSION_KIND_KEY]: CHILD_SESSION_KIND,
    };
    return this.fork({
      sourceSessionId: opts.sourceSessionId,
      newSessionId: opts.newSessionId,
      title,
      metadata,
    });
  }

  private async resolveSourceTitle(sourceId: string): Promise<string | undefined> {
    const live = this.liveEntryOf(sourceId);
    if (live !== undefined) {
      return (await live.handle.accessor.get(ISessionMetadata).read()).title;
    }
    return (await this.index.get(sourceId))?.title;
  }

  /* ---------------------------------------------------------------------- */
  /* Close / archive (live-only, delegated by the tracked ref)               */
  /* ---------------------------------------------------------------------- */

  async close(sessionId: string): Promise<void> {
    const entry = this.liveEntryOf(sessionId);
    if (entry === undefined) return;
    // The host runs the `SessionEnd` hook slot, detaches the live lookup and
    // tears the scope down; the facade event follows the teardown (the
    // legacy ordering).
    await this.host().close(entry.ref);
    this._onDidCloseSession.fire({ sessionId });
  }

  async archive(sessionId: string): Promise<void> {
    const entry = this.liveEntryOf(sessionId);
    // Legacy archive acts on live sessions only; a cold session is a no-op.
    if (entry === undefined) return;
    await this.host().archive(entry.ref);
    this._onDidArchiveSession.fire({ sessionId });
  }
}

registerScopedService(
  LifecycleScope.App,
  ISessionLifecycleService,
  SessionLifecycleService,
  ScopeActivation.OnScopeCreated,
  'sessionLifecycle',
);
