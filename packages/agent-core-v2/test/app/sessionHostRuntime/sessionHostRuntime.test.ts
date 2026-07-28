/**
 * M0 tests for the `sessionHostRuntime` domain (plan §9.1/§9.2, M0-coverable
 * part): SessionRef identity, the host-runtime registry, and the
 * registry-based SessionService routing skeleton.
 *
 * The fake runtimes here are test-local stubs proving the 1:N shape (one
 * runtime instance hosts many sessions) — real runtimes land from M1 on.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

import { isErrorCode } from '#/_base/errors/codes';
import { NotImplementedError } from '#/_base/errors/errors';
import { ErrorCodes } from '#/errors';
import {
  isSessionHostRuntimeError,
  SessionHostRuntimeErrors,
} from '#/app/sessionHostRuntime/errors';
import type {
  ISessionHostRuntime,
  RuntimeCloseReason,
  SessionRuntimeCapability,
  SessionRuntimeStatus,
} from '#/app/sessionHostRuntime/sessionHostRuntime';
import type {
  CreateSessionInput,
  DeleteSessionOptions,
  ISessionManager,
  OpenSessionOptions,
  ResumeSessionOptions,
  SameRuntimeForkInput,
  SessionExportEntry,
  SessionExportOptions,
  SessionImportInput,
  SessionListQuery,
  SessionPage,
  UpdateSessionPatch,
} from '#/app/sessionHostRuntime/sessionManager';
import {
  sessionRefEquals,
  sessionRefKey,
  type SessionRef,
} from '#/app/sessionHostRuntime/sessionRef';
import {
  SessionHostRuntimeRegistry,
  type SessionHostRuntimeRegistryEvent,
} from '#/app/sessionHostRuntime/sessionHostRuntimeRegistry';
import {
  SessionService,
  type ISessionHandle,
  type ISessionService,
} from '#/app/sessionHostRuntime/sessionService';
import {
  toPersistenceNamespace,
  type ISessionArtifactService,
  type ISessionColdReader,
  type ISessionPersistenceContext,
  type ISessionRuntimeContext,
  type SessionCloseReason,
  type SessionDescriptor,
} from '#/app/sessionHostRuntime/sessionRuntimeContext';

/* ------------------------------------------------------------------------ */
/* Test-local 1:N fake runtime                                               */
/* ------------------------------------------------------------------------ */

class FakeSessionManager implements ISessionManager {
  readonly descriptors = new Map<string, SessionDescriptor>();
  readonly calls: string[] = [];
  lastCloseReason: SessionCloseReason | undefined;

  constructor(private readonly runtimeId: string) {}

  create(input: CreateSessionInput): Promise<SessionDescriptor> {
    this.calls.push('create');
    const sessionId = input.sessionId ?? `s-${this.descriptors.size + 1}`;
    const descriptor: SessionDescriptor = {
      ref: { runtimeId: this.runtimeId, sessionId },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'active',
      metadata: input.metadata ?? {},
    };
    this.descriptors.set(sessionId, descriptor);
    return Promise.resolve(descriptor);
  }

  list(query?: SessionListQuery): Promise<SessionPage> {
    this.calls.push('list');
    void query;
    return Promise.resolve({ items: [...this.descriptors.values()] });
  }

  get(sessionId: string): Promise<SessionDescriptor | undefined> {
    this.calls.push(`get:${sessionId}`);
    return Promise.resolve(this.descriptors.get(sessionId));
  }

  update(sessionId: string, patch: UpdateSessionPatch): Promise<SessionDescriptor> {
    this.calls.push(`update:${sessionId}`);
    const existing = this.descriptors.get(sessionId);
    if (existing === undefined) throw new Error('unreachable in tests');
    const updated: SessionDescriptor = {
      ...existing,
      metadata: { ...existing.metadata, ...patch.metadata },
      status: patch.status ?? existing.status,
    };
    this.descriptors.set(sessionId, updated);
    return Promise.resolve(updated);
  }

  delete(sessionId: string, options?: DeleteSessionOptions): Promise<void> {
    this.calls.push(`delete:${sessionId}`);
    void options;
    this.descriptors.delete(sessionId);
    return Promise.resolve();
  }

  open(sessionId: string, options: OpenSessionOptions): Promise<ISessionRuntimeContext> {
    this.calls.push(`open:${sessionId}`);
    void options;
    return Promise.resolve(this.fakeContext(sessionId));
  }

