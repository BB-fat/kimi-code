/**
 * M1 tests for `StandaloneMemoryHostRuntime` (plan §4.5) — the headless
 * in-memory multi-session host runtime — plus the real-runtime routing proof
 * of the M0 `SessionService` skeleton (plan §3.4).
 *
 * Covers the M1-coverable part of the plan §9.1 contract matrix, §9.2
 * identity/isolation and §9.3 lifecycle: one runtime creating/hosting many
 * sessions, namespace/artifact/lock isolation, child-lease open/resume/
 * flush/close semantics, same-runtime fork, cold read, logical export/import,
 * and runtime-vs-lease close ordering.
 * Run with `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/app/standaloneMemoryRuntime/standaloneMemoryHostRuntime.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { SessionHostRuntimeRegistry } from '#/app/sessionHostRuntime/sessionHostRuntimeRegistry';
import { SessionService, type ISessionService } from '#/app/sessionHostRuntime/sessionService';
import type { SessionExportEntry } from '#/app/sessionHostRuntime/sessionManager';
import { sessionRefKey, type SessionRef } from '#/app/sessionHostRuntime/sessionRef';
import {
  toPersistenceNamespace,
  type ArtifactRef,
  type ISessionRuntimeContext,
} from '#/app/sessionHostRuntime/sessionRuntimeContext';
import { StandaloneMemoryHostRuntime } from '#/app/standaloneMemoryRuntime/standaloneMemoryHostRuntime';
import { jsonDocumentCodec } from '#/persistence/backends/node-fs/atomicDocumentStore';
import type { DocumentCodec } from '#/persistence/interface/atomicDocumentStore';

const enc = new TextEncoder();
const dec = new TextDecoder();

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

async function* bytesOf(text: string): AsyncIterable<Uint8Array> {
  yield enc.encode(text);
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

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) chunks.push(value);
  }
  return mergeChunks(chunks);
}

async function streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return dec.decode(await streamToBytes(stream));
}

async function iterableToText(iterable: AsyncIterable<Uint8Array>): Promise<string> {
  return dec.decode(mergeChunks(await collect(iterable)));
}

/** Seed a session through a real lease: one document, two log records, one blob, one artifact. */
async function seedSession(
  runtime: StandaloneMemoryHostRuntime,
  sessionId: string,
  marker: string,
): Promise<ArtifactRef> {
  const lease = await runtime.sessions.open(sessionId, {});
  const sessionNs = lease.persistence.sessionNamespace();
  const agentNs = lease.persistence.agentNamespace('main');
  await lease.persistence
    .documents(sessionNs, jsonDocumentCodec)
    .set(sessionNs, 'state', { marker, turn: 1 });
  const logs = lease.persistence.logs(agentNs, jsonDocumentCodec);
  logs.append(agentNs, 'wire.jsonl', { type: 'wire.test', time: 1000, marker, n: 1 });
  logs.append(agentNs, 'wire.jsonl', { type: 'wire.other', time: 2000, marker, n: 2 });
  await lease.persistence.blobs(agentNs).put(agentNs, 'blob-1', enc.encode(`blob-${marker}`));
  const artifact = await lease.artifacts.write(
    { kind: 'agent', agentId: 'main' },
    'report',
    bytesOf(`artifact-${marker}`),
  );
  await lease.flush();
  await lease.close('explicit');
  return artifact;
}

describe('StandaloneMemoryHostRuntime identity & runtime lifecycle', () => {
  it('has a stable id, the standalone-memory kind and a headless capability set', () => {
    const minted = new StandaloneMemoryHostRuntime();
    expect(minted.id).toMatch(/^standalone-memory_/);
    expect(minted.kind).toBe('standalone-memory');
    const caps = [...minted.capabilities()].toSorted();
    expect(caps).toEqual([
      'artifact.model_read',
      'session.cold_read',
      'session.export',
      'session.fork',
      'session.import',
    ]);
    expect(caps.some((cap) => cap.startsWith('os.'))).toBe(false);
    expect(minted.status()).toBe('online');

    const named = new StandaloneMemoryHostRuntime({ id: 'rt-x' });
    expect(named.id).toBe('rt-x');
  });

  it('close flips the runtime offline and every manager call fails with session.runtime_unavailable', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-x' });
    const created = await runtime.sessions.create({});
    const lease = await runtime.sessions.open(created.ref.sessionId, {});

    await runtime.close('shutdown');
    await runtime.close('shutdown'); // idempotent
    expect(runtime.status()).toBe('offline');
    // The live lease was lost with the runtime.
    expect(lease.closedLease).toBe(true);

    const unavailable = { code: 'session.runtime_unavailable' };
    await expect(runtime.sessions.create({})).rejects.toMatchObject(unavailable);
    await expect(runtime.sessions.list()).rejects.toMatchObject(unavailable);
    await expect(runtime.sessions.get(created.ref.sessionId)).rejects.toMatchObject(unavailable);
    await expect(runtime.sessions.update(created.ref.sessionId, {})).rejects.toMatchObject(
      unavailable,
    );
    await expect(runtime.sessions.delete(created.ref.sessionId)).rejects.toMatchObject(unavailable);
    await expect(runtime.sessions.open(created.ref.sessionId, {})).rejects.toMatchObject(
      unavailable,
    );
    await expect(runtime.sessions.resume(created.ref.sessionId, {})).rejects.toMatchObject(
      unavailable,
    );
    await expect(runtime.sessions.fork(created.ref.sessionId, {})).rejects.toMatchObject(
      unavailable,
    );
    await expect(runtime.sessions.coldRead(created.ref.sessionId)).rejects.toMatchObject(
      unavailable,
    );
    await expect(
      runtime.sessions.import({ entries: runtime.sessions.export(created.ref.sessionId) }),
    ).rejects.toMatchObject(unavailable);
    await expect(collect(runtime.sessions.export(created.ref.sessionId))).rejects.toMatchObject(
      unavailable,
    );
  });

  it('stays registered (offline) so refs fail accurately instead of disappearing', async () => {
    const registry = new SessionHostRuntimeRegistry();
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-x' });
    registry.register(runtime);
    await runtime.close('evicted');

    expect(registry.list().map((summary) => summary.status)).toEqual(['offline']);
    expect(() => registry.require('rt-x')).toThrowError(
      expect.objectContaining({ code: 'session.runtime_unavailable' }) as Error,
    );
  });
});

