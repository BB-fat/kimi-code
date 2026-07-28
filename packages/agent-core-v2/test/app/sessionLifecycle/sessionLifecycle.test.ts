/**
 * M8a tests — `SessionLifecycleService` as the thin v1-compatibility facade
 * over `IRuntimeSessionHostService` (multi-runtime refactor, plan §15).
 *
 * The activation machine itself is covered by the `runtimeSessionHost`
 * branch tests and the legacy/runtime black-box parity test in
 * `test/app/runtimeSessionHost/`. These tests pin the FACADE contract:
 *
 *  - `create` resolves the workDir through the Workspace catalog and the
 *    workspace's long-lived runtime (`ensureRegistered`, reused when
 *    already registered), then delegates to `host.create`;
 *  - `resume` / `fork` resolve a bare id through the live lookup first,
 *    then the `sessionIndex` read model + the runtime manager's discovery
 *    catch-up, and delegate;
 *  - `close` / `archive` act on live sessions only and delegate by the
 *    tracked ref;
 *  - the process-wide live lookup is fed ONLY by `trackActivated`, and the
 *    bare-id projection answers unique matches only (plan §1.3 rule 5);
 *  - the facade's lifecycle events fire exactly once per operation;
 *  - the shared hook slots (`onDidCreateSession` / `onWillCloseSession`)
 *    stay available on the facade for the Session-scoped external-hooks
 *    adapter.
 *
 * Run with `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/app/sessionLifecycle/sessionLifecycle.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ISessionScopeHandle,
  LifecycleScope,
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { type ScopedTestHost, createScopedTestHost, stubPair } from '#/_base/di/test';
import { Event } from '#/_base/event';
import {
  IRuntimeSessionHostService,
  type RuntimeSessionHostCreateOptions,
  type RuntimeSessionHostForkOptions,
} from '#/app/runtimeSessionHost/runtimeSessionHost';
import type { IRuntimeSessionScope } from '#/app/runtimeSession/runtimeSessionActivation';
import {
  CHILD_SESSION_KIND,
  CHILD_SESSION_KIND_KEY,
  ISessionIndex,
  PARENT_SESSION_ID_KEY,
  type SessionSummary,
} from '#/app/sessionIndex/sessionIndex';
import { ISessionLifecycleService } from '#/app/sessionLifecycle/sessionLifecycle';
import { SessionLifecycleService } from '#/app/sessionLifecycle/sessionLifecycleService';
import { sessionRefKey, type SessionRef } from '#/app/sessionHostRuntime/sessionRef';
import { IWorkspaceRuntimeManager } from '#/app/workspaceRegistration/workspaceRuntimeManager';
import type { IWorkspaceRuntime } from '#/app/workspace/workspaceRuntime';
import { IWorkspaceService, type Workspace } from '#/app/workspace/workspace';
import { Error2, ErrorCodes } from '#/errors';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

const RUNTIME_ID = 'local-workspace_ws-1';
const WORKSPACE: Workspace = { id: 'ws-1', root: '/tmp/proj' } as Workspace;

/* ------------------------------------------------------------------------ */
/* Stubs                                                                     */
/* ------------------------------------------------------------------------ */

function fakeHandle(id: string, metadata?: ISessionMetadata): ISessionScopeHandle {
  return {
    id,
    kind: LifecycleScope.Session,
    accessor: {
      get: (token: unknown) => {
        if (token === ISessionMetadata) return metadata;
        throw new Error('unexpected accessor.get in facade test');
      },
    },
    dispose: () => {},
  } as unknown as ISessionScopeHandle;
}

function metadataStub(initial: { title?: string; archived?: boolean } = {}): ISessionMetadata & {
  readonly setArchivedCalls: boolean[];
} {
  const setArchivedCalls: boolean[] = [];
  return {
    _serviceBrand: undefined,
    setArchivedCalls,
    ready: Promise.resolve(),
    onDidChangeMetadata: Event.None,
    read: () =>
      Promise.resolve({ title: initial.title, archived: initial.archived === true }) as never,
    update: () => Promise.resolve(),
    setTitle: () => Promise.resolve(),
    setArchived: (archived: boolean) => {
      setArchivedCalls.push(archived);
      return Promise.resolve();
    },
    registerAgent: () => Promise.resolve(),
  } as unknown as ISessionMetadata & { setArchivedCalls: boolean[] };
}

