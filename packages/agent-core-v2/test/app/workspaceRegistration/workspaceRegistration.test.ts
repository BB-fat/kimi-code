/**
 * M3 tests for the Workspace registration/runtime manager
 * (`IWorkspaceRuntimeManager`, plan §7.7) and the Workspace Session facade
 * (`IWorkspaceSessionService`, plan §4.2).
 *
 * Covers plan §9.4: the facade delegates every operation to the SAME
 * registered runtime (two internal creates share the runtime id and never
 * re-open the provider — spy proof included), ordinary CRUD performs no
 * provider.open/register, closing or deleting a session never unregisters the
 * runtime, unregister blocks new leases and drops routing while retaining
 * session data (a same-id re-registration revives it, plan §9.2), and Local
 * A / Local B / Remote C coexist in one process with accurate routing.
 * Run with `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/app/workspaceRegistration/workspaceRegistration.test.ts`.
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { SessionHostRuntimeRegistry } from '#/app/sessionHostRuntime/sessionHostRuntimeRegistry';
import type { IWorkspaceService } from '#/app/workspace/workspace';
import type { WorkspaceRuntimeRef } from '#/app/workspaceRegistration/workspaceRuntimeManager';
import { WorkspaceRuntimeManagerService } from '#/app/workspaceRegistration/workspaceRuntimeManagerService';
import { WorkspaceSessionServiceImpl } from '#/app/workspaceRegistration/workspaceSessionServiceImpl';
import { HostEnvironmentService } from '#/os/backends/node-local/hostEnvironmentService';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { HostFsWatchService } from '#/os/backends/node-local/hostFsWatchService';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { HostTerminalService } from '#/os/backends/node-local/hostTerminalService';
import { jsonDocumentCodec } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';

import {
  FakeRemoteWorkspaceProvider,
  FakeRemoteWorkspaceRuntime,
} from '../../harness/remoteWorkspaceRuntime';

/** Minimal catalog stub: no workspaces unless a test seeds them. */
function stubWorkspaceService(entries: { id: string; root: string }[] = []): IWorkspaceService {
  return {
    _serviceBrand: undefined,
    list: async () =>
      entries.map((entry) => ({
        ...entry,
        name: entry.id,
        createdAt: 0,
        lastOpenedAt: 0,
      })),
    get: async (id: string) => {
      const found = entries.find((entry) => entry.id === id);
      return found === undefined
        ? undefined
        : { ...found, name: found.id, createdAt: 0, lastOpenedAt: 0 };
    },
    createOrTouch: async () => {
      throw new Error('not implemented in stub');
    },
    update: async () => undefined,
    delete: async () => {},
  };
}

interface Env {
  readonly homeDir: string;
  readonly registry: SessionHostRuntimeRegistry;
  readonly manager: WorkspaceRuntimeManagerService;
  readonly facade: WorkspaceSessionServiceImpl;
  readonly remoteProvider: FakeRemoteWorkspaceProvider;
  /** Two local workspaces (real temp roots) and one remote workspace ref. */
  readonly A: WorkspaceRuntimeRef;
  readonly B: WorkspaceRuntimeRef;
  readonly C: WorkspaceRuntimeRef;
}

async function makeEnv(options?: { catalog?: { id: string; root: string }[] }): Promise<Env> {
  const homeDir = await mkdtemp(join(tmpdir(), 'wsreg-home-'));
  const rootA = await mkdtemp(join(tmpdir(), 'wsreg-a-'));
  const rootB = await mkdtemp(join(tmpdir(), 'wsreg-b-'));
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  });
  const registry = new SessionHostRuntimeRegistry();
  const manager = new WorkspaceRuntimeManagerService(
    registry,
    { homeDir } as IBootstrapService,
    new FileStorageService(homeDir, 0o700, 0o600),
    stubWorkspaceService(options?.catalog ?? []),
    new HostFileSystem(),
    new HostProcessService(),
    new HostTerminalService(),
    new HostFsWatchService(),
    new HostEnvironmentService(),
  );
  const facade = new WorkspaceSessionServiceImpl(manager);
  const remoteProvider = new FakeRemoteWorkspaceProvider();
  manager.registerProvider('remote', remoteProvider);
  return {
    homeDir,
    registry,
    manager,
    facade,
    remoteProvider,
    A: { workspaceId: 'wd_a', root: rootA },
    B: { workspaceId: 'wd_b', root: rootB },
    C: { workspaceId: 'wd_c', root: '/remote/c' },
  };
}