describe('session CRUD (plan §9.1)', () => {
  it('create is repeatable and concurrent: many sessions share runtimeId with unique minted ids', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-x' });
    const sequential = [await runtime.sessions.create({}), await runtime.sessions.create({})];
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () => runtime.sessions.create({})),
    );
    const all = [...sequential, ...concurrent];
    expect(new Set(all.map((d) => d.ref.runtimeId))).toEqual(new Set(['rt-x']));
    expect(new Set(all.map((d) => d.ref.sessionId)).size).toBe(all.length);
    for (const descriptor of all) {
      expect(descriptor.ref.sessionId).toMatch(/^session_/);
      expect(descriptor.status).toBe('active');
      expect(descriptor.revision).toBe('1');
      expect(Date.parse(descriptor.createdAt)).not.toBeNaN();
    }
    expect((await runtime.sessions.list()).items).toHaveLength(all.length);
  });

  it('honors caller-proposed ids and rejects duplicates and invalid ids', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-x' });
    await runtime.sessions.create({ sessionId: 'mine' });
    await expect(runtime.sessions.create({ sessionId: 'mine' })).rejects.toMatchObject({
      code: 'session.already_exists',
    });
    // Separators, whitespace and control characters are all rejected: ids land
    // inside namespaces, cache keys and log-id framing.
    const invalid = ['', 'a/b', 'a\\b', '.', '..', 'a b', 'a\nb', 'a\tb', ' lead', 'trail ', 'a\u0007b'];
    for (const bad of invalid) {
      await expect(runtime.sessions.create({ sessionId: bad }), bad).rejects.toMatchObject({
        code: 'session.id_invalid',
      });
    }
  });

  it('get/update/delete round-trip with optimistic revisions and status filters', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-x' });
    const a = await runtime.sessions.create({ metadata: { title: 'one' } });
    await runtime.sessions.create({});

    expect(await runtime.sessions.get(a.ref.sessionId)).toMatchObject({
      metadata: { title: 'one' },
    });
    expect(await runtime.sessions.get('missing')).toBeUndefined();
    await expect(runtime.sessions.update('missing', {})).rejects.toMatchObject({
      code: 'session.not_found',
    });

    const updated = await runtime.sessions.update(a.ref.sessionId, {
      metadata: { title: 'two' },
      status: 'archived',
      revision: '1',
    });
    expect(updated.metadata).toMatchObject({ title: 'two' });
    expect(updated.status).toBe('archived');
    expect(updated.revision).toBe('2');
    // Stale optimistic revision is rejected.
    await expect(
      runtime.sessions.update(a.ref.sessionId, { metadata: {}, revision: '1' }),
    ).rejects.toMatchObject({ code: 'validation.failed' });

    expect((await runtime.sessions.list({ status: 'active' })).items).toHaveLength(1);
    expect((await runtime.sessions.list({ status: 'archived' })).items).toHaveLength(1);

    await runtime.sessions.delete(a.ref.sessionId);
    expect(await runtime.sessions.get(a.ref.sessionId)).toBeUndefined();
    await expect(runtime.sessions.delete(a.ref.sessionId)).rejects.toMatchObject({
      code: 'session.not_found',
    });
  });

  it('pages list with an opaque cursor and a limit', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-x' });
    await runtime.sessions.create({ sessionId: 's-1' });
    await runtime.sessions.create({ sessionId: 's-2' });
    await runtime.sessions.create({ sessionId: 's-3' });

    const first = await runtime.sessions.list({ limit: 2 });
    expect(first.items.map((d) => d.ref.sessionId)).toEqual(['s-1', 's-2']);
    expect(first.cursor).toBeDefined();
    const rest = await runtime.sessions.list({ limit: 2, cursor: first.cursor });
    expect(rest.items.map((d) => d.ref.sessionId)).toEqual(['s-3']);
    expect(rest.cursor).toBeUndefined();
  });
});

describe('open/resume child lease (plan §3.3)', () => {
  it('open returns the complete context bundle in one shot', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-x' });
    const created = await runtime.sessions.create({ metadata: { title: 'leased' } });

    const lease: ISessionRuntimeContext = await runtime.sessions.open(created.ref.sessionId, {});
    expect(lease.ref).toEqual(created.ref);
    expect(lease.descriptor).toEqual(created);
    expect(lease.persistence).toBeDefined();
    expect(lease.artifacts).toBeDefined();
    expect(lease.coldReader).toBeDefined();
    expect([...lease.capabilities].toSorted()).toEqual([...runtime.capabilities()].toSorted());
    expect(lease.contributions).toEqual({ sessionServices: [], agentServices: [], tools: [] });
    expect(lease.os).toBeUndefined();
    await lease.close('explicit');
  });

  it('fails open/resume with session.not_found for unknown sessions', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-x' });
    await expect(runtime.sessions.open('missing', {})).rejects.toMatchObject({
      code: 'session.not_found',
    });
    await expect(runtime.sessions.resume('missing', {})).rejects.toMatchObject({
      code: 'session.not_found',
    });
  });

  it('serializes writers: a second open/resume (even concurrent) conflicts, close releases', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-x' });
    const created = await runtime.sessions.create({});
    const id = created.ref.sessionId;

    const lease = await runtime.sessions.open(id, {});
    await expect(runtime.sessions.open(id, {})).rejects.toMatchObject({
      code: 'session.lease_conflict',
    });
    await expect(runtime.sessions.resume(id, {})).rejects.toMatchObject({
      code: 'session.lease_conflict',
    });
    await lease.close('explicit');
    await lease.close('explicit'); // idempotent

    // Concurrent re-open races resolve to exactly one winner.
    const [first, second] = await Promise.allSettled([
      runtime.sessions.open(id, {}),
      runtime.sessions.open(id, {}),
    ]);
    const outcomes = [first.status, second.status].toSorted();
    expect(outcomes).toEqual(['fulfilled', 'rejected']);
    const rejected = first.status === 'rejected' ? first : (second as PromiseRejectedResult);
    expect(rejected.reason).toMatchObject({ code: 'session.lease_conflict' });
    const winner = first.status === 'fulfilled' ? first.value : (second as PromiseFulfilledResult<ISessionRuntimeContext>).value;
    await winner.close('explicit');
  });

  it('resume enforces expectedRevision when provided', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-x' });
    const created = await runtime.sessions.create({});
    const id = created.ref.sessionId;

    const lease = await runtime.sessions.resume(id, { expectedRevision: '1' });
    await lease.close('explicit');
    await expect(runtime.sessions.resume(id, { expectedRevision: '99' })).rejects.toMatchObject({
      code: 'validation.failed',
    });
  });
});

