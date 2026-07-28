/**
 * M2 tests for `LocalWorkspaceRuntime` (plan §4.3) — the local co-located
 * workspace runtime — and `LocalWorkspaceProvider` (plan §4.1).
 *
 * Covers the plan §9.5 legacy-layout compatibility matrix and the Local
 * column of §9.1/§9.3: one runtime creating/hosting many sessions in a
 * single `sessions/<wd_id>` bucket, per-session directory isolation,
 * open/resume/flush/close child-lease semantics, same-runtime fork with the
 * current directory copy/wire rewrite/index behavior, cold read, artifact
 * owner checks, logical export/import with byte-passthrough entries, and the
 * zero-new-on-disk-format guarantees (no locator/marker/catalog/duplicate
 * metadata, no runtimeId in session files, legacy fixtures open with no
 * importer).
 *
 * Run with `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/app/localWorkspaceRuntime/localWorkspaceRuntime.test.ts`.
 */

import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { LocalWorkspaceProvider } from '#/app/localWorkspaceRuntime/localWorkspaceProvider';
import { LocalWorkspaceRuntime } from '#/app/localWorkspaceRuntime/localWorkspaceRuntime';
import type { SessionExportEntry } from '#/app/sessionHostRuntime/sessionManager';
import type {
  ArtifactRef,
  ISessionRuntimeContext,
} from '#/app/sessionHostRuntime/sessionRuntimeContext';
import { jsonDocumentCodec } from '#/persistence/backends/node-fs/atomicDocumentStore';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';
import { createWireMetadataRecord, type WireRecord } from '#/wire/record';

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

async function streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) chunks.push(value);
  }
  return dec.decode(mergeChunks(chunks));
}

/* ------------------------------------------------------------------------ */
/* Environment factories                                                    */
/* ------------------------------------------------------------------------ */

interface TestEnv {
  readonly runtime: LocalWorkspaceRuntime;
  readonly homeDir: string;
  readonly cwd: string;
  readonly workspaceId: string;
}

async function makeEnv(overrides: {
  readonly homeDir?: string;
  readonly cwd?: string;
  readonly workspaceId?: string;
  readonly runtimeId?: string;
  readonly storage?: IFileSystemStorageService;
}): Promise<TestEnv> {
  const homeDir = overrides.homeDir ?? (await makeTempDir('lwr-home-'));
  const cwd = overrides.cwd ?? (await makeTempDir('lwr-ws-'));
  const workspaceId = overrides.workspaceId ?? encodeWorkDirKey(cwd);
  const runtime = new LocalWorkspaceRuntime({
    runtimeId: overrides.runtimeId,
    workspaceId,
    cwd,
    homeDir,
    storage: overrides.storage,
  });
  return { runtime, homeDir, cwd, workspaceId };
}

function sessionDirOf(env: TestEnv, sessionId: string): string {
  return join(env.homeDir, 'sessions', env.workspaceId, sessionId);
}

/** Every file under `dir` as sorted `/`-joined relative paths. */
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
      if (entry.isSymbolicLink()) {
        out.push(`${rel}@symlink`);
        continue;
      }
      if (entry.isDirectory()) await walk(join(current, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  await walk(dir, '');
  return out.toSorted();
}

/** rel path → file text content, for full-tree diffs. */
async function treeSnapshot(dir: string): Promise<Map<string, string>> {
  const files = await listFilesRecursive(dir);
  const snapshot = new Map<string, string>();
  for (const rel of files) {
    if (rel.endsWith('@symlink')) {
      snapshot.set(rel, '');
      continue;
    }
    snapshot.set(rel, await readFile(join(dir, rel), 'utf8'));
  }
  return snapshot;
}

async function readStateJson(env: TestEnv, sessionId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(sessionDirOf(env, sessionId), 'state.json'), 'utf8'));
}

async function writeStateJson(
  env: TestEnv,
  sessionId: string,
  meta: Record<string, unknown>,
): Promise<void> {
  const dir = sessionDirOf(env, sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'state.json'), JSON.stringify(meta));
}

async function readJsonl(path: string): Promise<WireRecord[]> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as WireRecord);
}

