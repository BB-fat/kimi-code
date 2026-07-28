/**
 * M0 tests for the `sessionHostRuntime` domain (plan §9.1/§9.2, M0-coverable
 * part): SessionRef identity, the host-runtime registry, and the
 * registry-based SessionService routing skeleton — plus the M7 cross-runtime
 * transfer matrix (plan §3.5/§5.8/§9.6) over real Local/memory/remote(f fake)
 * runtimes.
 *
 * The fake runtimes in the first half are test-local stubs proving the 1:N
 * shape (one runtime instance hosts many sessions) — real runtimes land from
 * M1 on.
 */

import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import { ulid } from 'ulid';

import { isErrorCode } from '#/_base/errors/codes';
import { NotImplementedError } from '#/_base/errors/errors';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { ErrorCodes } from '#/errors';
import { CRON_SESSION_TAG, type CronTask } from '#/app/cron/cronTask';
import { LocalWorkspaceRuntime } from '#/app/localWorkspaceRuntime/localWorkspaceRuntime';
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
  SessionTransferService,
  type ISessionTransferService,
} from '#/app/sessionHostRuntime/sessionTransferService';
import {
  toPersistenceNamespace,
  type ISessionArtifactService,
  type ISessionColdReader,
  type ISessionPersistenceContext,
  type ISessionRuntimeContext,
  type SessionCloseReason,
  type SessionDescriptor,
} from '#/app/sessionHostRuntime/sessionRuntimeContext';
import { StandaloneMemoryHostRuntime } from '#/app/standaloneMemoryRuntime/standaloneMemoryHostRuntime';
import { jsonDocumentCodec } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { createWireMetadataRecord } from '#/wire/record';