describe('lease persistence, namespace and lock isolation (plan §9.1/§9.2)', () => {
  it('serves documents/logs/blobs per namespace and keeps agents isolated', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-x' });
    const created = await runtime.sessions.create({});
    const lease = await runtime.sessions.open(created.ref.sessionId, {});

    const sessionNs = lease.persistence.sessionNamespace();
    const mainNs = lease.persistence.agentNamespace('main');
    const sideNs = lease.persistence.agentNamespace('side');
    expect(sessionNs).not.toBe(mainNs);
    expect(mainNs).not.toBe(sideNs);

    await lease.persistence.documents(sessionNs, jsonDocumentCodec).set(sessionNs, 'state', {
      who: 'session',
    });
    await lease.persistence.documents(mainNs, jsonDocumentCodec).set(mainNs, 'state', {
      who: 'main',
    });
    expect(await lease.persistence.documents(sessionNs, jsonDocumentCodec).get(sessionNs, 'state'))
      .toEqual({ who: 'session' });
    expect(await lease.persistence.documents(mainNs, jsonDocumentCodec).get(mainNs, 'state'))
      .toEqual({ who: 'main' });
    expect(await lease.persistence.documents(sideNs, jsonDocumentCodec).get(sideNs, 'state'))
      .toBeUndefined();

    const mainLogs = lease.persistence.logs(mainNs, jsonDocumentCodec);
    mainLogs.append(mainNs, 'wire.jsonl', { type: 'wire.test', time: 1, agent: 'main' });
    await lease.flush();
    const sideRecords = await collect(lease.persistence.logs(sideNs, jsonDocumentCodec).read(sideNs, 'wire.jsonl'));
    expect(sideRecords).toEqual([]);

    await lease.persistence.blobs(mainNs).put(mainNs, 'b', enc.encode('main-blob'));
    expect(await lease.persistence.blobs(sideNs).get(sideNs, 'b')).toBeUndefined();
    expect(await lease.persistence.blobs(mainNs).get(mainNs, 'b')).toEqual(enc.encode('main-blob'));
    await lease.close('explicit');
  });

  it('rejects namespace tokens the lease did not mint', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-x' });
    const created = await runtime.sessions.create({});
    const lease = await runtime.sessions.open(created.ref.sessionId, {});
    const foreign = toPersistenceNamespace('session/somebody-else');

    expect(() => lease.persistence.documents(foreign, jsonDocumentCodec)).toThrowError(
      expect.objectContaining({ code: 'validation.failed' }) as Error,
    );
    expect(() => lease.persistence.logs(foreign, jsonDocumentCodec)).toThrowError(
      expect.objectContaining({ code: 'validation.failed' }) as Error,
    );
    expect(() => lease.persistence.blobs(foreign)).toThrowError(
      expect.objectContaining({ code: 'validation.failed' }) as Error,
    );
    await lease.close('explicit');
  });

  it('rejects agent ids with separators, whitespace or control characters', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-x' });
    const created = await runtime.sessions.create({});
    const lease = await runtime.sessions.open(created.ref.sessionId, {});

    const invalid = ['', 'a/b', 'a\\b', '.', '..', 'a b', 'a\nb'];
    for (const bad of invalid) {
      expect(() => lease.persistence.agentNamespace(bad), bad).toThrowError(
        expect.objectContaining({ code: 'validation.failed' }) as Error,
      );
      await expect(
        lease.artifacts.write({ kind: 'agent', agentId: bad }, 'x', bytesOf('x')),
        bad,
      ).rejects.toMatchObject({ code: 'validation.failed' });
    }
    // Valid ids keep working after the rejections.
    lease.persistence.agentNamespace('main');
    await lease.close('explicit');
  });

  it('keeps sessions isolated: namespaces, artifacts and locks do not bleed across A/B', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-x' });
    const a = await runtime.sessions.create({ metadata: { marker: 'a' } });
    const b = await runtime.sessions.create({ metadata: { marker: 'b' } });

    // Both sessions hold a live lease at once: shared runtime, isolated state.
    const leaseA = await runtime.sessions.open(a.ref.sessionId, {});
    const leaseB = await runtime.sessions.open(b.ref.sessionId, {});
    expect(leaseA.ref.runtimeId).toBe('rt-x');
    expect(leaseB.ref.runtimeId).toBe('rt-x');

    const nsA = leaseA.persistence.sessionNamespace();
    const nsB = leaseB.persistence.sessionNamespace();
    await leaseA.persistence.documents(nsA, jsonDocumentCodec).set(nsA, 'state', { marker: 'a' });
    await leaseB.persistence.documents(nsB, jsonDocumentCodec).set(nsB, 'state', { marker: 'b' });
    expect(await leaseA.persistence.documents(nsA, jsonDocumentCodec).get(nsA, 'state')).toEqual({
      marker: 'a',
    });
    expect(await leaseB.persistence.documents(nsB, jsonDocumentCodec).get(nsB, 'state')).toEqual({
      marker: 'b',
    });

    // Locks are per session: closing A releases only A's.
    await leaseA.close('explicit');
    await runtime.sessions.open(a.ref.sessionId, {}).then((reopened) => reopened.close('explicit'));
    await expect(runtime.sessions.open(b.ref.sessionId, {})).rejects.toMatchObject({
      code: 'session.lease_conflict',
    });
    await leaseB.close('explicit');
  });
});