interface HostStub {
  readonly createCalls: RuntimeSessionHostCreateOptions[];
  readonly resumeCalls: SessionRef[];
  readonly forkCalls: { ref: SessionRef; opts: RuntimeSessionHostForkOptions | undefined }[];
  readonly closeCalls: SessionRef[];
  readonly archiveCalls: SessionRef[];
  readonly service: IRuntimeSessionHostService;
  /** Mirror of the real host: publishing an activation into the facade. */
  activate(ref: SessionRef, handle: ISessionScopeHandle): IRuntimeSessionScope;
  /** Control an in-flight resume (the inflight-fold tests). */
  deferResume(): void;
  resolveDeferred(scope: IRuntimeSessionScope | undefined): void;
}

function hostStub(
  lifecycle: () => ISessionLifecycleService,
  handleFor: (sessionId: string) => ISessionScopeHandle = fakeHandle,
): HostStub {
  const createCalls: RuntimeSessionHostCreateOptions[] = [];
  const resumeCalls: SessionRef[] = [];
  const forkCalls: { ref: SessionRef; opts: RuntimeSessionHostForkOptions | undefined }[] = [];
  const closeCalls: SessionRef[] = [];
  const archiveCalls: SessionRef[] = [];
  const trackings = new Map<string, { dispose: () => void }>();
  let deferred: { resolve: (scope: IRuntimeSessionScope | undefined) => void } | undefined;

  const activate = (ref: SessionRef, handle: ISessionScopeHandle): IRuntimeSessionScope => {
    trackings.set(sessionRefKey(ref), lifecycle().trackActivated(ref, handle));
    return { ref, handle, lease: undefined as never } as unknown as IRuntimeSessionScope;
  };

  const service = {
    _serviceBrand: undefined,
    onDidActivateSession: Event.None,
    onDidCloseSession: Event.None,
    onDidArchiveSession: Event.None,
    onDidForkSession: Event.None,
    create: (opts: RuntimeSessionHostCreateOptions) => {
      createCalls.push(opts);
      const ref = { runtimeId: opts.runtimeId, sessionId: opts.sessionId ?? 'session_minted' };
      return Promise.resolve(activate(ref, handleFor(ref.sessionId)));
    },
    get: () => undefined,
    list: () => [],
    resume: (ref: SessionRef) => {
      resumeCalls.push(ref);
      if (deferred !== undefined) {
        return new Promise<IRuntimeSessionScope | undefined>((resolve) => {
          deferred = { resolve };
        });
      }
      return Promise.resolve(activate(ref, handleFor(ref.sessionId)));
    },
    restore: (ref: SessionRef) =>
      Promise.resolve(activate(ref, handleFor(ref.sessionId))),
    fork: (ref: SessionRef, opts?: RuntimeSessionHostForkOptions) => {
      forkCalls.push({ ref, opts });
      const targetRef = {
        runtimeId: ref.runtimeId,
        sessionId: opts?.newSessionId ?? 'session_fork_minted',
      };
      return Promise.resolve(activate(targetRef, handleFor(targetRef.sessionId)));
    },
    close: (ref: SessionRef) => {
      closeCalls.push(ref);
      trackings.get(sessionRefKey(ref))?.dispose();
      trackings.delete(sessionRefKey(ref));
      return Promise.resolve();
    },
    archive: (ref: SessionRef) => {
      archiveCalls.push(ref);
      trackings.get(sessionRefKey(ref))?.dispose();
      trackings.delete(sessionRefKey(ref));
      return Promise.resolve();
    },
  } as unknown as IRuntimeSessionHostService;

  return {
    createCalls,
    resumeCalls,
    forkCalls,
    closeCalls,
    archiveCalls,
    service,
    activate,
    deferResume: () => {
      deferred = { resolve: () => {} };
    },
    resolveDeferred: (scope) => deferred?.resolve(scope),
  };
}