import { FakeRemoteWorkspaceRuntime } from '../../harness/remoteWorkspaceRuntime';

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

  it('cross-runtime fork fails accurately when the composition has no transfer service', async () => {
    const { registry, service } = setup();
    registry.register(new FakeHostRuntime('rt-a'));
    registry.register(new FakeHostRuntime('rt-b'));
    const source = await service.create('rt-a', {});

    await expect(service.fork(source.ref, { targetRuntimeId: 'rt-b' })).rejects.toMatchObject({
      code: 'session.transfer_failed',
    });
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

/* ------------------------------------------------------------------------ */
/* M7: cross-runtime transfer (plan §3.5/§5.8, matrix §9.6)                  */
/* ------------------------------------------------------------------------ */

const enc = new TextEncoder();
const dec = new TextDecoder();

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function* bytesOf(text: string): AsyncIterable<Uint8Array> {
  yield enc.encode(text);
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

function mergeChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const merged = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** Every file under `dir` as sorted `/`-joined relative paths (ENOENT → []). */
async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string, relBase: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const rel = relBase === '' ? entry.name : `${relBase}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(join(current, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  await walk(dir, '');
  return out.toSorted();
}

/** rel path → file text, for full-tree equality assertions. */
async function treeSnapshot(dir: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  for (const rel of await listFilesRecursive(dir)) {
    snapshot.set(rel, await readFile(join(dir, rel), 'utf8'));
  }
  return snapshot;
}

interface BufferedEntry {
  readonly kind: SessionExportEntry['kind'];
  readonly owner: SessionExportEntry['owner'];
  readonly name: string;
  readonly schemaVersion: number;
  readonly checksum?: string;
  readonly bytes: Uint8Array;
}

async function bufferExport(
  runtime: ISessionHostRuntime,
  sessionId: string,
): Promise<BufferedEntry[]> {
  const out: BufferedEntry[] = [];
  for await (const entry of runtime.sessions.export(sessionId)) {
    out.push({
      kind: entry.kind,
      owner: entry.owner,
      name: entry.name,
      schemaVersion: entry.schemaVersion,
      checksum: entry.checksum,
      bytes: mergeChunks(await collect(entry.content)),
    });
  }
  return out;
}

interface LocalEnv {
  readonly runtime: LocalWorkspaceRuntime;
  readonly homeDir: string;
  readonly cwd: string;
  readonly workspaceId: string;
}

async function makeLocalEnv(tag: string): Promise<LocalEnv> {
  const homeDir = await makeTempDir(`m7-home-${tag}-`);
  const cwd = await makeTempDir(`m7-ws-${tag}-`);
  const workspaceId = encodeWorkDirKey(cwd);
  const runtime = new LocalWorkspaceRuntime({
    runtimeId: `local-${tag}`,
    workspaceId,
    cwd,
    homeDir,
  });
  return { runtime, homeDir, cwd, workspaceId };
}

function sessionDirOf(env: LocalEnv, sessionId: string): string {
  return join(env.homeDir, 'sessions', env.workspaceId, sessionId);
}

/** Populate an existing session of any memory-backed manager through a lease. */
async function populateMemoryLease(
  runtime: ISessionHostRuntime,
  sessionId: string,
  marker: string,
): Promise<void> {
  const lease = await runtime.sessions.open(sessionId, {});
  const sessionNs = lease.persistence.sessionNamespace();
  const agentNs = lease.persistence.agentNamespace('main');
  await lease.persistence
    .documents(sessionNs, jsonDocumentCodec)
    .set(sessionNs, 'state', { marker, turn: 1 });
  const logs = lease.persistence.logs(agentNs, jsonDocumentCodec);
  logs.append(agentNs, 'wire.jsonl', createWireMetadataRecord(1000));
  logs.append(agentNs, 'wire.jsonl', { type: 'wire.test', time: 2000, marker, n: 1 });
  await lease.persistence.blobs(agentNs).put(agentNs, 'blob-1', enc.encode(`blob-${marker}`));
  await lease.artifacts.write(
    { kind: 'agent', agentId: 'main' },
    'report',
    bytesOf(`artifact-${marker}`),
  );
  await lease.flush();
  await lease.close('explicit');
}

async function seedMemorySession(
  runtime: StandaloneMemoryHostRuntime,
  sessionId: string,
  marker: string,
): Promise<void> {
  await runtime.sessions.create({ sessionId, metadata: { title: `memory-${marker}` } });
  await populateMemoryLease(runtime, sessionId, marker);
}

/** Seed a local session's full inventory: wire, blobs, plan, task, artifact, roster, logs. */
async function seedLocalSession(env: LocalEnv, sessionId: string, marker: string): Promise<void> {
  await env.runtime.sessions.create({ sessionId, metadata: { title: `local-${marker}` } });
  const lease = await env.runtime.sessions.open(sessionId, {});
  const agentNs = lease.persistence.agentNamespace('main');
  const logs = lease.persistence.logs(agentNs, jsonDocumentCodec);
  logs.append(agentNs, 'wire.jsonl', createWireMetadataRecord(1000));
  logs.append(agentNs, 'wire.jsonl', { type: 'wire.test', time: 2000, marker, n: 1 });
  await lease.persistence.blobs(agentNs).put(agentNs, 'blobs/blob-1', enc.encode(`blob-${marker}`));
  await lease.persistence
    .blobs(agentNs)
    .put(agentNs, 'plans/plan-1.md', enc.encode(`# plan ${marker}`));
  await lease.persistence
    .documents(agentNs, jsonDocumentCodec)
    .set(agentNs, 'tasks/task-1.json', { id: 'task-1', marker });
  await lease.artifacts.write(
    { kind: 'agent', agentId: 'main' },
    'report',
    bytesOf(`artifact-${marker}`),
  );
  await lease.flush();
  await lease.close('explicit');
  // The agent roster the way AgentLifecycle registers it.
  const statePath = join(sessionDirOf(env, sessionId), 'state.json');
  const meta = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
  meta['agents'] = { main: { type: 'main' } };
  await writeFile(statePath, JSON.stringify(meta));
  await mkdir(join(sessionDirOf(env, sessionId), 'logs'), { recursive: true });
  await writeFile(join(sessionDirOf(env, sessionId), 'logs/kimi-code.log'), `log-${marker}\n`);
}

/** Write a session-tagged cron task into the workspace-level cron scope. */
async function writeCronTask(env: LocalEnv, sessionId: string, prompt: string): Promise<CronTask> {
  const task: CronTask = {
    id: ulid(),
    cron: '0 * * * *',
    prompt,
    createdAt: 1_700_000_000_000,
    recurring: true,
    tags: { [CRON_SESSION_TAG]: sessionId },
  };
  const dir = join(env.homeDir, 'cron', env.workspaceId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${task.id}.json`), JSON.stringify(task));
  return task;
}

/** A runtime wrapper delegating everything but the overridden manager methods. */
function wrappingRuntime(
  id: string,
  delegate: ISessionHostRuntime,
  overrides: Partial<ISessionManager>,
): ISessionHostRuntime {
  const sessions: ISessionManager = {
    create: (input) => delegate.sessions.create(input),
    list: (query) => delegate.sessions.list(query),
    get: (sessionId) => delegate.sessions.get(sessionId),
    update: (sessionId, patch) => delegate.sessions.update(sessionId, patch),
    delete: (sessionId, options) => delegate.sessions.delete(sessionId, options),
    open: (sessionId, options) => delegate.sessions.open(sessionId, options),
    resume: (sessionId, options) => delegate.sessions.resume(sessionId, options),
    fork: (sourceSessionId, input) => delegate.sessions.fork(sourceSessionId, input),
    coldRead: (sessionId) => delegate.sessions.coldRead(sessionId),
    export: (sessionId, options) => delegate.sessions.export(sessionId, options),
    import: (input) => delegate.sessions.import(input),
    revision: delegate.sessions.revision?.bind(delegate.sessions),
    ...overrides,
  };
  return {
    id,
    kind: delegate.kind,
    sessions,
    status: () => delegate.status(),
    capabilities: () => delegate.capabilities(),
    close: (reason) => delegate.close(reason),
  };
}

/** Run `mutate` right after the first streamed entry (inside the export window). */
async function* mutateMidway(
  entries: AsyncIterable<SessionExportEntry>,
  mutate: () => Promise<void>,
): AsyncIterable<SessionExportEntry> {
  let first = true;
  for await (const entry of entries) {
    yield entry;
    if (first) {
      first = false;
      await mutate();
    }
  }
}

describe('SessionTransferService (plan §3.5/§5.8, matrix §9.6)', () => {
  function setupTransfer(): {
    registry: SessionHostRuntimeRegistry;
    transfer: SessionTransferService;
  } {
    const registry = new SessionHostRuntimeRegistry();
    const transfer = new SessionTransferService(registry);
    return { registry, transfer };
  }

  it('Local → memory: the full inventory lands, cron is retained as a blob, the source is kept untouched', async () => {
    const { registry, transfer } = setupTransfer();
    const source = await makeLocalEnv('a');
    const target = new StandaloneMemoryHostRuntime({ id: 'mem-b' });
    registry.register(source.runtime);
    registry.register(target);
    await seedLocalSession(source, 's-1', 'L');
    const cron = await writeCronTask(source, 's-1', 'ping L');
    const sourceTree = await treeSnapshot(source.homeDir);

    const result = await transfer.transfer({
      source: { runtimeId: source.runtime.id, sessionId: 's-1' },
      targetRuntimeId: target.id,
    });

    expect(result.sourceDeleted).toBe(false);
    expect(result.target.runtimeId).toBe(target.id);
    const targetId = result.target.sessionId;
    // Export diagnostics ride the result.
    expect(result.diagnostics.skipped).toEqual([]);
    expect(result.diagnostics.entries['descriptor']).toBe(1);
    expect(result.diagnostics.entries['document']).toBe(1);
    expect(result.diagnostics.entries['records']).toBe(1);
    expect(result.diagnostics.entries['cron']).toBe(1);
    expect(result.diagnostics.entries['blob']).toBeGreaterThan(0);
    expect(result.diagnostics.bytes).toBeGreaterThan(0);

    // Descriptor + logical metadata (cwd included — v1 logical fact).
    const descriptor = await target.sessions.get(targetId);
    expect(descriptor?.metadata).toMatchObject({ title: 'local-L', cwd: source.cwd });
    // Agent wire records.
    const cold = await target.sessions.coldRead(targetId);
    const records = await collect(cold.readRecords({ agentId: 'main', kind: 'wire.test' }));
    expect(records).toHaveLength(1);
    expect(records[0]?.data).toMatchObject({ marker: 'L' });
    // Blobs / plans / tasks / artifact bytes / logs (artifact addressing is a
    // per-runtime convention, so the bytes land as plain blobs here).
    const lease = await target.sessions.open(targetId, {});
    const sessionNs = lease.persistence.sessionNamespace();
    const agentNs = lease.persistence.agentNamespace('main');
    expect(await lease.persistence.blobs(agentNs).get(agentNs, 'blobs/blob-1')).toEqual(
      enc.encode('blob-L'),
    );
    expect(await lease.persistence.blobs(agentNs).get(agentNs, 'plans/plan-1.md')).toEqual(
      enc.encode('# plan L'),
    );
    expect(await lease.persistence.blobs(agentNs).get(agentNs, 'blobs/report')).toEqual(
      enc.encode('artifact-L'),
    );
    // The local runtime streams `tasks/*.json` as byte-passthrough blobs
    // (only `state.json` rides as a document), so the task lands as a blob.
    const taskBytes = await lease.persistence.blobs(agentNs).get(agentNs, 'tasks/task-1.json');
    expect(JSON.parse(dec.decode(taskBytes!))).toEqual({ id: 'task-1', marker: 'L' });
    expect(await lease.persistence.blobs(sessionNs).get(sessionNs, 'logs/kimi-code.log')).toEqual(
      enc.encode('log-L\n'),
    );
    // Cron write-back policy of the headless target: RETENTION as an opaque
    // `cron/<taskId>.json` blob of the session namespace — byte-identical.
    const retained = await lease.persistence
      .blobs(sessionNs)
      .get(sessionNs, `cron/${cron.id}.json`);
    expect(retained).toBeDefined();
    expect(JSON.parse(dec.decode(retained!))).toMatchObject({ id: cron.id, prompt: 'ping L' });
    await lease.close('explicit');

    // The source stays the complete, untouched source of truth (the
    // coordinator's journal lives in memory only — zero markers on disk).
    expect(await source.runtime.sessions.get('s-1')).toBeDefined();
    expect(await treeSnapshot(source.homeDir)).toEqual(sourceTree);
    expect(transfer.journal()).toHaveLength(1);
    expect(transfer.journal()[0]).toMatchObject({
      phase: 'done',
      move: false,
      targetRuntimeId: target.id,
    });
  });

  it('Local → remote (fake): the shared remote backend commits the full inventory', async () => {
    const { registry, transfer } = setupTransfer();
    const source = await makeLocalEnv('a');
    const target = new FakeRemoteWorkspaceRuntime({ workspaceId: 'remote-ws' });
    registry.register(source.runtime);
    registry.register(target);
    await seedLocalSession(source, 's-1', 'R');
    const cron = await writeCronTask(source, 's-1', 'ping R');

    const result = await transfer.transfer({
      source: { runtimeId: source.runtime.id, sessionId: 's-1' },
      targetRuntimeId: target.id,
    });

    expect(result.target.runtimeId).toBe(target.id);
    const targetId = result.target.sessionId;
    const cold = await target.sessions.coldRead(targetId);
    expect(await collect(cold.readRecords({ agentId: 'main', kind: 'wire.test' }))).toHaveLength(1);
    // The fake delegates to the standalone memory manager → cron retention.
    const lease = await target.sessions.open(targetId, {});
    const sessionNs = lease.persistence.sessionNamespace();
    expect(
      await lease.persistence.blobs(sessionNs).get(sessionNs, `cron/${cron.id}.json`),
    ).toBeDefined();
    await lease.close('explicit');
    expect(result.diagnostics.entries['cron']).toBe(1);
  });

  it('memory → Local: the legacy layout is rebuilt and cron re-schedules with a fresh id', async () => {
    const { registry, transfer } = setupTransfer();
    const source = new StandaloneMemoryHostRuntime({ id: 'mem-a' });
    const target = await makeLocalEnv('b');
    registry.register(source);
    registry.register(target.runtime);
    await seedMemorySession(source, 'm-1', 'M');
    // A retained cron blob (the shape a Local → memory transfer produces).
    const cronTask: CronTask = {
      id: ulid(),
      cron: '0 * * * *',
      prompt: 'ping M',
      createdAt: 1_700_000_000_000,
      tags: { [CRON_SESSION_TAG]: 'm-1' },
    };
    {
      const lease = await source.sessions.open('m-1', {});
      const sessionNs = lease.persistence.sessionNamespace();
      await lease.persistence
        .blobs(sessionNs)
        .put(sessionNs, `cron/${cronTask.id}.json`, enc.encode(JSON.stringify(cronTask)));
      await lease.flush();
      await lease.close('explicit');
    }

    const result = await transfer.transfer({
      source: { runtimeId: source.id, sessionId: 'm-1' },
      targetRuntimeId: target.runtime.id,
    });

    const targetId = result.target.sessionId;
    const files = await listFilesRecursive(sessionDirOf(target, targetId));
    expect(files).toContain('state.json');
    expect(files).toContain('state');
    expect(files).toContain('agents/main/wire.jsonl');
    expect(files).toContain('agents/main/blob-1');
    expect(files).toContain('agents/main/artifacts/report');
    const cold = await target.runtime.sessions.coldRead(targetId);
    expect(await collect(cold.readRecords({ agentId: 'main', kind: 'wire.test' }))).toHaveLength(1);
    // The retained cron blob re-exported as a `cron` entry and re-scheduled
    // by the local target: FRESH task id, session tag re-anchored.
    expect(result.diagnostics.entries['cron']).toBe(1);
    const cronDir = join(target.homeDir, 'cron', target.workspaceId);
    const cronFiles = await readdir(cronDir);
    expect(cronFiles).toHaveLength(1);
    expect(cronFiles[0]).not.toBe(`${cronTask.id}.json`);
    const landed = JSON.parse(await readFile(join(cronDir, cronFiles[0]!), 'utf8')) as CronTask;
    expect(landed.id).not.toBe(cronTask.id);
    expect(landed.tags?.[CRON_SESSION_TAG]).toBe(targetId);
    expect(landed).toMatchObject({
      cron: cronTask.cron,
      prompt: 'ping M',
      createdAt: cronTask.createdAt,
    });
  });

  it('remote (fake) → Local: the remote → server data plane, covered through the fake', async () => {
    // The plan's remote → server cell maps onto this combination: the fake
    // remote's "provider backend" IS the standalone memory session manager
    // (the headless server-runtime stand-in), so the logical export/import
    // data plane is the same one a server runtime would drive.
    const { registry, transfer } = setupTransfer();
    const source = new FakeRemoteWorkspaceRuntime({ workspaceId: 'remote-ws' });
    const target = await makeLocalEnv('b');
    registry.register(source);
    registry.register(target.runtime);
    await source.sessions.create({ sessionId: 'r-1', metadata: { title: 'remote-R' } });
    await populateMemoryLease(source, 'r-1', 'S');

    const result = await transfer.transfer({
      source: { runtimeId: source.id, sessionId: 'r-1' },
      targetRuntimeId: target.runtime.id,
    });

    const targetId = result.target.sessionId;
    expect(result.target.runtimeId).toBe(target.runtime.id);
    expect(await listFilesRecursive(sessionDirOf(target, targetId))).toContain(
      'agents/main/wire.jsonl',
    );
    const cold = await target.runtime.sessions.coldRead(targetId);
    const records = await collect(cold.readRecords({ agentId: 'main', kind: 'wire.test' }));
    expect(records).toHaveLength(1);
    expect(records[0]?.data).toMatchObject({ marker: 'S' });
    expect((await target.runtime.sessions.get(targetId))?.metadata).toMatchObject({
      title: 'remote-R',
    });
  });

  it('Local → Local: cron tasks re-schedule into the target workspace scope; unrelated tasks stay behind', async () => {
    const { registry, transfer } = setupTransfer();
    const source = await makeLocalEnv('a');
    const target = await makeLocalEnv('b');
    registry.register(source.runtime);
    registry.register(target.runtime);
    await seedLocalSession(source, 's-1', 'X');
    const cron = await writeCronTask(source, 's-1', 'ping X');
    // A task tagged to a DIFFERENT session never joins the stream.
    await writeCronTask(source, 's-other', 'other session');

    const result = await transfer.transfer({
      source: { runtimeId: source.runtime.id, sessionId: 's-1' },
      targetRuntimeId: target.runtime.id,
    });

    const targetId = result.target.sessionId;
    const cronFiles = await readdir(join(target.homeDir, 'cron', target.workspaceId));
    expect(cronFiles).toHaveLength(1);
    const landed = JSON.parse(
      await readFile(join(target.homeDir, 'cron', target.workspaceId, cronFiles[0]!), 'utf8'),
    ) as CronTask;
    expect(landed.id).not.toBe(cron.id);
    expect(landed.tags?.[CRON_SESSION_TAG]).toBe(targetId);
    expect(landed).toMatchObject({ cron: cron.cron, prompt: 'ping X', recurring: true });
    // Both source tasks are untouched (the transferred one kept its id/tag,
    // the unrelated one never joined the stream).
    const sourceCrons = await readdir(join(source.homeDir, 'cron', source.workspaceId));
    expect(sourceCrons).toHaveLength(2);
    expect(sourceCrons).toContain(`${cron.id}.json`);
    const kept = JSON.parse(
      await readFile(join(source.homeDir, 'cron', source.workspaceId, `${cron.id}.json`), 'utf8'),
    ) as CronTask;
    expect(kept.tags?.[CRON_SESSION_TAG]).toBe('s-1');
  });

  it('aborts with session.transfer_source_changed when the source changes inside the export window', async () => {
    const { registry, transfer } = setupTransfer();
    const source = await makeLocalEnv('a');
    const target = new StandaloneMemoryHostRuntime({ id: 'mem-b' });
    await seedLocalSession(source, 's-1', 'C');
    await writeCronTask(source, 's-1', 'ping C');
    const treeBefore = await treeSnapshot(source.homeDir);
    // Wrap the source: mutate the session directory right after the first
    // streamed entry — inside the export window the coordinator brackets.
    const mutating = wrappingRuntime('mutating-src', source.runtime, {
      export: (sessionId, options) =>
        mutateMidway(source.runtime.sessions.export(sessionId, options), async () => {
          await writeFile(join(sessionDirOf(source, 's-1'), 'midway.txt'), 'changed');
        }),
    });
    registry.register(mutating);
    registry.register(target);

    await expect(
      transfer.transfer({
        source: { runtimeId: 'mutating-src', sessionId: 's-1' },
        targetRuntimeId: target.id,
      }),
    ).rejects.toMatchObject({ code: 'session.transfer_source_changed' });

    // The target never saw a thing.
    expect((await target.sessions.list()).items).toHaveLength(0);
    // The source carries ONLY the mutation itself — the transfer wrote nothing
    // (no markers, no staging, no journal on disk).
    const treeAfter = await treeSnapshot(source.homeDir);
    treeAfter.delete(`sessions/${source.workspaceId}/s-1/midway.txt`);
    expect(treeAfter).toEqual(treeBefore);
    expect(transfer.journal()[0]).toMatchObject({
      phase: 'failed',
      error: 'session.transfer_source_changed',
    });
  });

  it('fails with session.transfer_failed on a corrupted stream: source untouched, no target half-product', async () => {
    const { registry, transfer } = setupTransfer();
    const source = await makeLocalEnv('a');
    const target = await makeLocalEnv('b');
    await seedLocalSession(source, 's-1', 'T');
    const treeBefore = await treeSnapshot(source.homeDir);
    const { fnv1aHex } = await import('#/app/localWorkspaceRuntime/localWorkspaceLayout');
    // A records payload with broken JSONL framing (empty line inside) — the
    // target's staging rejects it before anything commits.
    const tampered = wrappingRuntime('tampered-src', source.runtime, {
      export: (sessionId, options) =>
        (async function* () {
          for await (const entry of source.runtime.sessions.export(sessionId, options)) {
            if (entry.kind !== 'records') {
              yield entry;
              continue;
            }
            const bytes = enc.encode('{"type":"a"}\n\n{"type":"b"}\n');
            yield {
              ...entry,
              checksum: fnv1aHex(bytes),
              content: (async function* () {
                yield bytes;
              })(),
            };
          }
        })(),
    });
    registry.register(tampered);
    registry.register(target.runtime);

    await expect(
      transfer.transfer({
        source: { runtimeId: 'tampered-src', sessionId: 's-1' },
        targetRuntimeId: target.runtime.id,
      }),
    ).rejects.toMatchObject({ code: 'session.transfer_failed' });

    expect((await target.runtime.sessions.list()).items).toHaveLength(0);
    expect(await listFilesRecursive(join(target.homeDir, 'sessions'))).toEqual([]);
    expect(await treeSnapshot(source.homeDir)).toEqual(treeBefore);
  });

  it('cross-runtime fork keeps the source and applies fork identity semantics (Local → memory)', async () => {
    const { registry, transfer } = setupTransfer();
    const source = await makeLocalEnv('a');
    const target = new StandaloneMemoryHostRuntime({ id: 'mem-b' });
    registry.register(source.runtime);
    registry.register(target);
    await seedLocalSession(source, 's-1', 'F');

    const descriptor = await transfer.forkAcrossRuntimes({
      source: { runtimeId: source.runtime.id, sessionId: 's-1' },
      targetRuntimeId: target.id,
    });

    expect(descriptor.ref.runtimeId).toBe(target.id);
    expect(descriptor.status).toBe('active');
    expect(descriptor.metadata).toMatchObject({
      forkedFrom: 's-1',
      title: 'Fork: local-F',
      isCustomTitle: false,
    });
    // The fork carries the data plane and the source stays put.
    const cold = await target.sessions.coldRead(descriptor.ref.sessionId);
    expect(await collect(cold.readRecords({ agentId: 'main', kind: 'wire.test' }))).toHaveLength(1);
    expect(await source.runtime.sessions.get('s-1')).toBeDefined();
    expect(transfer.journal()[0]).toMatchObject({ phase: 'done', move: false });
  });

  it('move deletes the source only after the target validates, and the target stays fully usable', async () => {
    const { registry, transfer } = setupTransfer();
    const source = await makeLocalEnv('a');
    const target = new StandaloneMemoryHostRuntime({ id: 'mem-b' });
    registry.register(source.runtime);
    registry.register(target);
    await seedLocalSession(source, 's-1', 'V');

    const result = await transfer.transfer({
      source: { runtimeId: source.runtime.id, sessionId: 's-1' },
      targetRuntimeId: target.id,
      deleteSource: true,
    });

    expect(result.sourceDeleted).toBe(true);
    // The source is gone: descriptor unreadable, directory removed.
    expect(await source.runtime.sessions.get('s-1')).toBeUndefined();
    expect(await listFilesRecursive(sessionDirOf(source, 's-1'))).toEqual([]);
    // The target is complete and cold-readable.
    const cold = await target.sessions.coldRead(result.target.sessionId);
    expect(await collect(cold.readRecords({ agentId: 'main', kind: 'wire.test' }))).toHaveLength(1);
    expect(transfer.journal()[0]).toMatchObject({ phase: 'done', move: true });
  });

  it('keeps the source when target verification fails during a move', async () => {
    const { registry, transfer } = setupTransfer();
    const source = new StandaloneMemoryHostRuntime({ id: 'mem-a' });
    const realTarget = new StandaloneMemoryHostRuntime({ id: 'mem-b' });
    await seedMemorySession(source, 's-1', 'W');
    // The target commits the import but hides the session from `get`, so the
    // post-commit verification (and therefore the move) must fail.
    const hiding = wrappingRuntime('hiding-target', realTarget, {
      get: () => Promise.resolve(undefined),
    });
    registry.register(source);
    registry.register(hiding);

    await expect(
      transfer.transfer({
        source: { runtimeId: source.id, sessionId: 's-1' },
        targetRuntimeId: 'hiding-target',
        deleteSource: true,
      }),
    ).rejects.toMatchObject({ code: 'session.transfer_failed' });

    // The source was NOT deleted; the committed target copy is left for the
    // caller to keep or clean up explicitly.
    expect(await source.sessions.get('s-1')).toBeDefined();
    expect((await realTarget.sessions.list()).items).toHaveLength(1);
    expect(transfer.journal()[0]).toMatchObject({
      phase: 'failed',
      error: 'session.transfer_failed',
      move: true,
    });
  });

  it('keeps both sides when the source delete fails after a validated move', async () => {
    const { registry, transfer } = setupTransfer();
    const source = new StandaloneMemoryHostRuntime({ id: 'mem-a' });
    const target = new StandaloneMemoryHostRuntime({ id: 'mem-b' });
    await seedMemorySession(source, 's-1', 'D');
    // The target commits and verifies fine; the source's own delete fails.
    const failing = wrappingRuntime('failing-src', source, {
      delete: () => Promise.reject(new Error('delete exploded')),
    });
    registry.register(failing);
    registry.register(target);

    await expect(
      transfer.transfer({
        source: { runtimeId: 'failing-src', sessionId: 's-1' },
        targetRuntimeId: target.id,
        deleteSource: true,
      }),
    ).rejects.toMatchObject({
      code: 'session.transfer_failed',
      message: expect.stringContaining('complete and retained') as unknown as string,
    });

    // The target copy is complete and fully usable (it was committed AND
    // verified before the delete was attempted).
    const listed = (await target.sessions.list()).items;
    expect(listed).toHaveLength(1);
    const cold = await target.sessions.coldRead(listed[0]!.ref.sessionId);
    expect(await collect(cold.readRecords({ agentId: 'main', kind: 'wire.test' }))).toHaveLength(1);
    // The source was NOT deleted.
    expect(await source.sessions.get('s-1')).toBeDefined();
    expect(transfer.journal()[0]).toMatchObject({
      phase: 'failed',
      error: 'session.transfer_failed',
      move: true,
    });
  });

  it('the stream carries no workspace DTOs, wd_id segments or physical paths', async () => {
    const env = await makeLocalEnv('a');
    await seedLocalSession(env, 's-1', 'H');
    await writeCronTask(env, 's-1', 'ping H');

    const entries = await bufferExport(env.runtime, 's-1');
    expect(entries.map((entry) => entry.kind)).toContain('cron');
    for (const entry of entries) {
      // Entry names are stable logical names: no host root, no wd_id bucket,
      // no workspace path, no runtime id.
      expect(entry.name).not.toContain(env.homeDir);
      expect(entry.name).not.toContain(env.workspaceId);
      expect(entry.name).not.toContain(env.cwd);
      expect(entry.name).not.toContain(env.runtime.id);
      expect(entry.name.startsWith('/')).toBe(false);
      // Owners are logical (session/agent) — never a Workspace DTO.
      expect(['session', 'agent']).toContain(entry.owner.kind);
    }
    // cwd rides the descriptor/state document as v1 LOGICAL metadata (the M7
    // adjudication: data, never a routing basis) — but no host root and no
    // wd_id leak anywhere in the payloads.
    const descriptor = dec.decode(entries.find((entry) => entry.kind === 'descriptor')!.bytes);
    expect(descriptor).toContain(env.cwd);
    expect(descriptor).not.toContain(env.homeDir);
    expect(descriptor).not.toContain(env.workspaceId);
    const stateDoc = dec.decode(
      entries.find((entry) => entry.kind === 'document' && entry.name === 'state.json')!.bytes,
    );
    expect(stateDoc).not.toContain(env.homeDir);
    expect(stateDoc).not.toContain(env.workspaceId);
  });

  it('ISessionService.fork routes same-runtime to runtime.sessions.fork and cross-runtime to the transfer service', async () => {
    const registry = new SessionHostRuntimeRegistry();
    const transfer: ISessionTransferService = new SessionTransferService(registry);
    const service = new SessionService(registry, transfer);
    const a = new StandaloneMemoryHostRuntime({ id: 'rt-a' });
    const b = new StandaloneMemoryHostRuntime({ id: 'rt-b' });
    registry.register(a);
    registry.register(b);
    const source = await service.create('rt-a', { sessionId: 's-1', metadata: { title: 'route' } });
    await populateMemoryLease(a, 's-1', 'Z');

    // Same runtime: the manager's own fork path (no export/import involved).
    // The catalog metadata rewrite is the SAME one the cross-runtime fork
    // applies through `forkFrom` (plan §5.8): `Fork:` title, goal dropped.
    const sameFork = await service.fork(source.ref, {});
    expect(sameFork.ref.runtimeId).toBe('rt-a');
    expect(sameFork.metadata).toMatchObject({ forkedFrom: 's-1', title: 'Fork: route' });

    // Cross runtime: the transfer service's data plane with fork semantics.
    const crossFork = await service.fork(source.ref, { targetRuntimeId: 'rt-b' });
    expect(crossFork.ref.runtimeId).toBe('rt-b');
    expect(crossFork.metadata).toMatchObject({ forkedFrom: 's-1', title: 'Fork: route' });
    const cold = await b.sessions.coldRead(crossFork.ref.sessionId);
    expect(await collect(cold.readRecords({ agentId: 'main', kind: 'wire.test' }))).toHaveLength(1);

    // Both forks keep the source.
    expect(await service.get(source.ref)).toBeDefined();
  });
});