describe('lifecycle: closing sessions never closes the runtime (plan §5.4/§9.3)', () => {
  it('closing A keeps B running and the runtime creatable; closing the last session keeps it too', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-x' });
    const registry = new SessionHostRuntimeRegistry();
    registry.register(runtime);

    const a = await runtime.sessions.create({});
    const b = await runtime.sessions.create({});
    const artifactA = await seedSession(runtime, a.ref.sessionId, 'A');
    const leaseB = await runtime.sessions.open(b.ref.sessionId, {});

    // Close A entirely; B keeps running, the runtime stays online.
    const leaseA = await runtime.sessions.open(a.ref.sessionId, {});
    await leaseA.close('explicit');
    const nsB = leaseB.persistence.sessionNamespace();
    await leaseB.persistence.documents(nsB, jsonDocumentCodec).set(nsB, 'state', { alive: true });
    await leaseB.flush();
    await leaseB.close('explicit');
    const resumedB = await runtime.sessions.resume(b.ref.sessionId, {});
    expect(
      await resumedB.persistence.documents(nsB, jsonDocumentCodec).get(nsB, 'state'),
    ).toEqual({ alive: true });
    await resumedB.close('explicit');

    expect(runtime.status()).toBe('online');
    const c = await runtime.sessions.create({});
    expect(c.ref.runtimeId).toBe('rt-x');

    // Closing the LAST session still does not close or unregister the runtime.
    await runtime.sessions.delete(c.ref.sessionId);
    await runtime.sessions.delete(b.ref.sessionId);
    const lastLease = await runtime.sessions.open(a.ref.sessionId, {});
    await lastLease.close('explicit');
    expect(runtime.status()).toBe('online');
    expect(registry.get('rt-x')).toBe(runtime);
    // A's data survived the whole dance.
    const coldA = await runtime.sessions.coldRead(a.ref.sessionId);
    expect(await streamToText(await coldA.readArtifact(artifactA))).toBe('artifact-A');
  });

  it('delete refuses a live lease unless forced; force closes it and purges the data', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-x' });
    const created = await runtime.sessions.create({});
    await seedSession(runtime, created.ref.sessionId, 'X');
    const lease = await runtime.sessions.open(created.ref.sessionId, {});

    await expect(runtime.sessions.delete(created.ref.sessionId)).rejects.toMatchObject({
      code: 'session.lease_conflict',
    });
    await runtime.sessions.delete(created.ref.sessionId, { force: true });
    expect(lease.closedLease).toBe(true);
    expect(await runtime.sessions.get(created.ref.sessionId)).toBeUndefined();
    await expect(runtime.sessions.coldRead(created.ref.sessionId)).rejects.toMatchObject({
      code: 'session.not_found',
    });
    // The runtime itself is untouched and immediately reusable.
    const next = await runtime.sessions.create({});
    expect(next.ref.sessionId).not.toBe(created.ref.sessionId);
  });

  it('keeps the lease live when close fails on flush, and releases it after rewrite recovery (plan §9.3)', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-x' });
    const created = await runtime.sessions.create({});
    const lease = await runtime.sessions.open(created.ref.sessionId, {});
    const ns = lease.persistence.sessionNamespace();

    let encodingDown = true;
    const flakyCodec: DocumentCodec = {
      format: 'flaky-lease',
      encode: (value) => {
        if (encodingDown) throw new Error('encoding down');
        return jsonDocumentCodec.encode(value);
      },
      decode: jsonDocumentCodec.decode,
    };
    const logs = lease.persistence.logs(ns, flakyCodec);
    logs.append(ns, 'session.log', { type: 'wire.test', time: 1, n: 1 });

    // Flush fails, so close fails too — and the lease stays live.
    await expect(lease.flush()).rejects.toThrow('encoding down');
    await expect(lease.close('explicit')).rejects.toThrow('encoding down');
    expect(lease.closedLease).toBe(false);
    await expect(runtime.sessions.open(created.ref.sessionId, {})).rejects.toMatchObject({
      code: 'session.lease_conflict',
    });
    await expect(runtime.sessions.resume(created.ref.sessionId, {})).rejects.toMatchObject({
      code: 'session.lease_conflict',
    });

    // A valid rewrite is the recovery boundary that clears the sticky failure;
    // the retried close then flushes the pending record and releases the lease.
    encodingDown = false;
    await logs.rewrite(ns, 'session.log', []);
    await lease.close('explicit');
    expect(lease.closedLease).toBe(true);

    const reopened = await runtime.sessions.open(created.ref.sessionId, {});
    await reopened.close('explicit');
    const cold = await runtime.sessions.coldRead(created.ref.sessionId);
    expect(await collect(cold.readRecords({}))).toHaveLength(1);
  });
});

describe('artifacts (plan §3.6/§9.7)', () => {
  it('write returns a routable ArtifactRef with a monotonically bumped version', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-x' });
    const created = await runtime.sessions.create({});
    const lease = await runtime.sessions.open(created.ref.sessionId, {});

    const first = await lease.artifacts.write(
      { kind: 'session' },
      'notes',
      bytesOf('v1-bytes'),
    );
    expect(first).toMatchObject({
      runtimeId: 'rt-x',
      sessionId: created.ref.sessionId,
      owner: { kind: 'session' },
      artifactId: 'notes',
      version: '1',
    });
    const second = await lease.artifacts.write({ kind: 'session' }, 'notes', bytesOf('v2'));
    expect(second.version).toBe('2');
    expect(await streamToText(await lease.artifacts.read(first))).toBe('v2');

    const ranged = await lease.artifacts.read(first, { range: { start: 0, end: 2 } });
    expect(await streamToText(ranged)).toBe('v2'.slice(0, 2));
    await lease.close('explicit');
  });

  it('hands out detached byte copies on both write and read', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-x' });
    const created = await runtime.sessions.create({});
    const lease = await runtime.sessions.open(created.ref.sessionId, {});

    const source = enc.encode('artifact-bytes');
    async function* sourceStream() {
      yield source;
    }
    const ref = await lease.artifacts.write({ kind: 'session' }, 'bin', sourceStream());
    // Mutating the caller's buffer after the write must not touch storage.
    source.fill(0);
    expect(await streamToBytes(await lease.artifacts.read(ref))).toEqual(
      enc.encode('artifact-bytes'),
    );
    // Mutating a returned buffer must not touch storage either.
    const read = await streamToBytes(await lease.artifacts.read(ref));
    read.fill(0);
    expect(await streamToBytes(await lease.artifacts.read(ref))).toEqual(
      enc.encode('artifact-bytes'),
    );
    await lease.close('explicit');
  });

  it('validates runtime, session AND owner on every read', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-x' });
    const other = new StandaloneMemoryHostRuntime({ id: 'rt-y' });
    const a = await runtime.sessions.create({});
    const b = await runtime.sessions.create({});
    const artifact = await seedSession(runtime, a.ref.sessionId, 'A');

    const leaseB = await runtime.sessions.open(b.ref.sessionId, {});
    const mismatch = { code: 'artifact.owner_mismatch' };
    // Cross-session through the same runtime.
    await expect(leaseB.artifacts.read(artifact)).rejects.toMatchObject(mismatch);
    // Cross-runtime through another runtime's lease.
    const foreignLease = await other.sessions.open((await other.sessions.create({})).ref.sessionId, {});
    await expect(foreignLease.artifacts.read(artifact)).rejects.toMatchObject(mismatch);
    // Wrong owner within the right session (artifact belongs to agent 'main').
    const coldA = await runtime.sessions.coldRead(a.ref.sessionId);
    await expect(coldA.readArtifact({ ...artifact, owner: { kind: 'session' } })).rejects.toMatchObject(mismatch);
    await expect(
      coldA.readArtifact({ ...artifact, owner: { kind: 'agent', agentId: 'side' } }),
    ).rejects.toMatchObject(mismatch);
    // Unknown artifact id.
    await expect(coldA.readArtifact({ ...artifact, artifactId: 'nope' })).rejects.toMatchObject(
      mismatch,
    );
    // The right coordinates still work.
    expect(await streamToText(await coldA.readArtifact(artifact))).toBe('artifact-A');

    await leaseB.close('explicit');
    await foreignLease.close('explicit');
  });
});