  resume(sessionId: string, options: ResumeSessionOptions): Promise<ISessionRuntimeContext> {
    this.calls.push(`resume:${sessionId}`);
    void options;
    return Promise.resolve(this.fakeContext(sessionId));
  }

  fork(sourceSessionId: string, input: SameRuntimeForkInput): Promise<SessionDescriptor> {
    this.calls.push(`fork:${sourceSessionId}`);
    return this.create({ sessionId: input.sessionId, metadata: {} });
  }

  coldRead(sessionId: string): Promise<ISessionColdReader> {
    this.calls.push(`coldRead:${sessionId}`);
    throw new NotImplementedError('coldRead');
  }

  export(sessionId: string, options?: SessionExportOptions): AsyncIterable<SessionExportEntry> {
    this.calls.push(`export:${sessionId}`);
    void options;
    throw new NotImplementedError('export');
  }

  import(input: SessionImportInput): Promise<SessionDescriptor> {
    this.calls.push('import');
    void input;
    throw new NotImplementedError('import');
  }

  private fakeContext(sessionId: string): ISessionRuntimeContext {
    const descriptor = this.descriptors.get(sessionId);
    if (descriptor === undefined) throw new Error(`no such session '${sessionId}' in fake`);
    return {
      ref: descriptor.ref,
      descriptor,
      persistence: undefined as unknown as ISessionPersistenceContext,
      artifacts: undefined as unknown as ISessionArtifactService,
      coldReader: undefined as unknown as ISessionColdReader,
      capabilities: new Set(),
      contributions: { sessionServices: [], agentServices: [], tools: [] },
      flush: () => Promise.resolve(),
      close: (reason) => {
        this.lastCloseReason = reason;
        return Promise.resolve();
      },
    };
  }
}

class FakeHostRuntime implements ISessionHostRuntime {
  readonly sessions: FakeSessionManager;
  readonly closeCalls: RuntimeCloseReason[] = [];

  constructor(
    readonly id: string,
    private runtimeStatus: SessionRuntimeStatus = 'online',
    private readonly caps: ReadonlySet<SessionRuntimeCapability> = new Set(),
  ) {
    this.sessions = new FakeSessionManager(id);
  }

  get kind(): string {
    return 'fake';
  }

  status(): SessionRuntimeStatus {
    return this.runtimeStatus;
  }

  setStatus(status: SessionRuntimeStatus): void {
    this.runtimeStatus = status;
  }

  capabilities(): ReadonlySet<SessionRuntimeCapability> {
    return this.caps;
  }

  close(reason: RuntimeCloseReason): Promise<void> {
    this.closeCalls.push(reason);
    return Promise.resolve();
  }
}

/* ------------------------------------------------------------------------ */
/* SessionRef (plan §1.2)                                                    */
/* ------------------------------------------------------------------------ */

describe('SessionRef', () => {
  it('encodes ref keys exactly as plan §1.2 specifies', () => {
    const ref: SessionRef = { runtimeId: 'local', sessionId: 'abc' };
    expect(sessionRefKey(ref)).toBe('local:abc');
  });

  it('uri-encodes both segments so reserved characters stay unambiguous', () => {
    expect(sessionRefKey({ runtimeId: 'local/a', sessionId: 's:1' })).toBe('local%2Fa:s%3A1');
    // Different splits never collide.
    expect(sessionRefKey({ runtimeId: 'a:b', sessionId: 'c' })).not.toBe(
      sessionRefKey({ runtimeId: 'a', sessionId: 'b:c' }),
    );
  });

  it('distinguishes same-named sessions of different runtimes', () => {
    const a: SessionRef = { runtimeId: 'rt-a', sessionId: 'same-id' };
    const b: SessionRef = { runtimeId: 'rt-b', sessionId: 'same-id' };
    expect(sessionRefKey(a)).not.toBe(sessionRefKey(b));
    expect(sessionRefEquals(a, b)).toBe(false);
    expect(sessionRefEquals(a, { ...a })).toBe(true);
  });
});

/* ------------------------------------------------------------------------ */
/* PersistenceNamespace                                                      */
/* ------------------------------------------------------------------------ */

describe('toPersistenceNamespace', () => {
  it('accepts plain segmented namespaces', () => {
    expect(toPersistenceNamespace('session')).toBe('session');
    expect(toPersistenceNamespace('agents/main')).toBe('agents/main');
  });

  it('rejects empty, dot and backslash segments', () => {
    for (const bad of ['', 'a//b', 'a/./b', 'a/../b', '.', '..', 'a\\b']) {
      expect(() => toPersistenceNamespace(bad), bad).toThrowError(/invalid persistence namespace/);
    }
  });
});