function indexStub(summaries: Record<string, SessionSummary | undefined> = {}): ISessionIndex {
  return {
    _serviceBrand: undefined,
    list: () => Promise.resolve({ items: [] }),
    get: (id: string) => Promise.resolve(summaries[id]),
    countActive: () => Promise.resolve(0),
  };
}

function summaryOf(sessionId: string, workspaceId = WORKSPACE.id): SessionSummary {
  return {
    id: sessionId,
    workspaceId,
    createdAt: 1,
    updatedAt: 1,
    archived: false,
  };
}

interface RuntimeManagerStub {
  readonly runtime: IWorkspaceRuntime;
  readonly ensureRegisteredCalls: { workspaceId: string; root: string }[];
  /** Discovery catch-up registers the runtime (the resolvable-bucket case). */
  letDiscovered: boolean;
  service: IWorkspaceRuntimeManager;
}

function runtimeManagerStub(startRegistered = true): RuntimeManagerStub {
  const runtime = { id: RUNTIME_ID, kind: 'local-workspace' } as IWorkspaceRuntime;
  const stub: RuntimeManagerStub = {
    runtime,
    ensureRegisteredCalls: [],
    letDiscovered: false,
    service: undefined as never,
  };
  let registered = startRegistered;
  stub.service = {
    _serviceBrand: undefined,
    getRuntime: () => (registered ? runtime : undefined),
    requireRuntime: () => runtime,
    ensureRegistered: (ref: { workspaceId: string; root: string }) => {
      stub.ensureRegisteredCalls.push(ref);
      registered = true;
      return Promise.resolve(runtime);
    },
    ensureDiscovered: () => {
      if (stub.letDiscovered) registered = true;
      return Promise.resolve([]);
    },
    registerProvider: () => {},
    unregister: () => Promise.resolve(),
    list: () => [],
  } as unknown as IWorkspaceRuntimeManager;
  return stub;
}

function workspaceStub(): IWorkspaceService {
  return {
    _serviceBrand: undefined,
    get: (id: string) => Promise.resolve(id === WORKSPACE.id ? WORKSPACE : undefined),
    list: () => Promise.resolve([WORKSPACE]),
    createOrTouch: (root: string) => Promise.resolve({ ...WORKSPACE, root }),
    update: () => Promise.resolve(undefined),
    delete: () => Promise.resolve(),
  } as unknown as IWorkspaceService;
}

/* ------------------------------------------------------------------------ */
/* Harness                                                                   */
/* ------------------------------------------------------------------------ */