describe('cold read (plan §3.6)', () => {
  it('reads descriptor, agents, records and artifacts without a live lease', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-x' });
    const created = await runtime.sessions.create({ metadata: { title: 'cold' } });
    const artifact = await seedSession(runtime, created.ref.sessionId, 'C');

    const cold = await runtime.sessions.coldRead(created.ref.sessionId);
    expect(await cold.descriptor()).toMatchObject({ metadata: { title: 'cold' } });
    expect(await cold.listAgents()).toEqual([{ agentId: 'main', metadata: {} }]);

    const agentRecords = await collect(cold.readRecords({ agentId: 'main' }));
    expect(agentRecords).toHaveLength(2);
    expect(agentRecords[0]).toMatchObject({
      kind: 'wire.test',
      timestamp: new Date(1000).toISOString(),
      data: { marker: 'C', n: 1 },
    });
    // Session-level records are separate from agent records.
    expect(await collect(cold.readRecords({}))).toEqual([]);
    // Kind filter + limit.
    const filtered = await collect(cold.readRecords({ agentId: 'main', kind: 'wire.other', limit: 1 }));
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.kind).toBe('wire.other');
    const limited = await collect(cold.readRecords({ agentId: 'main', limit: 1 }));
    expect(limited).toHaveLength(1);

    expect(await streamToText(await cold.readArtifact(artifact))).toBe('artifact-C');
  });

  it('observes lease writes after flush (same-or-higher revision visibility)', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-x' });
    const created = await runtime.sessions.create({});
    // The cold reader is obtained BEFORE the writes land.
    const cold = await runtime.sessions.coldRead(created.ref.sessionId);
    const lease = await runtime.sessions.open(created.ref.sessionId, {});
    const ns = lease.persistence.agentNamespace('main');
    const logs = lease.persistence.logs(ns, jsonDocumentCodec);
    logs.append(ns, 'wire.jsonl', { type: 'wire.test', time: 5, n: 1 });
    expect(await collect(cold.readRecords({ agentId: 'main' }))).toEqual([]);
    await lease.flush();
    expect(await collect(cold.readRecords({ agentId: 'main' }))).toHaveLength(1);
    // Closing the lease flushes on its own.
    logs.append(ns, 'wire.jsonl', { type: 'wire.test', time: 6, n: 2 });
    await lease.close('explicit');
    expect(await collect(cold.readRecords({ agentId: 'main' }))).toHaveLength(2);
  });
});