async function readSessionIndex(homeDir: string): Promise<Record<string, unknown>[]> {
  try {
    const text = await readFile(join(homeDir, 'session_index.jsonl'), 'utf8');
    return text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Seed a session through a real lease: wire records (metadata envelope + one
 * custom record), one blob-store file, one plan file, one task document and
 * one artifact — all through the typed stores of the lease.
 */
async function seedViaLease(
  env: TestEnv,
  sessionId: string,
  marker: string,
): Promise<{ readonly lease: ISessionRuntimeContext; readonly artifact: ArtifactRef }> {
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
  const artifact = await lease.artifacts.write(
    { kind: 'agent', agentId: 'main' },
    'report',
    bytesOf(`artifact-${marker}`),
  );
  await lease.flush();
  return { lease, artifact };
}

/** Register the `main` agent in the roster the way AgentLifecycle does. */
async function registerMainAgent(env: TestEnv, sessionId: string): Promise<void> {
  const meta = await readStateJson(env, sessionId);
  meta['agents'] = { main: { type: 'main' } };
  await writeStateJson(env, sessionId, meta);
}

/* ------------------------------------------------------------------------ */
/* Provider (plan §4.1)                                                     */
/* ------------------------------------------------------------------------ */

describe('LocalWorkspaceProvider', () => {
  it('open returns the complete long-lived registration in one shot', async () => {
    const homeDir = await makeTempDir('lwr-home-');
    const cwd = await makeTempDir('lwr-ws-');
    const provider = new LocalWorkspaceProvider({ homeDir });

    const registration = await provider.open({ root: cwd });
    expect(registration.workspaceId).toBe(encodeWorkDirKey(cwd));
    expect(registration.runtime.kind).toBe('local-workspace');
    expect(registration.runtime.id).toBe(`local-workspace_${encodeWorkDirKey(cwd)}`);
    expect(registration.runtime.status()).toBe('online');
    expect([...registration.runtime.workspaceCapabilities]).toEqual(['workspace.local']);
    expect(registration.runtime.sessions).toBeDefined();
    // The runtime is immediately usable for multi-session hosting.
    const created = await registration.runtime.sessions.create({ sessionId: 'via-provider' });
    expect(created.ref.runtimeId).toBe(registration.runtime.id);
    expect(await readStateJson({ runtime: registration.runtime as LocalWorkspaceRuntime, homeDir, cwd, workspaceId: registration.workspaceId }, 'via-provider')).toMatchObject({
      id: 'via-provider',
      cwd,
    });

    // dispose() unregisters the runtime (offline) but keeps session data.
    await registration.dispose();
    expect(registration.runtime.status()).toBe('offline');
    expect(await listFilesRecursive(join(homeDir, 'sessions'))).toEqual([
      `${registration.workspaceId}/via-provider/state.json`,
    ]);
  });

  it('honors a pre-resolved workspace id and rejects missing roots with fs.path_not_found', async () => {
    const homeDir = await makeTempDir('lwr-home-');
    const cwd = await makeTempDir('lwr-ws-');
    const provider = new LocalWorkspaceProvider({ homeDir });

    const registration = await provider.open({ root: cwd, workspaceId: 'wd_custom_1' });
    expect(registration.workspaceId).toBe('wd_custom_1');
    expect(registration.runtime.id).toBe('local-workspace_wd_custom_1');
    await registration.dispose();

    await expect(provider.open({ root: join(cwd, 'missing') })).rejects.toMatchObject({
      code: 'fs.path_not_found',
    });
    const fileRoot = join(cwd, 'a-file');
    await writeFile(fileRoot, 'x');
    await expect(provider.open({ root: fileRoot })).rejects.toMatchObject({
      code: 'fs.path_not_found',
    });
  });
});

/* ------------------------------------------------------------------------ */
/* Multi-session create (plan §9.1/§9.5)                                    */
/* ------------------------------------------------------------------------ */

describe('multi-session create', () => {
  it('lands many sessions in the same sessions/<wd_id> bucket, one directory each', async () => {
    const env = await makeEnv({});
    const sequential = [
      await env.runtime.sessions.create({}),
      await env.runtime.sessions.create({}),
    ];
    const concurrent = await Promise.all(
      Array.from({ length: 6 }, () => env.runtime.sessions.create({})),
    );
    const all = [...sequential, ...concurrent];

    expect(new Set(all.map((d) => d.ref.runtimeId))).toEqual(new Set([env.runtime.id]));
    expect(new Set(all.map((d) => d.ref.sessionId)).size).toBe(all.length);
    for (const descriptor of all) {
      expect(descriptor.ref.sessionId).toMatch(/^session_/);
      expect(descriptor.status).toBe('active');
      expect(Date.parse(descriptor.createdAt)).not.toBeNaN();
      expect(descriptor.revision).toMatch(/^[0-9a-f]{8}$/);
      // Every session is its own directory inside the ONE wd_id bucket.
      const state = await readStateJson(env, descriptor.ref.sessionId);
      expect(state).toMatchObject({
        id: descriptor.ref.sessionId,
        version: 2,
        cwd: env.cwd,
        archived: false,
        agents: {},
        custom: {},
      });
    }
    const bucket = await readdir(join(env.homeDir, 'sessions', env.workspaceId));
    expect(bucket.toSorted()).toEqual(all.map((d) => d.ref.sessionId).toSorted());
  });

  it('honors caller-proposed ids, rejects duplicates and invalid ids', async () => {
    const env = await makeEnv({});
    await env.runtime.sessions.create({ sessionId: 'mine' });
    await expect(env.runtime.sessions.create({ sessionId: 'mine' })).rejects.toMatchObject({
      code: 'session.already_exists',
    });
    const invalid = ['', 'a/b', 'a\\b', '.', '..', 'a b', 'a\nb', 'a\tb', ' lead', 'trail '];
    for (const bad of invalid) {
      await expect(env.runtime.sessions.create({ sessionId: bad }), bad).rejects.toMatchObject(
        { code: 'session.id_invalid' },
      );
    }
  });

  it('maps create metadata into state.json and appends the session_index discovery line', async () => {
    const env = await makeEnv({});
    const created = await env.runtime.sessions.create({
      sessionId: 'meta-me',
      metadata: { title: 'hello', custom: { origin: 'test' }, note: 'loose-key' },
    });
    expect(created.metadata).toMatchObject({
      title: 'hello',
      cwd: env.cwd,
      custom: { origin: 'test', note: 'loose-key' },
    });
    const state = await readStateJson(env, 'meta-me');
    expect(state).toMatchObject({
      title: 'hello',
      custom: { origin: 'test', note: 'loose-key' },
    });

    const index = await readSessionIndex(env.homeDir);
    expect(index).toEqual([
      {
        sessionId: 'meta-me',
        sessionDir: sessionDirOf(env, 'meta-me'),
        workDir: env.cwd,
      },
    ]);
  });
});

/* ------------------------------------------------------------------------ */
/* CRUD round-trip (plan §9.1)                                              */
/* ------------------------------------------------------------------------ */

describe('session CRUD', () => {
  it('get/update/delete round-trip with optimistic revisions and status filters', async () => {
    const env = await makeEnv({});
    const a = await env.runtime.sessions.create({ sessionId: 'a', metadata: { title: 'one' } });
    await env.runtime.sessions.create({ sessionId: 'b' });

    expect(await env.runtime.sessions.get('a')).toMatchObject({
      ref: { runtimeId: env.runtime.id, sessionId: 'a' },
      metadata: { title: 'one' },
    });
    expect(await env.runtime.sessions.get('missing')).toBeUndefined();
    await expect(env.runtime.sessions.update('missing', {})).rejects.toMatchObject({
      code: 'session.not_found',
    });

    const updated = await env.runtime.sessions.update('a', {
      metadata: { title: 'two' },
      status: 'archived',
      revision: a.revision,
    });
    expect(updated.metadata).toMatchObject({ title: 'two' });
    expect(updated.status).toBe('archived');
    expect(updated.revision).not.toBe(a.revision);
    // The stored document carries exactly the patched fields.
    expect(await readStateJson(env, 'a')).toMatchObject({ title: 'two', archived: true });
    // Stale optimistic revision is rejected.
    await expect(
      env.runtime.sessions.update('a', { metadata: {}, revision: a.revision }),
    ).rejects.toMatchObject({ code: 'validation.failed' });

    expect((await env.runtime.sessions.list({ status: 'active' })).items.map((d) => d.ref.sessionId)).toEqual(['b']);
    expect((await env.runtime.sessions.list({ status: 'archived' })).items.map((d) => d.ref.sessionId)).toEqual(['a']);

    await env.runtime.sessions.delete('a');
    expect(await env.runtime.sessions.get('a')).toBeUndefined();
    expect(await listFilesRecursive(join(env.homeDir, 'sessions'))).toEqual([
      `${env.workspaceId}/b/state.json`,
    ]);
    await expect(env.runtime.sessions.delete('a')).rejects.toMatchObject({
      code: 'session.not_found',
    });
  });

  it('lists in recency order with an opaque offset cursor', async () => {
    const env = await makeEnv({});
    await env.runtime.sessions.create({ sessionId: 's-1' });
    await env.runtime.sessions.create({ sessionId: 's-2' });
    await env.runtime.sessions.create({ sessionId: 's-3' });
    // Pin deterministic recency (FileSessionIndex sorts updatedAt desc).
    const metas: Record<string, Record<string, unknown>> = {};
    for (const [id, updatedAt] of [['s-1', 3000], ['s-2', 5000], ['s-3', 4000]] as const) {
      const meta = await readStateJson(env, id);
      meta['updatedAt'] = updatedAt;
      metas[id] = meta;
      await writeStateJson(env, id, meta);
    }

    const first = await env.runtime.sessions.list({ limit: 2 });
    expect(first.items.map((d) => d.ref.sessionId)).toEqual(['s-2', 's-3']);
    expect(first.cursor).toBeDefined();
    const rest = await env.runtime.sessions.list({ limit: 2, cursor: first.cursor });
    expect(rest.items.map((d) => d.ref.sessionId)).toEqual(['s-1']);
    expect(rest.cursor).toBeUndefined();
  });

  it('reads pre-unification v2 sessions through the session-meta/ fallback', async () => {
    const env = await makeEnv({});
    // Pre-unification layout: no top-level state.json, the metadata document
    // lives one level down — the same fallback `FileSessionIndex` applies.
    const legacyDir = join(sessionDirOf(env, 'pre-unified'), 'session-meta');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      join(legacyDir, 'state.json'),
      JSON.stringify({ version: 2, cwd: '/legacy/root', createdAt: 10, updatedAt: 20 }),
    );

    const descriptor = await env.runtime.sessions.get('pre-unified');
    expect(descriptor?.ref).toEqual({ runtimeId: env.runtime.id, sessionId: 'pre-unified' });
    expect(descriptor?.metadata['cwd']).toBe('/legacy/root');
    // … and the cold reader + list see it too.
    const coldDescriptor = await (await env.runtime.sessions.coldRead('pre-unified')).descriptor();
    expect(coldDescriptor.metadata['cwd']).toBe('/legacy/root');
    expect((await env.runtime.sessions.list()).items.map((d) => d.ref.sessionId)).toEqual([
      'pre-unified',
    ]);
  });

  it('recovers cwd from custom.cwd when the document has no top-level cwd/workDir', async () => {
    const env = await makeEnv({});
    // The pre-G3 spelling: the work dir only exists inside custom metadata —
    // the session index's third-level `recoverCwd` fallback.
    await writeStateJson(env, 'custom-only', {
      version: 2,
      createdAt: 10,
      updatedAt: 20,
      custom: { cwd: '/custom/root', other: 1 },
    });

    const descriptor = await env.runtime.sessions.get('custom-only');
    expect(descriptor?.metadata['cwd']).toBe('/custom/root');
    // The custom map itself still round-trips untouched.
    expect(descriptor?.metadata['custom']).toEqual({ cwd: '/custom/root', other: 1 });
  });
});

/* ------------------------------------------------------------------------ */
/* Open / resume child lease (plan §3.3/§9.3)                               */
/* ------------------------------------------------------------------------ */

describe('open/resume child lease', () => {
  it('returns the complete context bundle in one shot', async () => {
    const env = await makeEnv({});
    const created = await env.runtime.sessions.create({ metadata: { title: 'leased' } });

    const lease = await env.runtime.sessions.open(created.ref.sessionId, {});
    expect(lease.ref).toEqual(created.ref);
    expect(lease.descriptor).toEqual(created);
    expect(lease.persistence).toBeDefined();
    expect(lease.artifacts).toBeDefined();
    expect(lease.coldReader).toBeDefined();
    expect([...lease.capabilities].toSorted()).toEqual([...env.runtime.capabilities()].toSorted());
    expect(lease.contributions).toEqual({ sessionServices: [], agentServices: [], tools: [] });
    // The lease projects the workspace root plus the runtime's shared
    // node-local OS handles (plan §7.4).
    expect(lease.os?.cwd).toBe(env.cwd);
    expect(lease.os?.filesystem).toBeDefined();
    expect(lease.os?.process).toBeDefined();
    expect(lease.os?.terminal).toBeDefined();
    expect(lease.os?.watch).toBeDefined();
    expect(lease.os?.environment).toBeDefined();
    await lease.close('explicit');
  });

  it('fails open/resume with session.not_found for unknown sessions and session.open_failed for corrupted metadata', async () => {
    const env = await makeEnv({});
    await expect(env.runtime.sessions.open('missing', {})).rejects.toMatchObject({
      code: 'session.not_found',
    });
    await expect(env.runtime.sessions.resume('missing', {})).rejects.toMatchObject({
      code: 'session.not_found',
    });

    await env.runtime.sessions.create({ sessionId: 'broken' });
    await writeFile(join(sessionDirOf(env, 'broken'), 'state.json'), '{not json');
    await expect(env.runtime.sessions.open('broken', {})).rejects.toMatchObject({
      code: 'session.open_failed',
    });
    // A corrupted document is invisible to tolerant listing (FileSessionIndex semantics).
    expect((await env.runtime.sessions.list()).items).toHaveLength(0);
  });

  it('serializes writers: a second open/resume (even concurrent) conflicts, close releases', async () => {
    const env = await makeEnv({});
    const created = await env.runtime.sessions.create({});
    const id = created.ref.sessionId;

    const lease = await env.runtime.sessions.open(id, {});
    await expect(env.runtime.sessions.open(id, {})).rejects.toMatchObject({
      code: 'session.lease_conflict',
    });
    await expect(env.runtime.sessions.resume(id, {})).rejects.toMatchObject({
      code: 'session.lease_conflict',
    });
    await lease.close('explicit');
    await lease.close('explicit'); // idempotent

    const [first, second] = await Promise.allSettled([
      env.runtime.sessions.open(id, {}),
      env.runtime.sessions.open(id, {}),
    ]);
    const outcomes = [first.status, second.status].toSorted();
    expect(outcomes).toEqual(['fulfilled', 'rejected']);
    const rejected = first.status === 'rejected' ? first : (second as PromiseRejectedResult);
    expect(rejected.reason).toMatchObject({ code: 'session.lease_conflict' });
    const winner =
      first.status === 'fulfilled'
        ? first.value
        : (second as PromiseFulfilledResult<ISessionRuntimeContext>).value;
    await winner.close('explicit');
  });

  it('resume enforces expectedRevision against the stored state.json revision', async () => {
    const env = await makeEnv({});
    const created = await env.runtime.sessions.create({});
    const id = created.ref.sessionId;

    const lease = await env.runtime.sessions.resume(id, { expectedRevision: created.revision });
    await lease.close('explicit');
    await expect(
      env.runtime.sessions.resume(id, { expectedRevision: 'deadbeef' }),
    ).rejects.toMatchObject({ code: 'validation.failed' });
  });
});

/* ------------------------------------------------------------------------ */
/* Lease persistence, namespace isolation, multi-session lifecycle          */
/* (plan §9.1/§9.2/§9.3)                                                    */
/* ------------------------------------------------------------------------ */

describe('lease persistence and namespace mapping', () => {
  it('maps namespaces to the existing files: state.json documents, wire.jsonl logs, blobs', async () => {
    const env = await makeEnv({});
    const created = await env.runtime.sessions.create({ sessionId: 'mapped' });
    const lease = await env.runtime.sessions.open(created.ref.sessionId, {});

    const sessionNs = lease.persistence.sessionNamespace();
    const mainNs = lease.persistence.agentNamespace('main');
    expect(sessionNs).toBe(`sessions/${env.workspaceId}/mapped`);
    expect(mainNs).toBe(`sessions/${env.workspaceId}/mapped/agents/main`);

    // Documents land as JSON files at the namespace scope.
    await lease.persistence
      .documents(sessionNs, jsonDocumentCodec)
      .set(sessionNs, 'extra-state.json', { marker: 'session' });
    // Append logs land as JSONL journals.
    const logs = lease.persistence.logs(mainNs, jsonDocumentCodec);
    logs.append(mainNs, 'wire.jsonl', { type: 'wire.test', time: 1, marker: 'session' });
    // Blobs land as raw files.
    await lease.persistence.blobs(mainNs).put(mainNs, 'blobs/raw-1', enc.encode('raw'));
    await lease.flush();
    await lease.close('explicit');

    expect(await listFilesRecursive(sessionDirOf(env, 'mapped'))).toEqual([
      'agents/main/blobs/raw-1',
      'agents/main/wire.jsonl',
      'extra-state.json',
      'state.json',
    ]);
    expect(
      JSON.parse(await readFile(join(sessionDirOf(env, 'mapped'), 'extra-state.json'), 'utf8')),
    ).toEqual({ marker: 'session' });
    expect(await readJsonl(join(sessionDirOf(env, 'mapped'), 'agents/main/wire.jsonl'))).toEqual([
      { type: 'wire.test', time: 1, marker: 'session' },
    ]);
  });

  it('rejects namespace tokens the lease did not mint and invalid agent ids', async () => {
    const env = await makeEnv({});
    const created = await env.runtime.sessions.create({});
    const lease = await env.runtime.sessions.open(created.ref.sessionId, {});
    const foreign = `sessions/${env.workspaceId}/somebody-else` as never;

    expect(() => lease.persistence.documents(foreign, jsonDocumentCodec)).toThrowError(
      expect.objectContaining({ code: 'validation.failed' }) as Error,
    );
    expect(() => lease.persistence.logs(foreign, jsonDocumentCodec)).toThrowError(
      expect.objectContaining({ code: 'validation.failed' }) as Error,
    );
    expect(() => lease.persistence.blobs(foreign)).toThrowError(
      expect.objectContaining({ code: 'validation.failed' }) as Error,
    );
    for (const bad of ['', 'a/b', 'a\\b', '.', '..', 'a b', 'a\nb']) {
      expect(() => lease.persistence.agentNamespace(bad), bad).toThrowError(
        expect.objectContaining({ code: 'validation.failed' }) as Error,
      );
    }
    await lease.close('explicit');
  });

  it('keeps the lease live when close fails on flush, and releases it after rewrite recovery (plan §9.3)', async () => {
    // A storage backend whose appends can be switched off drives the real
    // node-fs append-log store into its sticky-failure path.
    const { FileStorageService } = await import(
      '#/persistence/backends/node-fs/fileStorageService'
    );
    const homeDir = await makeTempDir('lwr-home-');
    // Appends start healthy (create/index writes must succeed) and are
    // switched off only around the lease's failing flush window.
    let appendsDown = false;
    const base = new FileStorageService(homeDir, 0o700, 0o600);
    const flaky: IFileSystemStorageService = {
      _serviceBrand: undefined,
      append: (scope, key, data, options) =>
        appendsDown ? Promise.reject(new Error('append down')) : base.append(scope, key, data, options),
      read: base.read.bind(base),
      readStream: base.readStream.bind(base),
      write: base.write.bind(base),
      writeStream: base.writeStream.bind(base),
      list: base.list.bind(base),
      delete: base.delete.bind(base),
      flush: base.flush.bind(base),
      close: base.close.bind(base),
    };
    const env = await makeEnv({ homeDir, storage: flaky });
    const created = await env.runtime.sessions.create({});
    const lease = await env.runtime.sessions.open(created.ref.sessionId, {});
    const agentNs = lease.persistence.agentNamespace('main');
    const logs = lease.persistence.logs(agentNs, jsonDocumentCodec);
    appendsDown = true;
    logs.append(agentNs, 'wire.jsonl', { type: 'wire.test', time: 1, n: 1 });

    // Flush fails, so close fails too — and the lease stays live.
    await expect(lease.flush()).rejects.toThrow('append down');
    await expect(lease.close('explicit')).rejects.toThrow('append down');
    expect(lease.closedLease).toBe(false);
    await expect(env.runtime.sessions.open(created.ref.sessionId, {})).rejects.toMatchObject({
      code: 'session.lease_conflict',
    });

    // A valid rewrite is the recovery boundary that clears the sticky
    // failure; the retried close then flushes and releases the lease.
    appendsDown = false;
    await logs.rewrite(agentNs, 'wire.jsonl', []);
    await lease.close('explicit');
    expect(lease.closedLease).toBe(true);

    const reopened = await env.runtime.sessions.open(created.ref.sessionId, {});
    await reopened.close('explicit');
  });
});

describe('multi-session lifecycle (plan §9.3)', () => {
  it('hosts A and B concurrently with isolated files, locks and live state; closing A keeps B and the runtime up', async () => {
    const env = await makeEnv({});
    await env.runtime.sessions.create({ sessionId: 'A' });
    await env.runtime.sessions.create({ sessionId: 'B' });

    const leaseA = await env.runtime.sessions.open('A', {});
    const leaseB = await env.runtime.sessions.open('B', {});
    const nsA = leaseA.persistence.agentNamespace('main');
    const nsB = leaseB.persistence.agentNamespace('main');
    leaseA.persistence.logs(nsA, jsonDocumentCodec).append(nsA, 'wire.jsonl', {
      type: 'wire.test',
      time: 1,
      who: 'A',
    });
    leaseB.persistence.logs(nsB, jsonDocumentCodec).append(nsB, 'wire.jsonl', {
      type: 'wire.test',
      time: 2,
      who: 'B',
    });
    await leaseA.flush();
    await leaseB.flush();

    const beforeCloseA = await treeSnapshot(sessionDirOf(env, 'B'));
    await leaseA.close('explicit');

    // B's files are untouched by A's close, and B keeps writing.
    expect(await treeSnapshot(sessionDirOf(env, 'B'))).toEqual(beforeCloseA);
    expect(leaseB.closedLease).toBe(false);
    leaseB.persistence.logs(nsB, jsonDocumentCodec).append(nsB, 'wire.jsonl', {
      type: 'wire.test',
      time: 3,
      who: 'B2',
    });
    await leaseB.close('explicit');
    expect(await readJsonl(join(sessionDirOf(env, 'B'), 'agents/main/wire.jsonl'))).toHaveLength(2);
    expect(await readJsonl(join(sessionDirOf(env, 'A'), 'agents/main/wire.jsonl'))).toHaveLength(1);

    // The runtime stays online and hosts the next session.
    expect(env.runtime.status()).toBe('online');
    const c = await env.runtime.sessions.create({ sessionId: 'C' });
    expect(c.ref.runtimeId).toBe(env.runtime.id);
  });

  it('closing the last session never closes the runtime; runtime.close goes offline with data retained', async () => {
    const env = await makeEnv({});
    const created = await env.runtime.sessions.create({ sessionId: 'only' });
    const lease = await env.runtime.sessions.open('only', {});
    await lease.close('explicit');
    expect(env.runtime.status()).toBe('online');
    // Closing the last session never closes the runtime: it re-opens fine.
    const reopened = await env.runtime.sessions.open('only', {});
    await reopened.close('explicit');

    const lease2 = await env.runtime.sessions.open('only', {});
    await env.runtime.close('shutdown');
    await env.runtime.close('shutdown'); // idempotent
    expect(env.runtime.status()).toBe('offline');
    expect(lease2.closedLease).toBe(true);

    const unavailable = { code: 'session.runtime_unavailable' };
    await expect(env.runtime.sessions.create({})).rejects.toMatchObject(unavailable);
    await expect(env.runtime.sessions.list()).rejects.toMatchObject(unavailable);
    await expect(env.runtime.sessions.get('only')).rejects.toMatchObject(unavailable);
    await expect(env.runtime.sessions.update('only', {})).rejects.toMatchObject(unavailable);
    await expect(env.runtime.sessions.delete('only')).rejects.toMatchObject(unavailable);
    await expect(env.runtime.sessions.open('only', {})).rejects.toMatchObject(unavailable);
    await expect(env.runtime.sessions.resume('only', {})).rejects.toMatchObject(unavailable);
    await expect(env.runtime.sessions.fork('only', {})).rejects.toMatchObject(unavailable);
    await expect(env.runtime.sessions.coldRead('only')).rejects.toMatchObject(unavailable);
    await expect(
      env.runtime.sessions.import({ entries: env.runtime.sessions.export('only') }),
    ).rejects.toMatchObject(unavailable);
    await expect(collect(env.runtime.sessions.export('only'))).rejects.toMatchObject(unavailable);

    // Data is retained: the session directory is exactly as it was.
    expect(await listFilesRecursive(sessionDirOf(env, 'only'))).toEqual(['state.json']);
    expect(await readStateJson(env, 'only')).toMatchObject({ id: 'only' });
    void created;
  });

  it('delete refuses a live lease unless forced; force closes the lease and removes the directory', async () => {
    const env = await makeEnv({});
    await env.runtime.sessions.create({ sessionId: 'victim' });
    const lease = await env.runtime.sessions.open('victim', {});

    await expect(env.runtime.sessions.delete('victim')).rejects.toMatchObject({
      code: 'session.lease_conflict',
    });
    await env.runtime.sessions.delete('victim', { force: true });
    expect(lease.closedLease).toBe(true);
    expect(await env.runtime.sessions.get('victim')).toBeUndefined();
    expect(await listFilesRecursive(join(env.homeDir, 'sessions'))).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ */
/* Same-runtime fork (plan §5.8/§9.5)                                       */
/* ------------------------------------------------------------------------ */

describe('same-runtime fork', () => {
  it('copies the directory with the current exclusion set, rewrites wire/state, updates the index and cron', async () => {
    const env = await makeEnv({});
    await env.runtime.sessions.create({
      sessionId: 'source',
      metadata: { title: 'Original', custom: { goal: 'drop-me', keep: 'yes' } },
    });
    const { lease, artifact } = await seedViaLease(env, 'source', 'fork');
    await lease.close('explicit');
    await registerMainAgent(env, 'source');
    // A session log file exists but must NOT cross the fork.
    await mkdir(join(sessionDirOf(env, 'source'), 'logs'), { recursive: true });
    await writeFile(join(sessionDirOf(env, 'source'), 'logs/kimi-code.log'), 'log-line\n');
    // A session-tagged cron task duplicates onto the fork.
    const cronScope = join(env.homeDir, 'cron', env.workspaceId);
    await mkdir(cronScope, { recursive: true });
    await writeFile(
      join(cronScope, 'cron-1.json'),
      JSON.stringify({
        id: 'cron-1',
        cron: '* * * * *',
        prompt: 'tick',
        createdAt: 1,
        tags: { sessionId: 'source' },
      }),
    );
    await writeFile(
      join(cronScope, 'cron-2.json'),
      JSON.stringify({
        id: 'cron-2',
        cron: '* * * * *',
        prompt: 'other session',
        createdAt: 1,
        tags: { sessionId: 'somebody-else' },
      }),
    );

    const forked = await env.runtime.sessions.fork('source', { sessionId: 'forked' });
    expect(forked.ref.runtimeId).toBe(env.runtime.id);
    expect(forked.status).toBe('active');
    expect(forked.metadata).toMatchObject({
      title: 'Fork: Original',
      forkedFrom: 'source',
      custom: { keep: 'yes' }, // the goal key never crosses forks
    });

    // The target directory holds exactly the current fork product.
    expect(await listFilesRecursive(sessionDirOf(env, 'forked'))).toEqual([
      'agents/main/blobs/blob-1',
      'agents/main/blobs/report',
      'agents/main/plans/plan-1.md',
      'agents/main/tasks/task-1.json',
      'agents/main/wire.jsonl',
      'state.json',
    ]);
    const targetState = await readStateJson(env, 'forked');
    expect(targetState).toMatchObject({
      id: 'forked',
      title: 'Fork: Original',
      forkedFrom: 'source',
      archived: false,
      agents: { main: { type: 'main' } },
    });

    // Wire rewrite: metadata envelope first, source records kept, fork boundary last.
    const wire = await readJsonl(join(sessionDirOf(env, 'forked'), 'agents/main/wire.jsonl'));
    expect(wire[0]?.type).toBe('metadata');
    expect(wire.map((record) => record.type)).toEqual(['metadata', 'wire.test', 'forked']);

    // The source is untouched.
    expect(await readJsonl(join(sessionDirOf(env, 'source'), 'agents/main/wire.jsonl'))).toHaveLength(2);
    expect(await listFilesRecursive(sessionDirOf(env, 'source'))).toContain('logs/kimi-code.log');

    // Cron duplication: one new task tagged to the fork; the other session's task untouched.
    const cronFiles = await readdir(cronScope);
    expect(cronFiles.toSorted()).toHaveLength(3);
    const cronTasks = await Promise.all(
      cronFiles.map(async (file) => JSON.parse(await readFile(join(cronScope, file), 'utf8'))),
    );
    const duplicated = cronTasks.filter((task) => task.tags?.sessionId === 'forked');
    expect(duplicated).toHaveLength(1);
    expect(duplicated[0]).toMatchObject({ cron: '* * * * *', prompt: 'tick' });
    expect(duplicated[0].id).not.toBe('cron-1');

    // The discovery log names the fork.
    const index = await readSessionIndex(env.homeDir);
    expect(index.map((entry) => entry['sessionId'])).toEqual(['source', 'forked']);
    expect(index[1]).toMatchObject({ sessionDir: sessionDirOf(env, 'forked'), workDir: env.cwd });

    // The fork is a normal session afterwards.
    const leaseFork = await env.runtime.sessions.open('forked', {});
    await leaseFork.close('explicit');
    void artifact;
  });

  it('forks a live source at a flush boundary: pending appends are included, the source lease survives', async () => {
    const env = await makeEnv({});
    await env.runtime.sessions.create({ sessionId: 'live-source' });
    await registerMainAgent(env, 'live-source');
    const lease = await env.runtime.sessions.open('live-source', {});
    const ns = lease.persistence.agentNamespace('main');
    // Written but never explicitly flushed: the manager flushes the live
    // lease before copying, so the fork contains the pending record.
    lease.persistence.logs(ns, jsonDocumentCodec).append(ns, 'wire.jsonl', {
      type: 'wire.test',
      time: 9,
      pending: true,
    });

    const forked = await env.runtime.sessions.fork('live-source', { sessionId: 'live-fork' });
    expect(forked.ref.sessionId).toBe('live-fork');
    const wire = await readJsonl(join(sessionDirOf(env, 'live-fork'), 'agents/main/wire.jsonl'));
    expect(wire.map((record) => record.type)).toEqual(['metadata', 'wire.test', 'forked']);
    expect(lease.closedLease).toBe(false);
    await lease.close('explicit');
  });

  it('rejects forks onto existing ids and rolls back failed forks', async () => {
    const env = await makeEnv({});
    await env.runtime.sessions.create({ sessionId: 'src' });
    await env.runtime.sessions.create({ sessionId: 'taken' });
    await expect(env.runtime.sessions.fork('src', { sessionId: 'taken' })).rejects.toMatchObject({
      code: 'session.already_exists',
    });
    await expect(env.runtime.sessions.fork('missing-src', {})).rejects.toMatchObject({
      code: 'session.not_found',
    });
    expect(await listFilesRecursive(join(env.homeDir, 'sessions'))).toEqual([
      `${env.workspaceId}/src/state.json`,
      `${env.workspaceId}/taken/state.json`,
    ]);
  });
});

/* ------------------------------------------------------------------------ */
/* Cold read (plan §5.9/§9.7)                                               */
/* ------------------------------------------------------------------------ */

describe('cold read', () => {
  it('reads descriptor, agent roster, records and artifacts from the existing files', async () => {
    const env = await makeEnv({});
    await env.runtime.sessions.create({ sessionId: 'cold', metadata: { title: 'cold one' } });
    const { lease, artifact } = await seedViaLease(env, 'cold', 'cold');
    await lease.close('explicit');
    await registerMainAgent(env, 'cold');

    const cold = await env.runtime.sessions.coldRead('cold');
    const descriptor = await cold.descriptor();
    expect(descriptor).toMatchObject({
      ref: { runtimeId: env.runtime.id, sessionId: 'cold' },
      status: 'active',
      metadata: { title: 'cold one' },
    });

    const agents = await cold.listAgents();
    expect(agents).toEqual([{ agentId: 'main', role: 'main', metadata: {} }]);

    // Records project type/time from the JSONL journal; kind filter and limit apply.
    const all = await collect(cold.readRecords({ agentId: 'main' }));
    expect(all.map((record) => record.kind)).toEqual(['metadata', 'wire.test']);
    expect(all[1]).toMatchObject({
      kind: 'wire.test',
      timestamp: new Date(2000).toISOString(),
      data: { type: 'wire.test', time: 2000, marker: 'cold', n: 1 },
    });
    const filtered = await collect(cold.readRecords({ agentId: 'main', kind: 'wire.test', limit: 1 }));
    expect(filtered).toHaveLength(1);
    // Session-level record queries are empty in the local layout (records live at agent level).
    expect(await collect(cold.readRecords({}))).toEqual([]);

    // Artifact reads validate the full ref (with byte ranges).
    expect(await streamToText(await cold.readArtifact(artifact))).toBe('artifact-cold');
    expect(
      await streamToText(await cold.readArtifact(artifact, { range: { start: 9, end: 13 } })),
    ).toBe('cold');
    await expect(
      cold.readArtifact({ ...artifact, sessionId: 'other' }),
    ).rejects.toMatchObject({ code: 'artifact.owner_mismatch' });
    await expect(
      cold.readArtifact({ ...artifact, runtimeId: 'other-runtime' }),
    ).rejects.toMatchObject({ code: 'artifact.owner_mismatch' });
    await expect(
      cold.readArtifact({ ...artifact, owner: { kind: 'session' } }),
    ).rejects.toMatchObject({ code: 'artifact.owner_mismatch' });
    await expect(
      cold.readArtifact({ ...artifact, artifactId: 'nope' }),
    ).rejects.toMatchObject({ code: 'artifact.owner_mismatch' });

    await expect(env.runtime.sessions.coldRead('missing')).rejects.toMatchObject({
      code: 'session.not_found',
    });
  });

  it('observes lease writes after flush at the same revision the descriptor reports', async () => {
    const env = await makeEnv({});
    await env.runtime.sessions.create({ sessionId: 'vis' });
    const lease = await env.runtime.sessions.open('vis', {});
    const ns = lease.persistence.agentNamespace('main');
    lease.persistence.logs(ns, jsonDocumentCodec).append(ns, 'wire.jsonl', {
      type: 'wire.test',
      time: 1,
    });
    await lease.flush();

    const cold = await env.runtime.sessions.coldRead('vis');
    expect(await collect(cold.readRecords({ agentId: 'main' }))).toHaveLength(1);
    expect((await cold.descriptor()).revision).toBe(lease.descriptor.revision);
    await lease.close('explicit');
  });
});

/* ------------------------------------------------------------------------ */
/* Artifact service (plan §5.10)                                            */
/* ------------------------------------------------------------------------ */

describe('artifact service', () => {
  it('writes and reads artifacts per owner in the existing blobs convention, with ranges', async () => {
    const env = await makeEnv({});
    await env.runtime.sessions.create({ sessionId: 'art' });
    const lease = await env.runtime.sessions.open('art', {});

    const sessionArtifact = await lease.artifacts.write(
      { kind: 'session' },
      'attachment',
      bytesOf('session-bytes'),
    );
    const agentArtifact = await lease.artifacts.write(
      { kind: 'agent', agentId: 'main' },
      'attachment',
      bytesOf('agent-bytes'),
    );

    // Same artifactId under different owners does not collide.
    expect(await streamToText(await lease.artifacts.read(sessionArtifact))).toBe('session-bytes');
    expect(await streamToText(await lease.artifacts.read(agentArtifact))).toBe('agent-bytes');
    expect(await listFilesRecursive(sessionDirOf(env, 'art'))).toEqual([
      'agents/main/blobs/attachment',
      'blobs/attachment',
      'state.json',
    ]);

    expect(
      await streamToText(await lease.artifacts.read(agentArtifact, { range: { start: 0, end: 5 } })),
    ).toBe('agent');
    await expect(lease.artifacts.read({ ...agentArtifact, sessionId: 'ghost' })).rejects.toMatchObject(
      { code: 'artifact.owner_mismatch' },
    );
    await expect(
      lease.artifacts.write({ kind: 'agent', agentId: 'a/b' }, 'x', bytesOf('x')),
    ).rejects.toMatchObject({ code: 'validation.failed' });
    await expect(
      lease.artifacts.write({ kind: 'session' }, 'a/b', bytesOf('x')),
    ).rejects.toMatchObject({ code: 'validation.failed' });
    await lease.close('explicit');
  });
});

/* ------------------------------------------------------------------------ */
/* Logical export / import (plan §3.5/§5.10/§9.1)                           */
/* ------------------------------------------------------------------------ */

describe('logical export/import', () => {
  /** An export entry whose content has been buffered for multi-pass assertions. */
  interface BufferedEntry {
    readonly kind: SessionExportEntry['kind'];
    readonly owner: SessionExportEntry['owner'];
    readonly name: string;
    readonly schemaVersion: number;
    readonly checksum?: string;
    readonly bytes: Uint8Array;
  }

  async function bufferExport(env: TestEnv, sessionId: string): Promise<BufferedEntry[]> {
    const buffered: BufferedEntry[] = [];
    for await (const entry of env.runtime.sessions.export(sessionId)) {
      buffered.push({
        kind: entry.kind,
        owner: entry.owner,
        name: entry.name,
        schemaVersion: entry.schemaVersion,
        checksum: entry.checksum,
        bytes: mergeChunks(await collect(entry.content)),
      });
    }
    return buffered;
  }

  /** Rebuild fresh single-pass export entries from a buffered snapshot. */
  function toEntries(buffered: readonly BufferedEntry[]): SessionExportEntry[] {
    return buffered.map((entry) => ({
      kind: entry.kind,
      owner: entry.owner,
      name: entry.name,
      schemaVersion: entry.schemaVersion,
      checksum: entry.checksum,
      content: bytesAsIterable(entry.bytes),
    }));
  }

  async function* bytesAsIterable(bytes: Uint8Array): AsyncIterable<Uint8Array> {
    yield bytes;
  }

  async function seedExportable(
    env: TestEnv,
    sessionId: string,
  ): Promise<{ readonly artifact: ArtifactRef }> {
    await env.runtime.sessions.create({ sessionId, metadata: { title: 'exportable' } });
    const { lease, artifact } = await seedViaLease(env, sessionId, 'xp');
    await lease.close('explicit');
    await registerMainAgent(env, sessionId);
    await mkdir(join(sessionDirOf(env, sessionId), 'logs'), { recursive: true });
    await writeFile(join(sessionDirOf(env, sessionId), 'logs/kimi-code.log'), 'export-log\n');
    return { artifact };
  }

  it('exports the full inventory as logical byte-passthrough entries with stable names', async () => {
    const env = await makeEnv({});
    await seedExportable(env, 'exp-src');
    const entries = await bufferExport(env, 'exp-src');

    const summary = entries.map(
      (entry) =>
        `${entry.kind}:${entry.owner.kind === 'agent' ? `agent/${entry.owner.agentId}` : 'session'}:${entry.name}`,
    );
    expect(summary).toEqual([
      'descriptor:session:descriptor',
      'document:session:state.json',
      'blob:agent/main:blobs/blob-1',
      'blob:agent/main:blobs/report',
      'blob:agent/main:plans/plan-1.md',
      'blob:agent/main:tasks/task-1.json',
      'records:agent/main:wire.jsonl',
      'blob:session:logs/kimi-code.log',
    ]);
    for (const entry of entries) {
      expect(entry.schemaVersion).toBe(1);
      expect(entry.checksum).toMatch(/^[0-9a-f]{8}$/);
      // Entry names are stable logical names: no host root, no wd_id, no runtimeId.
      expect(entry.name).not.toContain(env.homeDir);
      expect(entry.name).not.toContain(env.workspaceId);
      expect(entry.name).not.toContain(env.runtime.id);
      expect(entry.name.startsWith('/')).toBe(false);
    }

    // The descriptor entry carries the logical session facts.
    const descriptor = JSON.parse(dec.decode(entries[0]!.bytes));
    expect(descriptor).toMatchObject({
      status: 'active',
      metadata: { title: 'exportable', cwd: env.cwd },
    });
    expect(Date.parse(descriptor.createdAt)).not.toBeNaN();

    // Byte passthrough: the state.json document is the stored file verbatim.
    expect(dec.decode(entries[1]!.bytes)).toBe(
      await readFile(join(sessionDirOf(env, 'exp-src'), 'state.json'), 'utf8'),
    );
    // Checksums cover the exact bytes.
    const { fnv1aHex } = await import('#/app/localWorkspaceRuntime/localWorkspaceLayout');
    for (const entry of entries) {
      expect(fnv1aHex(entry.bytes)).toBe(entry.checksum);
    }
    // Export is read-only: the tree did not change.
    expect(await listFilesRecursive(sessionDirOf(env, 'exp-src'))).toEqual([
      'agents/main/blobs/blob-1',
      'agents/main/blobs/report',
      'agents/main/plans/plan-1.md',
      'agents/main/tasks/task-1.json',
      'agents/main/wire.jsonl',
      'logs/kimi-code.log',
      'state.json',
    ]);
  });

  it('imports a staged stream into the existing layout and round-trips', async () => {
    const env = await makeEnv({});
    await seedExportable(env, 'exp-src');
    const entries = await bufferExport(env, 'exp-src');

    const imported = await env.runtime.sessions.import({
      sessionId: 'exp-dst',
      entries: toIterable(toEntries(entries)),
    });
    expect(imported.ref.runtimeId).toBe(env.runtime.id);
    expect(imported.status).toBe('active');
    expect(imported.metadata).toMatchObject({ title: 'exportable', cwd: env.cwd });

    // Same file inventory as the source (state.json re-anchored to the import).
    expect(await listFilesRecursive(sessionDirOf(env, 'exp-dst'))).toEqual(
      await listFilesRecursive(sessionDirOf(env, 'exp-src')),
    );
    const state = await readStateJson(env, 'exp-dst');
    expect(state).toMatchObject({
      id: 'exp-dst',
      version: 2,
      cwd: env.cwd,
      archived: false,
      agents: { main: { type: 'main' } },
      custom: {},
      title: 'exportable',
    });
    // createdAt survives the transfer; updatedAt is re-anchored.
    expect(state['createdAt']).toBe((await readStateJson(env, 'exp-src'))['createdAt']);

    // Cold read of the import serves the same records.
    const cold = await env.runtime.sessions.coldRead('exp-dst');
    expect((await cold.listAgents()).map((agent) => agent.agentId)).toEqual(['main']);
    const records = await collect(cold.readRecords({ agentId: 'main', kind: 'wire.test' }));
    expect(records).toHaveLength(1);
    expect(records[0]?.data).toMatchObject({ marker: 'xp' });

    // The discovery log names both sessions.
    expect((await readSessionIndex(env.homeDir)).map((entry) => entry['sessionId'])).toEqual([
      'exp-src',
      'exp-dst',
    ]);

    // Round-trip: re-exporting the import yields the same logical inventory.
    const reexported = await bufferExport(env, 'exp-dst');
    expect(reexported.map((entry) => `${entry.kind}:${entry.name}`)).toEqual(
      entries.map((entry) => `${entry.kind}:${entry.name}`),
    );
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    for (const entry of reexported) {
      if (entry.name === 'state.json' || entry.kind === 'descriptor') continue;
      const original = byName.get(entry.name);
      expect(original).toBeDefined();
      expect(entry.bytes).toEqual(original!.bytes);
    }
  });

  it('rejects tampered, malformed or unsafe streams without writing anything', async () => {
    const env = await makeEnv({});
    await seedExportable(env, 'exp-src');
    const good = await bufferExport(env, 'exp-src');

    // Checksum mismatch.
    const tampered = toEntries(good).map((entry) =>
      entry.kind === 'records' ? { ...entry, content: bytesOf('{"type":"wire.evil"}\n') } : entry,
    );
    await expect(
      env.runtime.sessions.import({ sessionId: 'bad-1', entries: toIterable(tampered) }),
    ).rejects.toMatchObject({ code: 'session.transfer_failed' });

    // Unsupported schema version.
    const versioned = toEntries(good).map((entry) => ({ ...entry, schemaVersion: 99 }));
    await expect(
      env.runtime.sessions.import({ sessionId: 'bad-2', entries: toIterable(versioned) }),
    ).rejects.toMatchObject({ code: 'session.transfer_failed' });

    // Unsafe entry names (traversal, separators).
    const unsafe: SessionExportEntry = {
      kind: 'blob',
      owner: { kind: 'session' },
      name: '../escape',
      schemaVersion: 1,
      content: bytesOf('x'),
    };
    await expect(
      env.runtime.sessions.import({
        sessionId: 'bad-3',
        entries: toIterable([...toEntries(good), unsafe]),
      }),
    ).rejects.toMatchObject({ code: 'session.transfer_failed' });

    // Broken record framing (empty line inside the records payload).
    const brokenRecords = toEntries(good).map((entry) =>
      entry.kind === 'records'
        ? { ...entry, checksum: undefined, content: bytesOf('{"type":"a"}\n\n{"type":"b"}\n') }
        : entry,
    );
    await expect(
      env.runtime.sessions.import({ sessionId: 'bad-4', entries: toIterable(brokenRecords) }),
    ).rejects.toMatchObject({ code: 'session.transfer_failed' });

    // Import onto an existing id is refused.
    await expect(
      env.runtime.sessions.import({ sessionId: 'exp-src', entries: toIterable(toEntries(good)) }),
    ).rejects.toMatchObject({ code: 'session.already_exists' });

    // Nothing was written for any of the failures.
    expect(await readdir(join(env.homeDir, 'sessions', env.workspaceId))).toEqual(['exp-src']);
  });
});

async function* toIterable(entries: readonly SessionExportEntry[]): AsyncIterable<SessionExportEntry> {
  yield* entries;
}

/* ------------------------------------------------------------------------ */
/* Legacy layout compatibility (plan §9.5)                                  */
/* ------------------------------------------------------------------------ */

describe('legacy layout compatibility (plan §9.5)', () => {
  it('opens a v1-era session directory directly — normalized reads, zero importer writes', async () => {
    const env = await makeEnv({});
    const sessionId = 'legacy-session';
    const dir = sessionDirOf(env, sessionId);
    await mkdir(join(dir, 'agents/main/plans'), { recursive: true });
    await mkdir(join(dir, 'agents/main/blobs'), { recursive: true });
    // v1-shaped state.json: no `version`, ISO timestamps, `workDir`, agent
    // roster carrying the legacy absolute `homedir` field.
    await writeFile(
      join(dir, 'state.json'),
      JSON.stringify({
        id: sessionId,
        title: 'legacy session',
        createdAt: '2024-01-02T03:04:05.000Z',
        updatedAt: '2024-01-03T03:04:05.000Z',
        archived: false,
        workDir: env.cwd,
        agents: { main: { homedir: join(dir, 'agents/main'), type: 'main' } },
        custom: { origin: 'v1' },
      }),
    );
    // A v1-era journal without the metadata envelope.
    await writeFile(
      join(dir, 'agents/main/wire.jsonl'),
      '{"type":"message","time":1704164645000,"id":"m1"}\n{"type":"usage","time":1704164646000}\n',
    );
    await writeFile(join(dir, 'agents/main/plans/p1.md'), '# old plan\n');
    await writeFile(join(dir, 'agents/main/blobs/deadbeef'), 'blob-bytes');

    const before = await treeSnapshot(env.homeDir);

    // The runtime opens the old directory as-is.
    const lease = await env.runtime.sessions.open(sessionId, {});
    expect(lease.descriptor).toMatchObject({
      ref: { runtimeId: env.runtime.id, sessionId },
      status: 'active',
      metadata: { title: 'legacy session', cwd: env.cwd, custom: { origin: 'v1' } },
    });
    expect(lease.descriptor.createdAt).toBe('2024-01-02T03:04:05.000Z');
    await lease.close('explicit');

    // Cold read serves the old roster and envelope-less journal.
    const cold = await env.runtime.sessions.coldRead(sessionId);
    expect(await cold.listAgents()).toEqual([{ agentId: 'main', role: 'main', metadata: {} }]);
    const records = await collect(cold.readRecords({ agentId: 'main' }));
    expect(records.map((record) => record.kind)).toEqual(['message', 'usage']);
    expect(records[0]?.timestamp).toBe('2024-01-02T03:04:05.000Z');

    // Resume works too.
    const resumed = await env.runtime.sessions.resume(sessionId, {});
    await resumed.close('explicit');

    // Zero importer: the entire home tree is byte-identical afterwards.
    expect(await treeSnapshot(env.homeDir)).toEqual(before);
  });

  it('writes only the existing layout across the whole lifecycle — no locator, marker, catalog or duplicate metadata', async () => {
    const env = await makeEnv({});
    await env.runtime.sessions.create({ sessionId: 'life-1' });
    const { lease } = await seedViaLease(env, 'life-1', 'life');
    await lease.close('explicit');
    await registerMainAgent(env, 'life-1');
    await env.runtime.sessions.create({ sessionId: 'life-2' });
    await env.runtime.sessions.fork('life-1', { sessionId: 'life-fork' });
    await collect(env.runtime.sessions.export('life-1'));
    await env.runtime.sessions.import({
      sessionId: 'life-import',
      entries: env.runtime.sessions.export('life-1'),
    });
    await env.runtime.sessions.delete('life-2');

    const homeFiles = await listFilesRecursive(env.homeDir);
    const allowed = [
      /^session_index\.jsonl$/,
      /^sessions\/[^/]+\/[^/]+\/state\.json$/,
      /^sessions\/[^/]+\/[^/]+\/agents\/[^/]+\/wire\.jsonl$/,
      /^sessions\/[^/]+\/[^/]+\/agents\/[^/]+\/blobs\/[^/]+$/,
      /^sessions\/[^/]+\/[^/]+\/agents\/[^/]+\/plans\/[^/]+$/,
      /^sessions\/[^/]+\/[^/]+\/agents\/[^/]+\/tasks\/[^/]+\.json$/,
    ];
    const bannedFragments = [
      '.session-store',
      'locator',
      'marker',
      'refcount',
      'catalog',
      'migration',
      'runtime',
    ];
    for (const rel of homeFiles) {
      expect(
        allowed.some((pattern) => pattern.test(rel)),
        `unexpected file in legacy layout: ${rel}`,
      ).toBe(true);
      for (const fragment of bannedFragments) {
        expect(rel.toLowerCase()).not.toContain(fragment);
      }
      // No file content leaks the runtimeId into the session directories.
      const content = await readFile(join(env.homeDir, rel), 'utf8');
      expect(content).not.toContain(env.runtime.id);
    }
    // Exactly the expected buckets remain.
    expect(homeFiles).toContain('session_index.jsonl');
    expect(
      (await readdir(join(env.homeDir, 'sessions', env.workspaceId))).toSorted(),
    ).toEqual(['life-1', 'life-fork', 'life-import']);
  });

  it('keeps fork/export/import products free of runtimeId and host paths inside session files', async () => {
    const env = await makeEnv({});
    await env.runtime.sessions.create({ sessionId: 'scan-src' });
    const { lease } = await seedViaLease(env, 'scan-src', 'scan');
    await lease.close('explicit');
    await registerMainAgent(env, 'scan-src');
    await env.runtime.sessions.fork('scan-src', { sessionId: 'scan-fork' });

    for (const rel of await listFilesRecursive(sessionDirOf(env, 'scan-fork'))) {
      const content = await readFile(join(sessionDirOf(env, 'scan-fork'), rel), 'utf8');
      expect(content).not.toContain(env.runtime.id);
      expect(content).not.toContain(env.homeDir);
    }
  });
});