describe('SessionLifecycleService (M8a facade)', () => {
  let host: ScopedTestHost | undefined;

  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      ISessionLifecycleService,
      SessionLifecycleService,
      ScopeActivation.OnDemand,
      'sessionLifecycle',
    );
  });

  afterEach(() => {
    host?.dispose();
    host = undefined;
  });

  function build(
    input: {
      readonly summaries?: Record<string, SessionSummary | undefined>;
      readonly runtimeManager?: RuntimeManagerStub;
      readonly handleFor?: (sessionId: string) => ISessionScopeHandle;
    } = {},
  ) {
    const runtimeManager = input.runtimeManager ?? runtimeManagerStub();
    let facade!: ISessionLifecycleService;
    const runtime = hostStub(() => facade, input.handleFor);
    host = createScopedTestHost([
      stubPair(IRuntimeSessionHostService, runtime.service),
      stubPair(ISessionIndex, indexStub(input.summaries)),
      stubPair(IWorkspaceService, workspaceStub()),
      stubPair(IWorkspaceRuntimeManager, runtimeManager.service),
    ]);
    facade = host.app.accessor.get(ISessionLifecycleService);
    return { facade, runtime, runtimeManager };
  }

  /* ---------------------------------------------------------------------- */
  /* Create                                                                  */
  /* ---------------------------------------------------------------------- */

  it('create resolves the workspace, reuses its runtime, delegates and announces', async () => {
    const { facade, runtime, runtimeManager } = build();
    const created: string[] = [];
    facade.onDidCreateSession((event) => created.push(`${event.source}:${event.sessionId}`));

    const handle = await facade.create({ sessionId: 's1', workDir: '/tmp/proj' });

    expect(handle.id).toBe('s1');
    expect(runtimeManager.ensureRegisteredCalls).toEqual([
      { workspaceId: WORKSPACE.id, root: '/tmp/proj' },
    ]);
    expect(runtime.createCalls).toEqual([
      {
        runtimeId: RUNTIME_ID,
        sessionId: 's1',
        mcpServers: undefined,
        mainAgentBinding: undefined,
        additionalDirs: undefined,
      },
    ]);
    expect(created).toEqual(['startup:s1']);
    // The activation was published into the live lookup by the host.
    expect(facade.get('s1')).toBe(handle);
    expect(facade.getByRef({ runtimeId: RUNTIME_ID, sessionId: 's1' })).toBe(handle);
    expect(facade.list()).toEqual([handle]);
  });

  /* ---------------------------------------------------------------------- */
  /* Live lookup                                                             */
  /* ---------------------------------------------------------------------- */

  it('the live lookup reflects only tracked sessions and detaches on dispose', () => {
    const { facade } = build();
    const handle = fakeHandle('s1');
    const ref = { runtimeId: RUNTIME_ID, sessionId: 's1' };

    const tracking = facade.trackActivated(ref, handle);
    expect(facade.get('s1')).toBe(handle);
    expect(facade.getByRef(ref)).toBe(handle);
    expect(facade.getByRef({ runtimeId: 'other', sessionId: 's1' })).toBeUndefined();

    tracking.dispose();
    expect(facade.get('s1')).toBeUndefined();
    expect(facade.getByRef(ref)).toBeUndefined();
    expect(facade.list()).toEqual([]);
  });

  it('bare get answers undefined for a same-named pair hosted by two runtimes (M6)', () => {
    const { facade } = build();
    const handleA = fakeHandle('shared');
    const handleB = fakeHandle('shared');
    facade.trackActivated({ runtimeId: 'rt-a', sessionId: 'shared' }, handleA);
    facade.trackActivated({ runtimeId: 'rt-b', sessionId: 'shared' }, handleB);

    // Ambiguous bare id: never guessed (plan §1.3 rule 5).
    expect(facade.get('shared')).toBeUndefined();
    // Ref-addressed lookups stay exact.
    expect(facade.getByRef({ runtimeId: 'rt-a', sessionId: 'shared' })).toBe(handleA);
    expect(facade.getByRef({ runtimeId: 'rt-b', sessionId: 'shared' })).toBe(handleB);
    expect(facade.list()).toEqual([handleA, handleB]);
  });

  /* ---------------------------------------------------------------------- */
  /* Resume                                                                  */
  /* ---------------------------------------------------------------------- */

  it('resume returns the live entry without re-activating', async () => {
    const { facade, runtime } = build();
    const handle = fakeHandle('s1');
    facade.trackActivated({ runtimeId: RUNTIME_ID, sessionId: 's1' }, handle);

    const resumed = await facade.resume('s1');
    expect(resumed).toBe(handle);
    expect(runtime.resumeCalls).toEqual([]);
  });

  it('resume resolves a cold session through the index and the runtime manager', async () => {
    const { facade, runtime } = build({ summaries: { s1: summaryOf('s1') } });
    const created: string[] = [];
    facade.onDidCreateSession((event) => created.push(`${event.source}:${event.sessionId}`));

    const resumed = await facade.resume('s1');
    expect(resumed?.id).toBe('s1');
    expect(runtime.resumeCalls).toEqual([{ runtimeId: RUNTIME_ID, sessionId: 's1' }]);
    expect(created).toEqual(['resume:s1']);
    // Now live: a second resume must not re-activate.
    expect(await facade.resume('s1')).toBe(resumed);
    expect(runtime.resumeCalls).toHaveLength(1);
  });

  it('resume runs the discovery catch-up when the runtime is not registered yet', async () => {
    const runtimeManager = runtimeManagerStub(false);
    runtimeManager.letDiscovered = true;
    const { facade, runtime } = build({
      summaries: { s1: summaryOf('s1') },
      runtimeManager,
    });

    const resumed = await facade.resume('s1');
    expect(resumed?.id).toBe('s1');
    expect(runtime.resumeCalls).toEqual([{ runtimeId: RUNTIME_ID, sessionId: 's1' }]);
  });

  it('resume returns undefined for an unknown session', async () => {
    const { facade, runtime } = build();
    expect(await facade.resume('ghost')).toBeUndefined();
    expect(runtime.resumeCalls).toEqual([]);
  });

  it('resume returns undefined when no runtime owns the bucket', async () => {
    const { facade, runtime } = build({
      summaries: { s1: summaryOf('s1', 'ws-gone') },
      runtimeManager: runtimeManagerStub(false),
    });
    expect(await facade.resume('s1')).toBeUndefined();
    expect(runtime.resumeCalls).toEqual([]);
  });

  it('concurrent resumes fold into one activation and one announcement', async () => {
    const { facade, runtime } = build({ summaries: { s1: summaryOf('s1') } });
    runtime.deferResume();
    const created: string[] = [];
    facade.onDidCreateSession((event) => created.push(`${event.source}:${event.sessionId}`));

    const first = facade.resume('s1');
    const second = facade.resume('s1');
    // Hidden while the resume is in flight (legacy semantics).
    expect(facade.get('s1')).toBeUndefined();
    expect(facade.list()).toEqual([]);

    // Wait until the facade's delegation reached the (deferred) host resume.
    await vi.waitFor(() => expect(runtime.resumeCalls).toHaveLength(1));
    const scope = runtime.activate({ runtimeId: RUNTIME_ID, sessionId: 's1' }, fakeHandle('s1'));
    runtime.resolveDeferred(scope);
    const [handleA, handleB] = await Promise.all([first, second]);
    expect(handleA).toBe(handleB);
    expect(runtime.resumeCalls).toHaveLength(1);
    expect(created).toEqual(['resume:s1']);
    expect(facade.get('s1')).toBe(handleA);
  });

  /* ---------------------------------------------------------------------- */
  /* Restore                                                                 */
  /* ---------------------------------------------------------------------- */

  it('restore resumes and clears the archived flag', async () => {
    const metadata = metadataStub({ archived: true });
    const { facade } = build({
      summaries: { s1: summaryOf('s1') },
      handleFor: (sessionId) => fakeHandle(sessionId, metadata),
    });

    const restored = await facade.restore('s1');
    expect(restored?.id).toBe('s1');
    expect(metadata.setArchivedCalls).toEqual([false]);
  });

  /* ---------------------------------------------------------------------- */
  /* Fork                                                                    */
  /* ---------------------------------------------------------------------- */

  it('fork resolves a live source and delegates, firing fork + create events', async () => {
    const { facade, runtime } = build();
    const created: string[] = [];
    const forked: string[] = [];
    facade.onDidCreateSession((event) => created.push(`${event.source}:${event.sessionId}`));
    facade.onDidForkSession((event) =>
      forked.push(`${event.sourceSessionId}->${event.sessionId}`),
    );
    facade.trackActivated({ runtimeId: RUNTIME_ID, sessionId: 'src' }, fakeHandle('src'));

    const target = await facade.fork({ sourceSessionId: 'src', newSessionId: 'dst', title: 'T' });

    expect(target.id).toBe('dst');
    expect(runtime.forkCalls).toEqual([
      { ref: { runtimeId: RUNTIME_ID, sessionId: 'src' }, opts: { newSessionId: 'dst', title: 'T', metadata: undefined } },
    ]);
    expect(forked).toEqual(['src->dst']);
    expect(created).toEqual(['fork:dst']);
  });

  it('fork resolves a cold source through the index', async () => {
    const { facade, runtime } = build({ summaries: { src: summaryOf('src') } });
    await facade.fork({ sourceSessionId: 'src', newSessionId: 'dst' });
    expect(runtime.forkCalls).toEqual([
      { ref: { runtimeId: RUNTIME_ID, sessionId: 'src' }, opts: { newSessionId: 'dst', title: undefined, metadata: undefined } },
    ]);
  });

  it('fork throws SESSION_NOT_FOUND for an unknown source', async () => {
    const { facade } = build();
    const error = await facade.fork({ sourceSessionId: 'ghost' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error2);
    expect((error as Error2).code).toBe(ErrorCodes.SESSION_NOT_FOUND);
  });

  it('createChild applies the default title and the child markers', async () => {
    const { facade, runtime } = build();
    const parentMeta = metadataStub({ title: 'Parent Title' });
    facade.trackActivated(
      { runtimeId: RUNTIME_ID, sessionId: 'parent' },
      fakeHandle('parent', parentMeta),
    );

    await facade.createChild({ sourceSessionId: 'parent', newSessionId: 'child' });
    expect(runtime.forkCalls).toEqual([
      {
        ref: { runtimeId: RUNTIME_ID, sessionId: 'parent' },
        opts: {
          newSessionId: 'child',
          title: 'Child: Parent Title',
          metadata: {
            [PARENT_SESSION_ID_KEY]: 'parent',
            [CHILD_SESSION_KIND_KEY]: CHILD_SESSION_KIND,
          },
        },
      },
    ]);
  });

  /* ---------------------------------------------------------------------- */
  /* Close / archive                                                         */
  /* ---------------------------------------------------------------------- */

  it('close delegates by the tracked ref and fires onDidCloseSession', async () => {
    const { facade, runtime } = build();
    const closed: string[] = [];
    facade.onDidCloseSession((event) => closed.push(event.sessionId));
    runtime.activate({ runtimeId: RUNTIME_ID, sessionId: 's1' }, fakeHandle('s1'));

    await facade.close('s1');
    expect(runtime.closeCalls).toEqual([{ runtimeId: RUNTIME_ID, sessionId: 's1' }]);
    expect(closed).toEqual(['s1']);
    expect(facade.get('s1')).toBeUndefined();

    // Cold: a no-op (legacy semantics).
    await facade.close('s1');
    expect(runtime.closeCalls).toHaveLength(1);
  });

  it('archive delegates by the tracked ref and fires onDidArchiveSession', async () => {
    const { facade, runtime } = build();
    const archived: string[] = [];
    facade.onDidArchiveSession((event) => archived.push(event.sessionId));
    runtime.activate({ runtimeId: RUNTIME_ID, sessionId: 's1' }, fakeHandle('s1'));

    await facade.archive('s1');
    expect(runtime.archiveCalls).toEqual([{ runtimeId: RUNTIME_ID, sessionId: 's1' }]);
    expect(archived).toEqual(['s1']);

    // Cold: a no-op (legacy semantics).
    await facade.archive('s1');
    expect(runtime.archiveCalls).toHaveLength(1);
  });

  it('close/archive never guess between a same-named pair (M6)', async () => {
    const { facade, runtime } = build();
    runtime.activate({ runtimeId: 'rt-a', sessionId: 'shared' }, fakeHandle('shared'));
    runtime.activate({ runtimeId: 'rt-b', sessionId: 'shared' }, fakeHandle('shared'));

    await facade.close('shared');
    await facade.archive('shared');
    expect(runtime.closeCalls).toEqual([]);
    expect(runtime.archiveCalls).toEqual([]);
  });

  /* ---------------------------------------------------------------------- */
  /* Shared hook slots                                                       */
  /* ---------------------------------------------------------------------- */

  it('exposes the shared lifecycle hook slots for the external-hooks adapter', async () => {
    const { facade } = build();
    const seen: string[] = [];
    facade.hooks.onDidCreateSession.register('externalHooks', async (event, next) => {
      seen.push(`start:${event.source}:${event.sessionId}`);
      await next();
    });
    facade.hooks.onWillCloseSession.register('externalHooks', async (event, next) => {
      seen.push(`end:${event.reason}:${event.sessionId}`);
      await next();
    });

    // The runtime session host runs the slots hosted on the facade — the
    // Session-scoped adapter must observe them exactly like a legacy run.
    await facade.hooks.onDidCreateSession.run({
      sessionId: 's1',
      handle: fakeHandle('s1'),
      source: 'startup',
    });
    await facade.hooks.onWillCloseSession.run({
      sessionId: 's1',
      handle: fakeHandle('s1'),
      reason: 'exit',
    });
    expect(seen).toEqual(['start:startup:s1', 'end:exit:s1']);
  });
});