describe('same-runtime fork (plan §5.8)', () => {
  it('copies descriptor, documents, records, blobs and artifacts to a new isolated session', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-x' });
    const source = await runtime.sessions.create({
      metadata: { origin: 'source', title: 'Origin', custom: { goal: { active: true }, keep: 1 } },
    });
    const artifact = await seedSession(runtime, source.ref.sessionId, 'S');

    const forked = await runtime.sessions.fork(source.ref.sessionId, {
      metadata: { origin: 'fork' },
    });
    expect(forked.ref.sessionId).not.toBe(source.ref.sessionId);
    expect(forked.ref.runtimeId).toBe('rt-x');
    expect(forked.status).toBe('active');
    expect(forked.revision).toBe('1');
    expect(forked.metadata).toMatchObject({ origin: 'fork' });
    // The catalog metadata rewrite matches the local runtime's fork and this
    // runtime's `forkFrom` import branch: `Fork:` default title, `forkedFrom`
    // provenance, goal state dropped.
    expect(forked.metadata).toMatchObject({
      title: 'Fork: Origin',
      isCustomTitle: false,
      forkedFrom: source.ref.sessionId,
    });
    expect(forked.metadata['custom']).toEqual({ keep: 1 });

    const cold = await runtime.sessions.coldRead(forked.ref.sessionId);
    expect(await cold.listAgents()).toEqual([{ agentId: 'main', metadata: {} }]);
    expect(await collect(cold.readRecords({ agentId: 'main' }))).toHaveLength(2);
    expect(
      await streamToText(await cold.readArtifact({ ...artifact, sessionId: forked.ref.sessionId })),
    ).toBe('artifact-S');

    // Forks are isolated: writing to the fork does not touch the source.
    const lease = await runtime.sessions.open(forked.ref.sessionId, {});
    const ns = lease.persistence.sessionNamespace();
    await lease.persistence.documents(ns, jsonDocumentCodec).set(ns, 'state', { marker: 'forked' });
    await lease.close('explicit');
    const sourceCold = await runtime.sessions.coldRead(source.ref.sessionId);
    expect(await sourceCold.descriptor()).toMatchObject({ metadata: { origin: 'source' } });

    await expect(runtime.sessions.fork('missing', {})).rejects.toMatchObject({
      code: 'session.not_found',
    });
    await expect(
      runtime.sessions.fork(source.ref.sessionId, { sessionId: source.ref.sessionId }),
    ).rejects.toMatchObject({ code: 'session.already_exists' });
  });

  it('preserves source custom metadata through undefined-valued and partial patches', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-x' });
    const source = await runtime.sessions.create({
      metadata: { title: 'Origin', custom: { goal: { active: true }, keep: 1 } },
    });

    // The runtime session host forks with a `{ title: undefined, custom: undefined }`
    // patch when the caller names no metadata — undefined patch keys must not
    // wipe the source's custom metadata (only `goal` is dropped).
    const undefinedPatch = await runtime.sessions.fork(source.ref.sessionId, {
      metadata: { title: undefined, custom: undefined },
    });
    expect(undefinedPatch.metadata).toMatchObject({ title: 'Fork: Origin' });
    expect(undefinedPatch.metadata['custom']).toEqual({ keep: 1 });

    // A partial custom patch merges over the source's instead of replacing it.
    const partialPatch = await runtime.sessions.fork(source.ref.sessionId, {
      metadata: { custom: { extra: 2 } },
    });
    expect(partialPatch.metadata['custom']).toEqual({ keep: 1, extra: 2 });
  });

  it('fork and export flush a live source lease first, so pending writes are included', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-x' });
    const source = await runtime.sessions.create({});
    const lease = await runtime.sessions.open(source.ref.sessionId, {});
    const ns = lease.persistence.agentNamespace('main');
    const logs = lease.persistence.logs(ns, jsonDocumentCodec);
    // Written but never explicitly flushed: the manager flushes the live lease
    // at the fork/export snapshot boundary.
    logs.append(ns, 'wire.jsonl', { type: 'wire.test', time: 1, n: 1 });

    const forked = await runtime.sessions.fork(source.ref.sessionId, {});
    const coldFork = await runtime.sessions.coldRead(forked.ref.sessionId);
    expect(await collect(coldFork.readRecords({ agentId: 'main' }))).toHaveLength(1);

    logs.append(ns, 'wire.jsonl', { type: 'wire.test', time: 2, n: 2 });
    const entries = await collect(runtime.sessions.export(source.ref.sessionId));
    const recordsEntry = entries.find((entry) => entry.kind === 'records');
    expect(recordsEntry).toBeDefined();
    const content = await iterableToText(recordsEntry!.content);
    expect(content.trim().split('\n')).toHaveLength(2);

    // The source lease survives the manager-driven flushes untouched.
    await lease.close('explicit');
    const coldSource = await runtime.sessions.coldRead(source.ref.sessionId);
    expect(await collect(coldSource.readRecords({ agentId: 'main' }))).toHaveLength(2);
  });
});

describe('logical export/import (plan §3.5)', () => {
  it('exports a logical entry stream: kind/owner/name/schemaVersion/checksum, no paths or ids', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-x' });
    const created = await runtime.sessions.create({ metadata: { title: 'exported' } });
    await seedSession(runtime, created.ref.sessionId, 'E');

    const entries = await collect(runtime.sessions.export(created.ref.sessionId));
    const kinds = entries.map((entry) => entry.kind);
    expect(kinds[0]).toBe('descriptor');
    expect(kinds).toContain('document');
    expect(kinds).toContain('records');
    expect(kinds).toContain('blob');
    for (const entry of entries) {
      expect(entry.schemaVersion).toBe(1);
      expect(entry.checksum).toMatch(/^[0-9a-f]{8}$/);
      // Logical names only: no runtime ids, no session ids, no namespace tokens.
      expect(entry.name).not.toContain('rt-x');
      expect(entry.name).not.toContain(created.ref.sessionId);
      expect(entry.name.startsWith('session/')).toBe(false);
    }
    expect(entries.find((entry) => entry.kind === 'records')?.owner).toEqual({
      kind: 'agent',
      agentId: 'main',
    });
  });

  async function expectRoundTrip(
    source: StandaloneMemoryHostRuntime,
    target: StandaloneMemoryHostRuntime,
  ): Promise<void> {
    const created = await source.sessions.create({ metadata: { title: 'moved', tag: 'm1' } });
    const artifact = await seedSession(source, created.ref.sessionId, 'M');

    const imported = await target.sessions.import({
      entries: source.sessions.export(created.ref.sessionId),
      metadata: { extra: 'patch' },
    });
    expect(imported.ref.runtimeId).toBe(target.id);
    expect(imported.ref.sessionId).not.toBe(created.ref.sessionId);
    expect(imported.createdAt).toBe(created.createdAt);
    expect(imported.metadata).toMatchObject({ title: 'moved', tag: 'm1', extra: 'patch' });

    const cold = await target.sessions.coldRead(imported.ref.sessionId);
    expect(await cold.descriptor()).toMatchObject({ metadata: { title: 'moved' } });
    expect(await cold.listAgents()).toEqual([{ agentId: 'main', metadata: {} }]);
    expect(await collect(cold.readRecords({ agentId: 'main' }))).toHaveLength(2);
    expect(
      await streamToText(
        await cold.readArtifact({ ...artifact, runtimeId: target.id, sessionId: imported.ref.sessionId }),
      ),
    ).toBe('artifact-M');
    // The imported session opens as a full live lease with its documents intact.
    const lease = await target.sessions.open(imported.ref.sessionId, {});
    const ns = lease.persistence.sessionNamespace();
    expect(await lease.persistence.documents(ns, jsonDocumentCodec).get(ns, 'state')).toEqual({
      marker: 'M',
      turn: 1,
    });
    const blob = await lease.persistence
      .blobs(lease.persistence.agentNamespace('main'))
      .get(lease.persistence.agentNamespace('main'), 'blob-1');
    expect(blob).toEqual(enc.encode('blob-M'));
    await lease.close('explicit');
    // The source stays complete and untouched.
    expect(await collect(source.sessions.export(created.ref.sessionId))).not.toHaveLength(0);
  }

  it('round-trips a full session within the same runtime', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-x' });
    await expectRoundTrip(runtime, runtime);
  });

  it('round-trips a full session across two memory runtimes (transfer data plane)', async () => {
    const source = new StandaloneMemoryHostRuntime({ id: 'rt-source' });
    const target = new StandaloneMemoryHostRuntime({ id: 'rt-target' });
    await expectRoundTrip(source, target);
  });

  it('fails an invalid stream with session.transfer_failed and commits nothing', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-x' });
    async function* garbage(): AsyncIterable<SessionExportEntry> {
      yield {
        kind: 'descriptor',
        owner: { kind: 'session' },
        name: 'descriptor',
        schemaVersion: 1,
        content: bytesOf('this is not json'),
      };
    }
    await expect(runtime.sessions.import({ entries: garbage() })).rejects.toMatchObject({
      code: 'session.transfer_failed',
    });
    expect((await runtime.sessions.list()).items).toHaveLength(0);

    // Checksum tampering is caught before anything commits.
    const created = await runtime.sessions.create({});
    await seedSession(runtime, created.ref.sessionId, 'T');
    const entries = await collect(runtime.sessions.export(created.ref.sessionId));
    async function* tampered(): AsyncIterable<SessionExportEntry> {
      for (const entry of entries) {
        yield { ...entry, checksum: 'deadbeef' };
      }
    }
    await expect(runtime.sessions.import({ entries: tampered() })).rejects.toMatchObject({
      code: 'session.transfer_failed',
    });
    expect((await runtime.sessions.list()).items).toHaveLength(1);
  });

  it('rejects entries whose agent owner id is not a valid segment', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-x' });
    async function* badOwner(): AsyncIterable<SessionExportEntry> {
      yield {
        kind: 'blob',
        owner: { kind: 'agent', agentId: 'bad id' },
        name: 'x',
        schemaVersion: 1,
        content: bytesOf('x'),
      };
    }
    await expect(runtime.sessions.import({ entries: badOwner() })).rejects.toMatchObject({
      code: 'session.transfer_failed',
    });
    expect((await runtime.sessions.list()).items).toHaveLength(0);
  });
});