/* ------------------------------------------------------------------------ */
/* Error domain (plan §8)                                                    */
/* ------------------------------------------------------------------------ */

describe('SessionHostRuntimeErrors', () => {
  it('registers every plan §8 coded cause into the global registry', () => {
    const expected = [
      'session.runtime_not_found',
      'session.runtime_unavailable',
      'session.runtime_id_conflict',
      'session.identity_ambiguous',
      'session.not_found',
      'session.lease_conflict',
      'session.capability_unavailable',
      'session.open_failed',
      'session.transfer_failed',
      'session.transfer_source_changed',
      'artifact.owner_mismatch',
    ];
    for (const code of expected) {
      expect(isErrorCode(code), code).toBe(true);
    }
    // `session.not_found` stays owned by the pre-existing session domain; the
    // other ten come from this domain's registration.
    const owned = Object.values(SessionHostRuntimeErrors.codes);
    expect(owned).toHaveLength(10);
    expect(owned).not.toContain('session.not_found');
    for (const code of [...owned, 'session.not_found'] as const) {
      expect(Object.values(ErrorCodes), code).toContain(code);
    }
  });
});

/* ------------------------------------------------------------------------ */
/* Registry (plan §3.1 / §9.2)                                               */
/* ------------------------------------------------------------------------ */

describe('SessionHostRuntimeRegistry', () => {
  it('registers, resolves and summarizes a runtime', () => {
    const registry = new SessionHostRuntimeRegistry();
    const runtime = new FakeHostRuntime('rt-a', 'online', new Set(['session.export']));
    registry.register(runtime);

    expect(registry.get('rt-a')).toBe(runtime);
    expect(registry.require('rt-a')).toBe(runtime);
    expect(registry.list()).toEqual([
      { id: 'rt-a', kind: 'fake', status: 'online', capabilities: ['session.export'] },
    ]);
  });

  it('holds several runtimes at once (multi-runtime registry, plan §9.2)', () => {
    const registry = new SessionHostRuntimeRegistry();
    const a = new FakeHostRuntime('local-a');
    const b = new FakeHostRuntime('local-b');
    const c = new FakeHostRuntime('remote-c');
    registry.register(a);
    registry.register(b);
    registry.register(c);

    expect(registry.list().map((summary) => summary.id)).toEqual([
      'local-a',
      'local-b',
      'remote-c',
    ]);
  });

  it('rejects a duplicate runtimeId with session.runtime_id_conflict', () => {
    const registry = new SessionHostRuntimeRegistry();
    registry.register(new FakeHostRuntime('rt-a'));
    let caught: unknown;
    try {
      registry.register(new FakeHostRuntime('rt-a'));
    } catch (error) {
      caught = error;
    }
    expect(isSessionHostRuntimeError(caught, 'session.runtime_id_conflict')).toBe(true);
    // The first registration survives the conflict.
    expect(registry.list()).toHaveLength(1);
  });

  it('treats re-registering the same instance as a no-op', () => {
    const registry = new SessionHostRuntimeRegistry();
    const runtime = new FakeHostRuntime('rt-a');
    const first = registry.register(runtime);
    const second = registry.register(runtime);
    // The no-op handle does not unregister; the original lease does.
    second.dispose();
    expect(registry.get('rt-a')).toBe(runtime);
    first.dispose();
    expect(registry.get('rt-a')).toBeUndefined();
  });

  it('unregister removes routing only — the runtime itself is not closed', () => {
    const registry = new SessionHostRuntimeRegistry();
    const runtime = new FakeHostRuntime('rt-a');
    const registration = registry.register(runtime);

    registration.dispose();
    expect(registry.get('rt-a')).toBeUndefined();
    expect(() => registry.require('rt-a')).toThrowError(
      expect.objectContaining({ code: 'session.runtime_not_found' }) as Error,
    );
    expect(runtime.closeCalls).toEqual([]);
  });

  it('keeps offline entries so require fails with session.runtime_unavailable', () => {
    const registry = new SessionHostRuntimeRegistry();
    const runtime = new FakeHostRuntime('rt-a');
    registry.register(runtime);
    runtime.setStatus('offline');

    expect(registry.list().map((summary) => summary.status)).toEqual(['offline']);
    expect(registry.get('rt-a')).toBe(runtime);
    expect(() => registry.require('rt-a')).toThrowError(
      expect.objectContaining({ code: 'session.runtime_unavailable' }) as Error,
    );
  });

  it('emits registered/unregistered events to watchers', () => {
    const registry = new SessionHostRuntimeRegistry();
    const events: SessionHostRuntimeRegistryEvent[] = [];
    const subscription = registry.watch((event) => events.push(event));

    const registration = registry.register(new FakeHostRuntime('rt-a'));
    registration.dispose();
    subscription.dispose();
    registry.register(new FakeHostRuntime('rt-b'));

    expect(events.map((event) => `${event.kind}:${event.runtime.id}`)).toEqual([
      'registered:rt-a',
      'unregistered:rt-a',
    ]);
  });
});