describe('WorkspaceRuntimeManagerService registration (plan §7.7)', () => {
  it('opens the runtime once, registers it, and reuses the registration on later ensures', async () => {
    const env = await makeEnv();
    const first = await env.manager.ensureRegistered(env.A);
    expect(first.id).toBe('local-workspace_wd_a');
    expect(env.registry.get('local-workspace_wd_a')).toBe(first);
    expect(env.manager.getRuntime(env.A.workspaceId)).toBe(first);

    // The second ensure is a pure reuse: same instance, still one registry entry.
    const second = await env.manager.ensureRegistered(env.A);
    expect(second).toBe(first);
    expect(env.registry.list()).toHaveLength(1);
    expect(env.manager.list()).toEqual([
      { workspaceId: 'wd_a', runtimeId: 'local-workspace_wd_a', kind: 'local-workspace' },
    ]);
  });

  it('folds concurrent ensures of one workspace onto a single provider open', async () => {
    const env = await makeEnv();
    const [r1, r2, r3] = await Promise.all([
      env.manager.ensureRegistered(env.A),
      env.manager.ensureRegistered(env.A),
      env.manager.ensureRegistered(env.A),
    ]);
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
    expect(env.registry.list()).toHaveLength(1);
  });

  it('throws session.runtime_not_found from requireRuntime for unknown workspaces', async () => {
    const env = await makeEnv();
    expect(() => env.manager.requireRuntime('wd_missing')).toThrowError(
      expect.objectContaining({ code: 'session.runtime_not_found' }),
    );
    expect(env.manager.getRuntime('wd_missing')).toBeUndefined();
  });

  it('rejects an unknown provider kind and duplicate provider kinds', async () => {
    const env = await makeEnv();
    await expect(env.manager.ensureRegistered(env.A, { kind: 'bogus' })).rejects.toMatchObject({
      code: 'validation.failed',
    });
    expect(() =>
      env.manager.registerProvider('remote', new FakeRemoteWorkspaceProvider()),
    ).toThrowError(expect.objectContaining({ code: 'validation.failed' }));
  });

  it('unregister blocks new leases, closes live ones, drops routing and retains data', async () => {
    const env = await makeEnv();
    const runtime = await env.manager.ensureRegistered(env.A);
    await env.facade.create(env.A.workspaceId, { sessionId: 's1' });
    const lease = await env.facade.open(env.A.workspaceId, 's1', {});

    await env.manager.unregister(env.A.workspaceId);

    // Routing is gone from both the manager and the host-runtime registry.
    expect(env.manager.getRuntime(env.A.workspaceId)).toBeUndefined();
    expect(env.registry.get(runtime.id)).toBeUndefined();
    expect(runtime.status()).toBe('offline');
    // The live lease was closed with `runtime_lost` (plan §7.7 step 2).
    expect((lease.context as { closedLease?: boolean }).closedLease).toBe(true);
    // New facade calls fail accurately instead of recreating anything.
    await expect(env.facade.get(env.A.workspaceId, 's1')).rejects.toMatchObject({
      code: 'session.runtime_not_found',
    });
    // Session data is retained on disk (unregister never deletes, plan §3.1).
    expect(await readdir(join(env.homeDir, 'sessions', 'wd_a', 's1'))).toEqual(['state.json']);

    // Re-registering the same workspace revives the SAME runtime id, and the
    // retained session opens again (plan §9.2/§9.4).
    const revived = await env.manager.ensureRegistered(env.A);
    expect(revived.id).toBe('local-workspace_wd_a');
    expect(revived).not.toBe(runtime);
    expect(revived.status()).toBe('online');
    const descriptor = await env.facade.get(env.A.workspaceId, 's1');
    expect(descriptor?.ref).toEqual({ runtimeId: 'local-workspace_wd_a', sessionId: 's1' });
    const reopened = await env.facade.open(env.A.workspaceId, 's1', {});
    await reopened.close('explicit');
  });

  it('hosts Local A, Local B and Remote C side by side with accurate routing', async () => {
    const env = await makeEnv();
    const localA = await env.manager.ensureRegistered(env.A);
    const localB = await env.manager.ensureRegistered(env.B);
    const remoteC = await env.manager.ensureRegistered(env.C, { kind: 'remote' });
    expect(remoteC).toBeInstanceOf(FakeRemoteWorkspaceRuntime);

    expect(env.registry.list().map((r) => r.id).sort()).toEqual([
      'local-workspace_wd_a',
      'local-workspace_wd_b',
      'remote-workspace_wd_c',
    ]);

    // Each runtime hosts multiple sessions; ids collide across runtimes on
    // purpose — routing by workspace resolves each one correctly.
    await env.facade.create(env.A.workspaceId, { sessionId: 'same' });
    await env.facade.create(env.A.workspaceId, { sessionId: 'a2' });
    await env.facade.create(env.B.workspaceId, { sessionId: 'same' });
    await env.facade.create(env.C.workspaceId, { sessionId: 'same' });
    await env.facade.create(env.C.workspaceId, { sessionId: 'c2' });

    const listA = await env.facade.list(env.A.workspaceId);
    expect(listA.items.map((d) => d.ref.sessionId).sort()).toEqual(['a2', 'same']);
    expect(listA.items.every((d) => d.ref.runtimeId === localA.id)).toBe(true);
    const listB = await env.facade.list(env.B.workspaceId);
    expect(listB.items.map((d) => d.ref.sessionId)).toEqual(['same']);
    expect(listB.items[0]?.ref.runtimeId).toBe(localB.id);
    const listC = await env.facade.list(env.C.workspaceId);
    expect(listC.items.map((d) => d.ref.sessionId).sort()).toEqual(['c2', 'same']);
    expect(listC.items.every((d) => d.ref.runtimeId === remoteC.id)).toBe(true);

    // The same-named sessions stay isolated across runtimes.
    await env.facade.update(env.A.workspaceId, 'same', { metadata: { title: 'A session' } });
    expect((await env.facade.get(env.B.workspaceId, 'same'))?.metadata['title']).toBeUndefined();
    expect((await env.facade.get(env.A.workspaceId, 'same'))?.metadata['title']).toBe('A session');
  });

  it('ensureDiscovered registers runtimes for on-disk buckets the catalog does not know', async () => {
    const env = await makeEnv();
    const storage = new FileStorageService(env.homeDir, 0o700, 0o600);
    // A bucket whose workspace was never cataloged (or was tombstoned): the
    // root comes back from the session's own metadata document.
    const meta = {
      id: 'legacy1',
      version: 2,
      cwd: '/legacy/root',
      createdAt: 1,
      updatedAt: 2,
      archived: false,
      agents: {},
      custom: {},
    };
    await storage.write('sessions/wd_legacy/legacy1', 'state.json', jsonDocumentCodec.encode(meta), {
      atomic: true,
    });
    // A bucket with no readable metadata is skipped (no root source).
    await storage.write('sessions/wd_orphan/orphan1', 'state.json', new TextEncoder().encode('{{'), {
      atomic: true,
    });

    const runtimes = await env.manager.ensureDiscovered();
    expect(runtimes.map((runtime) => runtime.id)).toEqual(['local-workspace_wd_legacy']);
    expect(env.manager.getRuntime('wd_legacy')).toBe(runtimes[0]);
    expect(env.manager.getRuntime('wd_orphan')).toBeUndefined();

    // The discovered runtime serves the retained session immediately.
    const descriptor = await runtimes[0]?.sessions.get('legacy1');
    expect(descriptor?.ref).toEqual({ runtimeId: 'local-workspace_wd_legacy', sessionId: 'legacy1' });
    expect(descriptor?.metadata['cwd']).toBe('/legacy/root');

    // Repeat calls are pure reuse — no second registration, no provider churn.
    const again = await env.manager.ensureDiscovered();
    expect(again).toHaveLength(1);
    expect(again[0]).toBe(runtimes[0]);
    expect(env.registry.list()).toHaveLength(1);
  });

  it('ensureDiscovered prefers the catalog root over the bucket-recovered one', async () => {
    const rootA = await mkdtemp(join(tmpdir(), 'wsreg-cat-'));
    afterEach(async () => {
      await rm(rootA, { recursive: true, force: true });
    });
    const env = await makeEnv({ catalog: [{ id: 'wd_a', root: rootA }] });
    const storage = new FileStorageService(env.homeDir, 0o700, 0o600);
    // A legacy v1-shaped document (workDir, ISO timestamps, no version): the
    // bucket recovery still finds a root, but the catalog entry wins.
    await storage.write(
      'sessions/wd_a/s1',
      'state.json',
      jsonDocumentCodec.encode({ id: 's1', workDir: '/stale/spelling', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }),
      { atomic: true },
    );

    const runtimes = await env.manager.ensureDiscovered();
    expect(runtimes).toHaveLength(1);
    // The runtime was opened with the catalog root: sessions created through
    // it stamp the catalog spelling, not the stale bucket one.
    const created = await runtimes[0]!.sessions.create({ sessionId: 's2' });
    expect(created.metadata['cwd']).toBe(rootA);
    // … while the pre-existing v1-shaped session reads back normalized.
    const legacy = await runtimes[0]!.sessions.get('s1');
    expect(legacy?.ref.sessionId).toBe('s1');
  });
});