describe('cron retention, fork-semantic import and whole-inventory revision (M7)', () => {
  it('retains cron entries as session-namespace blobs and re-exports them as cron entries', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-x' });
    const created = await runtime.sessions.create({});
    await seedSession(runtime, created.ref.sessionId, 'C');
    const cronBytes = enc.encode(
      JSON.stringify({ id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', cron: '0 * * * *', prompt: 'p', createdAt: 1 }),
    );

    // Stage an import carrying a cron entry through the SAME staging path a
    // cross-runtime transfer drives.
    const imported = await runtime.sessions.import({
      sessionId: 'dst-1',
      entries: (async function* () {
        for await (const entry of runtime.sessions.export(created.ref.sessionId)) yield entry;
        yield {
          kind: 'cron',
          owner: { kind: 'session' },
          name: '01ARZ3NDEKTSV4RRFFQ69G5FAV.json',
          schemaVersion: 1,
          content: bytesOf(dec.decode(cronBytes)),
        };
      })(),
    });
    expect(imported.ref.sessionId).toBe('dst-1');

    // Retention, not scheduling: the payload sits as an opaque
    // `cron/<name>` blob of the session namespace, byte-identical.
    const lease = await runtime.sessions.open('dst-1', {});
    const sessionNs = lease.persistence.sessionNamespace();
    expect(
      await lease.persistence
        .blobs(sessionNs)
        .get(sessionNs, 'cron/01ARZ3NDEKTSV4RRFFQ69G5FAV.json'),
    ).toEqual(cronBytes);
    await lease.close('explicit');

    // Round-trip fidelity: re-exporting re-projects the blob as a cron entry.
    const reexported = await collect(runtime.sessions.export('dst-1'));
    const cronEntries = reexported.filter((entry) => entry.kind === 'cron');
    expect(cronEntries).toHaveLength(1);
    expect(cronEntries[0]?.name).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV.json');
    expect(cronEntries[0]?.owner).toEqual({ kind: 'session' });
    expect(await iterableToText(cronEntries[0]!.content)).toBe(dec.decode(cronBytes));

    // Agent-owned cron entries are rejected by staging.
    async function* agentCron(): AsyncIterable<SessionExportEntry> {
      yield {
        kind: 'cron',
        owner: { kind: 'agent', agentId: 'main' },
        name: 'x.json',
        schemaVersion: 1,
        content: bytesOf('{}'),
      };
    }
    await expect(runtime.sessions.import({ entries: agentCron() })).rejects.toMatchObject({
      code: 'session.transfer_failed',
    });
  });

  it('applies fork identity semantics on import with forkFrom', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-x' });
    const created = await runtime.sessions.create({
      sessionId: 'src-1',
      metadata: { title: 'Origin', custom: { goal: { active: true }, keep: 1 } },
    });
    // A live engine-style state.json document, so the re-anchor has something
    // to rewrite.
    {
      const lease = await runtime.sessions.open('src-1', {});
      const sessionNs = lease.persistence.sessionNamespace();
      await lease.persistence
        .documents(sessionNs, jsonDocumentCodec)
        .set(sessionNs, 'state.json', {
          id: 'src-1',
          archived: true,
          title: 'Origin',
          custom: { goal: { active: true }, keep: 1 },
        });
      await lease.flush();
      await lease.close('explicit');
    }
    // Archive the descriptor too: fork semantics must unarchive regardless.
    await runtime.sessions.update('src-1', { status: 'archived' });
    // Guarantee the fork's fresh createdAt is distinguishable (ms precision).
    await new Promise((resolve) => setTimeout(resolve, 2));

    const forked = await runtime.sessions.import({
      sessionId: 'dst-fork',
      forkFrom: 'src-1',
      entries: runtime.sessions.export('src-1'),
    });

    expect(forked.status).toBe('active');
    expect(forked.createdAt).not.toBe(created.createdAt);
    expect(forked.metadata).toMatchObject({
      forkedFrom: 'src-1',
      title: 'Fork: Origin',
      isCustomTitle: false,
    });
    // Goal state never crosses forks; unrelated custom metadata does.
    expect(forked.metadata['custom']).toEqual({ keep: 1 });

    // The imported engine state.json document got the same fork rewrite.
    const lease = await runtime.sessions.open('dst-fork', {});
    const sessionNs = lease.persistence.sessionNamespace();
    const state = await lease.persistence
      .documents(sessionNs, jsonDocumentCodec)
      .get(sessionNs, 'state.json');
    expect(state).toMatchObject({
      id: 'dst-fork',
      archived: false,
      forkedFrom: 'src-1',
      title: 'Fork: Origin',
    });
    expect((state as Record<string, unknown>)['custom']).toEqual({ keep: 1 });
    await lease.close('explicit');
  });

  it('derives a whole-inventory revision: stable, content-sensitive, flush-aware', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-x' });
    expect(await runtime.sessions.revision!('missing')).toBeUndefined();
    const created = await runtime.sessions.create({ sessionId: 'rev-1' });
    await seedSession(runtime, 'rev-1', 'R');

    const first = await runtime.sessions.revision!('rev-1');
    expect(first).toMatch(/^[0-9a-f]{8}$/);
    expect(await runtime.sessions.revision!('rev-1')).toBe(first);

    // A metadata update changes the token.
    await runtime.sessions.update('rev-1', { metadata: { title: 'renamed' } });
    const afterUpdate = await runtime.sessions.revision!('rev-1');
    expect(afterUpdate).not.toBe(first);

    // A pending (unflushed) append joins the token through the internal flush.
    const lease = await runtime.sessions.open('rev-1', {});
    const agentNs = lease.persistence.agentNamespace('main');
    lease.persistence
      .logs(agentNs, jsonDocumentCodec)
      .append(agentNs, 'wire.jsonl', { type: 'wire.late', time: 3000, n: 3 });
    const afterAppend = await runtime.sessions.revision!('rev-1');
    expect(afterAppend).not.toBe(afterUpdate);
    // The flush really happened: the cold reader sees the appended record.
    const cold = await runtime.sessions.coldRead('rev-1');
    expect(await collect(cold.readRecords({ agentId: 'main', kind: 'wire.late' }))).toHaveLength(1);
    expect(await runtime.sessions.revision!('rev-1')).toBe(afterAppend);
    await lease.close('explicit');
  });
});