/* ------------------------------------------------------------------------ */
/* SessionService routing skeleton (plan §3.4)                               */
/* ------------------------------------------------------------------------ */

describe('SessionService', () => {
  function setup() {
    const registry = new SessionHostRuntimeRegistry();
    const service: ISessionService = new SessionService(registry);
    return { registry, service };
  }

  it('create routes to an already-registered runtime and returns the full ref', async () => {
    const { registry, service } = setup();
    const runtime = new FakeHostRuntime('rt-a');
    registry.register(runtime);

    const descriptor = await service.create('rt-a', { metadata: { title: 'one' } });
    expect(descriptor.ref).toEqual({ runtimeId: 'rt-a', sessionId: 's-1' });
    expect(runtime.sessions.calls).toEqual(['create']);
  });

  it('one runtime hosts many sessions (1:N): repeated create shares runtimeId', async () => {
    const { registry, service } = setup();
    registry.register(new FakeHostRuntime('rt-a'));

    const a = await service.create('rt-a', {});
    const b = await service.create('rt-a', {});
    const c = await service.create('rt-a', {});
    expect([a.ref.runtimeId, b.ref.runtimeId, c.ref.runtimeId]).toEqual([
      'rt-a',
      'rt-a',
      'rt-a',
    ]);
    expect(new Set([a.ref.sessionId, b.ref.sessionId, c.ref.sessionId]).size).toBe(3);
  });

  it('create/get/update/delete/open/resume fail accurately for unknown or offline runtimes', async () => {
    const { registry, service } = setup();
    const runtime = new FakeHostRuntime('rt-a');
    registry.register(runtime);
    const ref: SessionRef = { runtimeId: 'rt-a', sessionId: 's-1' };

    await expect(service.get(ref)).resolves.toBeUndefined();
    await expect(service.create('gone', {})).rejects.toMatchObject({
      code: 'session.runtime_not_found',
    });
    await expect(service.get({ runtimeId: 'gone', sessionId: 's' })).rejects.toMatchObject({
      code: 'session.runtime_not_found',
    });

    runtime.setStatus('offline');
    await expect(service.get(ref)).rejects.toMatchObject({ code: 'session.runtime_unavailable' });
    await expect(service.create('rt-a', {})).rejects.toMatchObject({
      code: 'session.runtime_unavailable',
    });
  });

  it('get/update/delete delegate with the runtime-local session id only', async () => {
    const { registry, service } = setup();
    const runtime = new FakeHostRuntime('rt-a');
    registry.register(runtime);
    const created = await service.create('rt-a', { metadata: { title: 'one' } });
    const ref = created.ref;

    expect(await service.get(ref)).toMatchObject({ metadata: { title: 'one' } });
    const updated = await service.update(ref, { metadata: { title: 'two' } });
    expect(updated.metadata).toMatchObject({ title: 'two' });
    await service.delete(ref);
    expect(await service.get(ref)).toBeUndefined();
    expect(runtime.sessions.calls).toEqual([
      'create',
      `get:${ref.sessionId}`,
      `update:${ref.sessionId}`,
      `delete:${ref.sessionId}`,
      `get:${ref.sessionId}`,
    ]);
  });

  it('routes same-named sessions of two runtimes to the right owner (plan §9.2)', async () => {
    const { registry, service } = setup();
    const a = new FakeHostRuntime('rt-a');
    const b = new FakeHostRuntime('rt-b');
    registry.register(a);
    registry.register(b);

    await service.create('rt-a', { sessionId: 'same-id', metadata: { marker: 'a' } });
    await service.create('rt-b', { sessionId: 'same-id', metadata: { marker: 'b' } });

    const fromA = await service.get({ runtimeId: 'rt-a', sessionId: 'same-id' });
    const fromB = await service.get({ runtimeId: 'rt-b', sessionId: 'same-id' });
    expect(fromA?.metadata).toMatchObject({ marker: 'a' });
    expect(fromB?.metadata).toMatchObject({ marker: 'b' });
    expect(a.sessions.calls).toEqual(['create', 'get:same-id']);
    expect(b.sessions.calls).toEqual(['create', 'get:same-id']);
  });

  it('open/resume return a handle whose close only closes the child lease', async () => {
    const { registry, service } = setup();
    const runtime = new FakeHostRuntime('rt-a');
    registry.register(runtime);
    const created = await service.create('rt-a', {});

    const handle: ISessionHandle = await service.open(created.ref, {});
    expect(handle.ref).toEqual(created.ref);
    expect(handle.context.descriptor).toEqual(created);

    await handle.close('explicit');
    expect(runtime.sessions.lastCloseReason).toBe('explicit');
    // Closing the session never closes or unregisters the runtime (plan §5.4).
    expect(runtime.closeCalls).toEqual([]);
    expect(registry.get('rt-a')).toBe(runtime);

    const again = await service.resume(created.ref, {});
    expect(again.ref).toEqual(created.ref);
  });

  it('fork stays on the source runtime when targetRuntimeId matches or is absent', async () => {
    const { registry, service } = setup();
    const runtime = new FakeHostRuntime('rt-a');
    registry.register(runtime);
    const source = await service.create('rt-a', {});

    const forked = await service.fork(source.ref, { sessionId: 'fork-1' });
    expect(forked.ref).toEqual({ runtimeId: 'rt-a', sessionId: 'fork-1' });
    expect(runtime.sessions.calls).toContain(`fork:${source.ref.sessionId}`);
  });

  it('cross-runtime fork is refused until the transfer service lands', async () => {
    const { registry, service } = setup();
    registry.register(new FakeHostRuntime('rt-a'));
    registry.register(new FakeHostRuntime('rt-b'));
    const source = await service.create('rt-a', {});

    await expect(service.fork(source.ref, { targetRuntimeId: 'rt-b' })).rejects.toThrow(
      NotImplementedError,
    );
  });

  it('list fans out across online runtimes and keeps full refs', async () => {
    const { registry, service } = setup();
    const a = new FakeHostRuntime('rt-a');
    const b = new FakeHostRuntime('rt-b');
    const offline = new FakeHostRuntime('rt-c', 'offline');
    registry.register(a);
    registry.register(b);
    registry.register(offline);
    await service.create('rt-a', { sessionId: 'a-1' });
    await service.create('rt-b', { sessionId: 'b-1' });

    const page = await service.list();
    expect(page.items.map((descriptor) => sessionRefKey(descriptor.ref)).sort()).toEqual([
      'rt-a:a-1',
      'rt-b:b-1',
    ]);
    expect(offline.sessions.calls).toEqual([]);

    const narrowed = await service.list({ runtimeId: 'rt-b' });
    expect(narrowed.items.map((descriptor) => descriptor.ref.runtimeId)).toEqual(['rt-b']);
    await expect(service.list({ runtimeId: 'rt-c' })).rejects.toMatchObject({
      code: 'session.runtime_unavailable',
    });
  });
});

/* ------------------------------------------------------------------------ */
/* Type-level contract proof (plan §9.1/§9.2, M0 part)                       */
/* ------------------------------------------------------------------------ */

describe('sessionHostRuntime contracts (type level)', () => {
  it('makes runtime.sessions the architectural subject (1:N host)', () => {
    expectTypeOf<ISessionHostRuntime['sessions']>().toEqualTypeOf<ISessionManager>();
    expectTypeOf<ISessionManager>().toHaveProperty('create');
    expectTypeOf<ISessionManager>().toHaveProperty('open');
    expectTypeOf<ISessionManager>().toHaveProperty('resume');
    // The manager speaks runtime-local ids; the service speaks full refs.
    expectTypeOf<ISessionManager['create']>().toBeFunction();
    expectTypeOf<ISessionService['get']>().toBeFunction();
    expectTypeOf<Parameters<ISessionService['get']>[0]>().toEqualTypeOf<SessionRef>();
  });

  it('keeps SessionRef a two-field value object with a string key encoding', () => {
    expectTypeOf<SessionRef>().toEqualTypeOf<{ readonly runtimeId: string; readonly sessionId: string }>();
    expectTypeOf(sessionRefKey).toEqualTypeOf<(ref: SessionRef) => string>();
  });
});