describe('WorkspaceSessionServiceImpl facade (plan §4.2/§9.4)', () => {
  it('delegates the full CRUD/open/resume/fork surface to the registered runtime', async () => {
    const env = await makeEnv();
    const runtime = await env.manager.ensureRegistered(env.A);

    const one = await env.facade.create(env.A.workspaceId, { sessionId: 'one' });
    const two = await env.facade.create(env.A.workspaceId, { sessionId: 'two' });
    // Two internal creates share the runtime id (plan §9.4).
    expect(one.ref.runtimeId).toBe(runtime.id);
    expect(two.ref.runtimeId).toBe(runtime.id);

    expect((await env.facade.get(env.A.workspaceId, 'one'))?.ref.sessionId).toBe('one');
    expect((await env.facade.list(env.A.workspaceId)).items).toHaveLength(2);

    const updated = await env.facade.update(env.A.workspaceId, 'one', {
      metadata: { title: 'renamed' },
    });
    expect(updated.metadata['title']).toBe('renamed');
    expect((await env.facade.get(env.A.workspaceId, 'one'))?.metadata['title']).toBe('renamed');

    const forked = await env.facade.fork(env.A.workspaceId, 'one', { sessionId: 'three' });
    expect(forked.ref.runtimeId).toBe(runtime.id);
    expect((await env.facade.list(env.A.workspaceId)).items).toHaveLength(3);

    const lease = await env.facade.open(env.A.workspaceId, 'two', {});
    expect(lease.ref).toEqual({ runtimeId: runtime.id, sessionId: 'two' });
    // A live lease blocks a second writer (isolation stays the runtime's).
    await expect(env.facade.resume(env.A.workspaceId, 'two', {})).rejects.toMatchObject({
      code: 'session.lease_conflict',
    });
    await lease.close('explicit');
    const resumed = await env.facade.resume(env.A.workspaceId, 'two', {});
    await resumed.close('explicit');

    await env.facade.delete(env.A.workspaceId, 'three');
    expect(await env.facade.get(env.A.workspaceId, 'three')).toBeUndefined();
  });

  it('never opens a provider for ordinary CRUD (spy proof, plan §9.4)', async () => {
    const env = await makeEnv();
    // One sanctioned registration (the v1-create-adapter shape); everything
    // after it must be pure reuse.
    await env.manager.ensureRegistered(env.C, { kind: 'remote' });
    expect(env.remoteProvider.openCalls).toBe(1);

    await env.facade.create(env.C.workspaceId, { sessionId: 's1' });
    await env.facade.create(env.C.workspaceId, { sessionId: 's2' });
    await env.facade.list(env.C.workspaceId);
    await env.facade.get(env.C.workspaceId, 's1');
    await env.facade.update(env.C.workspaceId, 's1', { metadata: { title: 'x' } });
    await env.facade.fork(env.C.workspaceId, 's1', { sessionId: 's3' });
    const lease = await env.facade.open(env.C.workspaceId, 's2', {});
    await lease.close('explicit');
    await env.facade.delete(env.C.workspaceId, 's3');

    // No ordinary operation re-opened the provider or re-registered a runtime.
    expect(env.remoteProvider.openCalls).toBe(1);
    expect(env.registry.list()).toHaveLength(1);
  });

  it('keeps the runtime registered and online when sessions close or are deleted', async () => {
    const env = await makeEnv();
    const runtime = await env.manager.ensureRegistered(env.A);
    await env.facade.create(env.A.workspaceId, { sessionId: 'keep1' });
    await env.facade.create(env.A.workspaceId, { sessionId: 'keep2' });

    const lease = await env.facade.open(env.A.workspaceId, 'keep1', {});
    await lease.close('explicit');
    await env.facade.delete(env.A.workspaceId, 'keep2');

    // Neither closing nor deleting a session touches the registration.
    expect(env.manager.getRuntime(env.A.workspaceId)).toBe(runtime);
    expect(env.registry.get(runtime.id)).toBe(runtime);
    expect(runtime.status()).toBe('online');
    // … and the runtime keeps hosting sessions afterwards.
    await env.facade.create(env.A.workspaceId, { sessionId: 'keep3' });
    expect(
      (await env.facade.list(env.A.workspaceId)).items.map((d) => d.ref.sessionId).sort(),
    ).toEqual(['keep1', 'keep3']);
  });

  it('fails facade calls with session.runtime_not_found for unregistered workspaces', async () => {
    const env = await makeEnv();
    await expect(env.facade.create('wd_never', {})).rejects.toMatchObject({
      code: 'session.runtime_not_found',
    });
    await expect(env.facade.list('wd_never')).rejects.toMatchObject({
      code: 'session.runtime_not_found',
    });
  });

  it('isolates facade-opened leases per session while sharing the runtime (plan §9.3)', async () => {
    const env = await makeEnv();
    await env.manager.ensureRegistered(env.A);
    await env.facade.create(env.A.workspaceId, { sessionId: 'la' });
    await env.facade.create(env.A.workspaceId, { sessionId: 'lb' });

    const leaseA = await env.facade.open(env.A.workspaceId, 'la', {});
    const leaseB = await env.facade.open(env.A.workspaceId, 'lb', {});
    const nsA = leaseA.context.persistence.agentNamespace('main');
    const nsB = leaseB.context.persistence.agentNamespace('main');
    leaseA.context.persistence
      .logs(nsA, jsonDocumentCodec)
      .append(nsA, 'wire.jsonl', { type: 'wire.test', who: 'A' });
    leaseB.context.persistence
      .logs(nsB, jsonDocumentCodec)
      .append(nsB, 'wire.jsonl', { type: 'wire.test', who: 'B' });
    await leaseA.context.flush();
    await leaseA.close('explicit');

    // Closing A leaves B fully writable; the runtime stays up either way.
    expect(env.manager.getRuntime(env.A.workspaceId)?.status()).toBe('online');
    leaseB.context.persistence
      .logs(nsB, jsonDocumentCodec)
      .append(nsB, 'wire.jsonl', { type: 'wire.test', who: 'B2' });
    await leaseB.context.flush();
    await leaseB.close('explicit');

    const coldB = await env.manager.requireRuntime(env.A.workspaceId).sessions.coldRead('lb');
    const records: unknown[] = [];
    for await (const record of coldB.readRecords({ agentId: 'main' })) records.push(record);
    expect(records).toHaveLength(2);
  });
});