describe('SessionService routing over real memory runtimes (plan §3.4)', () => {
  function setup(): { registry: SessionHostRuntimeRegistry; service: ISessionService } {
    const registry = new SessionHostRuntimeRegistry();
    return { registry, service: new SessionService(registry) };
  }

  it('create resolves the registered runtime and delegates with the runtime-local id', async () => {
    const { registry, service } = setup();
    const a = new StandaloneMemoryHostRuntime({ id: 'rt-a' });
    const b = new StandaloneMemoryHostRuntime({ id: 'rt-b' });
    registry.register(a);
    registry.register(b);

    const inA = await service.create('rt-a', { metadata: { owner: 'a' } });
    const inB = await service.create('rt-b', { metadata: { owner: 'b' } });
    expect(inA.ref.runtimeId).toBe('rt-a');
    expect(inB.ref.runtimeId).toBe('rt-b');
    expect(await a.sessions.get(inA.ref.sessionId)).toMatchObject({ metadata: { owner: 'a' } });
    expect(await b.sessions.get(inB.ref.sessionId)).toMatchObject({ metadata: { owner: 'b' } });
  });

  it('routes same-named sessions of two runtimes by full ref end to end', async () => {
    const { registry, service } = setup();
    const a = new StandaloneMemoryHostRuntime({ id: 'rt-a' });
    const b = new StandaloneMemoryHostRuntime({ id: 'rt-b' });
    registry.register(a);
    registry.register(b);

    const refA: SessionRef = (await service.create('rt-a', { sessionId: 'same-id', metadata: { m: 'a' } })).ref;
    const refB: SessionRef = (await service.create('rt-b', { sessionId: 'same-id', metadata: { m: 'b' } })).ref;
    expect(sessionRefKey(refA)).not.toBe(sessionRefKey(refB));

    // Live writes through the service land in the right runtime only.
    const handleA = await service.open(refA, {});
    const ns = handleA.context.persistence.sessionNamespace();
    await handleA.context.persistence
      .documents(ns, jsonDocumentCodec)
      .set(ns, 'state', { where: 'a' });
    await handleA.close('explicit');

    expect(await service.get(refA)).toMatchObject({ metadata: { m: 'a' } });
    expect(await service.get(refB)).toMatchObject({ metadata: { m: 'b' } });
    const coldB = await b.sessions.coldRead(refB.sessionId);
    expect(await collect(coldB.readRecords({ agentId: 'main' }))).toEqual([]);

    await service.update(refB, { metadata: { m: 'b2' } });
    expect(await service.get(refB)).toMatchObject({ metadata: { m: 'b2' } });
    expect(await service.get(refA)).toMatchObject({ metadata: { m: 'a' } });

    await service.delete(refA);
    expect(await service.get(refA)).toBeUndefined();
    expect(await service.get(refB)).toBeDefined();

    // Same-runtime fork through the service keeps the runtime id.
    const forked = await service.fork(refB, {});
    expect(forked.ref.runtimeId).toBe('rt-b');
  });

  it('list fans out across runtimes keeping full refs; open handles close leases only', async () => {
    const { registry, service } = setup();
    const a = new StandaloneMemoryHostRuntime({ id: 'rt-a' });
    const b = new StandaloneMemoryHostRuntime({ id: 'rt-b' });
    registry.register(a);
    registry.register(b);
    await service.create('rt-a', { sessionId: 'a-1' });
    await service.create('rt-b', { sessionId: 'b-1' });

    const page = await service.list();
    expect(page.items.map((d) => sessionRefKey(d.ref)).toSorted()).toEqual(['rt-a:a-1', 'rt-b:b-1']);
    expect((await service.list({ runtimeId: 'rt-b' })).items.map((d) => d.ref.sessionId)).toEqual([
      'b-1',
    ]);

    const handle = await service.open({ runtimeId: 'rt-a', sessionId: 'a-1' }, {});
    await handle.close('explicit');
    expect(a.status()).toBe('online');
    expect(registry.get('rt-a')).toBe(a);
  });
});
