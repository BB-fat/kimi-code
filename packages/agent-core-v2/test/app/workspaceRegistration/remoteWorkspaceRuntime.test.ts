/**
 * M3 tests for the Remote Workspace Runtime fake (plan §4.4) — the Remote
 * branch of `IWorkspaceProvider`.
 *
 * Covers the Remote-fake column of the plan §9.1 contract matrix (multi-session
 * create/CRUD/open/resume/close with namespace and lock isolation, same-runtime
 * fork, cold read, logical export/import) plus the Remote-specific semantics
 * the matrix calls out: one shared connection identity across session leases,
 * capability-gated contributions excluded at lease assembly, network-cut
 * behavior (live leases suspended with `runtime_lost`, every new call fails
 * with `session.runtime_unavailable`, cold read included), reconnect revival
 * under the same runtime id, and the absence of any Local/App fallback.
 * Run with `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/app/workspaceRegistration/remoteWorkspaceRuntime.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';

import { createDecorator } from '#/_base/di/instantiation';
import { SyncDescriptor } from '#/_base/di/descriptors';
import type { ISessionRuntimeContext } from '#/app/sessionHostRuntime/sessionRuntimeContext';
import type { SessionExportEntry } from '#/app/sessionHostRuntime/sessionManager';
import { jsonDocumentCodec } from '#/persistence/backends/node-fs/atomicDocumentStore';

import {
  FakeRemoteWorkspaceProvider,
  FakeRemoteWorkspaceRuntime,
} from '../../harness/remoteWorkspaceRuntime';

const DESCRIPTOR = { root: '/remote/project', workspaceId: 'wd_remote' } as const;

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

async function openRuntime(
  provider = new FakeRemoteWorkspaceProvider(),
): Promise<{ runtime: FakeRemoteWorkspaceRuntime; dispose: () => Promise<void> }> {
  const registration = await provider.open(DESCRIPTOR);
  return {
    runtime: registration.runtime as FakeRemoteWorkspaceRuntime,
    dispose: () => registration.dispose(),
  };
}

type FakeLease = ISessionRuntimeContext & { readonly closedLease: boolean };

async function openLease(
  runtime: FakeRemoteWorkspaceRuntime,
  sessionId: string,
): Promise<FakeLease> {
  return (await runtime.sessions.open(sessionId, {})) as FakeLease;
}

describe('FakeRemoteWorkspaceProvider open (plan §4.1/§4.4)', () => {
  it('returns the complete long-lived registration in one shot', async () => {
    const provider = new FakeRemoteWorkspaceProvider();
    const registration = await provider.open(DESCRIPTOR);
    expect(provider.openCalls).toBe(1);
    expect(registration.workspaceId).toBe('wd_remote');
    const runtime = registration.runtime as FakeRemoteWorkspaceRuntime;
    expect(runtime.id).toBe('remote-workspace_wd_remote');
    expect(runtime.kind).toBe('remote-workspace');
    expect(runtime.workspaceCapabilities).toEqual(new Set(['workspace.remote']));
    expect(runtime.status()).toBe('online');
    expect(registration.runtime.sessions).toBeDefined();

    await registration.dispose();
    expect(runtime.status()).toBe('offline');
    await expect(runtime.sessions.list()).rejects.toMatchObject({
      code: 'session.runtime_unavailable',
    });
  });
});

describe('multi-session hosting over one shared connection (plan §9.1)', () => {
  it('creates many sessions sharing the runtime id with isolated state and locks', async () => {
    const { runtime } = await openRuntime();
    const a = await runtime.sessions.create({ sessionId: 'A' });
    const b = await runtime.sessions.create({ sessionId: 'B' });
    expect(a.ref.runtimeId).toBe(runtime.id);
    expect(b.ref.runtimeId).toBe(runtime.id);

    // Namespace isolation: A's document is invisible to B.
    const leaseA = await openLease(runtime, 'A');
    const leaseB = await openLease(runtime, 'B');
    const nsA = leaseA.persistence.sessionNamespace();
    const nsB = leaseB.persistence.sessionNamespace();
    await leaseA.persistence
      .documents(nsA, jsonDocumentCodec)
      .set(nsA, 'note.json', { who: 'A' });
    expect(
      await leaseB.persistence.documents(nsB, jsonDocumentCodec).get(nsB, 'note.json'),
    ).toBeUndefined();

    // Lock isolation: B's lease does not block A's session roster, but a second
    // writer on A conflicts.
    await expect(runtime.sessions.open('A', {})).rejects.toMatchObject({
      code: 'session.lease_conflict',
    });

    // Every lease points at the SAME shared connection identity (the fake
    // projects it as `os.cwd`).
    expect(leaseA.os?.cwd).toBe(runtime.connection.id);
    expect(leaseB.os?.cwd).toBe(runtime.connection.id);

    // Closing one session leaves the other fully usable; closing the LAST one
    // still keeps the runtime online (plan §5.4).
    await leaseA.close('explicit');
    await leaseB.persistence.documents(nsB, jsonDocumentCodec).set(nsB, 'note.json', { who: 'B' });
    await leaseB.close('explicit');
    expect(runtime.status()).toBe('online');
    await runtime.sessions.create({ sessionId: 'C' });
    expect((await runtime.sessions.list()).items.map((d) => d.ref.sessionId).sort()).toEqual([
      'A',
      'B',
      'C',
    ]);
  });

  it('round-trips update/delete, same-runtime fork, cold read and export/import', async () => {
    const { runtime } = await openRuntime();
    await runtime.sessions.create({ sessionId: 'src', metadata: { title: 'original' } });

    const updated = await runtime.sessions.update('src', { metadata: { title: 'renamed' } });
    expect(updated.metadata['title']).toBe('renamed');

    const forked = await runtime.sessions.fork('src', { sessionId: 'forked' });
    expect(forked.ref.runtimeId).toBe(runtime.id);
    // Fork identity semantics (plan §5.8): the fork gets the `Fork:` default
    // title and `forkedFrom` provenance, not a verbatim metadata copy.
    expect((await runtime.sessions.get('forked'))?.metadata).toMatchObject({
      title: 'Fork: renamed',
      forkedFrom: 'src',
    });

    const cold = await runtime.sessions.coldRead('src');
    expect((await cold.descriptor()).ref.sessionId).toBe('src');

    const exported = await collect(runtime.sessions.export('src'));
    expect(exported.length).toBeGreaterThan(0);
    const imported = await runtime.sessions.import({
      sessionId: 'imported',
      entries: (async function* (): AsyncIterable<SessionExportEntry> {
        yield* exported;
      })(),
    });
    expect(imported.ref).toEqual({ runtimeId: runtime.id, sessionId: 'imported' });

    await runtime.sessions.delete('imported');
    expect(await runtime.sessions.get('imported')).toBeUndefined();
  });

  it('writes and reads artifacts per owner through the remote lease', async () => {
    const { runtime } = await openRuntime();
    await runtime.sessions.create({ sessionId: 'art' });
    const lease = await openLease(runtime, 'art');
    const ref = await lease.artifacts.write(
      { kind: 'agent', agentId: 'main' },
      'result.bin',
      (async function* () {
        yield new TextEncoder().encode('remote-bytes');
      })(),
    );
    expect(ref.runtimeId).toBe(runtime.id);
    expect(ref.sessionId).toBe('art');

    const stream = await lease.coldReader.readArtifact(ref, {
      range: { start: 0, end: 6 },
    });
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) chunks.push(value);
    }
    expect(Buffer.concat(chunks).toString('utf8')).toBe('remote');

    // Owner validation stays the runtime's job (plan §3.6/§9.7).
    await expect(
      lease.coldReader.readArtifact({ ...ref, owner: { kind: 'session' } }),
    ).rejects.toMatchObject({ code: 'artifact.owner_mismatch' });
    await lease.close('explicit');
  });
});

describe('capability-gated contributions (plan §4.4/§7.4)', () => {
  it('excludes contributions whose required capability the runtime does not project', async () => {
    class MarkerService {
      declare readonly _serviceBrand: undefined;
    }
    const svcFs = createDecorator<MarkerService>('svc-fs');
    const svcTerminal = createDecorator<MarkerService>('svc-terminal');
    const svcNone = createDecorator<MarkerService>('svc-none');
    const svcAgentProc = createDecorator<MarkerService>('agent-proc');
    const toolRead = createDecorator<MarkerService>('tool-read');
    const toolPty = createDecorator<MarkerService>('tool-pty');
    const marker = new SyncDescriptor(MarkerService);
    const provider = new FakeRemoteWorkspaceProvider({
      capabilities: new Set(['os.filesystem', 'session.cold_read']),
      contributions: {
        sessionServices: [
          { id: svcFs, descriptor: marker, requires: ['os.filesystem'] },
          { id: svcTerminal, descriptor: marker, requires: ['os.terminal'] },
          { id: svcNone, descriptor: marker, requires: [] },
        ],
        agentServices: [{ id: svcAgentProc, descriptor: marker, requires: ['os.process'] }],
        tools: [
          { id: toolRead, name: 'read_file', descriptor: marker, requires: ['os.filesystem'] },
          { id: toolPty, name: 'run_pty', descriptor: marker, requires: ['os.terminal'] },
        ],
      },
    });
    const { runtime } = await openRuntime(provider);
    await runtime.sessions.create({ sessionId: 'gated' });
    const lease = await openLease(runtime, 'gated');

    expect(lease.contributions.sessionServices.map((s) => s.id)).toEqual([svcFs, svcNone]);
    expect(lease.contributions.agentServices).toEqual([]);
    expect(lease.contributions.tools.map((t) => t.name)).toEqual(['read_file']);
    expect(lease.capabilities.has('os.terminal')).toBe(false);
    await lease.close('explicit');
  });
});

describe('network cut and reconnect (plan §4.4/§9.2)', () => {
  it('suspends live leases and fails every new call while offline, with no fallback', async () => {
    const { runtime } = await openRuntime();
    await runtime.sessions.create({ sessionId: 'live-a' });
    await runtime.sessions.create({ sessionId: 'live-b' });
    const leaseA = await openLease(runtime, 'live-a');
    const leaseB = await openLease(runtime, 'live-b');
    const nsA = leaseA.persistence.sessionNamespace();
    await leaseA.persistence.documents(nsA, jsonDocumentCodec).set(nsA, 'note.json', { ok: 1 });
    await leaseA.flush();

    runtime.connection.disconnect();

    // Existing child leases enter the suspended/failed state (`runtime_lost`).
    await vi.waitFor(() => {
      expect(leaseA.closedLease).toBe(true);
      expect(leaseB.closedLease).toBe(true);
    });
    expect(runtime.status()).toBe('offline');

    // Every new operation fails with session.runtime_unavailable — including a
    // fresh resume and cold read — and never falls back to Local/App storage.
    const unavailable = { code: 'session.runtime_unavailable' };
    await expect(runtime.sessions.create({})).rejects.toMatchObject(unavailable);
    await expect(runtime.sessions.list()).rejects.toMatchObject(unavailable);
    await expect(runtime.sessions.get('live-a')).rejects.toMatchObject(unavailable);
    await expect(runtime.sessions.open('live-a', {})).rejects.toMatchObject(unavailable);
    await expect(runtime.sessions.resume('live-a', {})).rejects.toMatchObject(unavailable);
    await expect(runtime.sessions.coldRead('live-a')).rejects.toMatchObject(unavailable);
    await expect(collect(runtime.sessions.export('live-a'))).rejects.toMatchObject(unavailable);

    // Reconnect under the SAME runtime id: the runtime comes back online, the
    // suspended leases stay closed (a re-open is a fresh lease), and the data
    // written before the cut is intact.
    runtime.connection.reconnect();
    expect(runtime.status()).toBe('online');
    expect(runtime.id).toBe('remote-workspace_wd_remote');
    const revived = await openLease(runtime, 'live-a');
    expect(revived).not.toBe(leaseA);
    expect(
      await revived.persistence
        .documents(nsA, jsonDocumentCodec)
        .get(nsA, 'note.json'),
    ).toEqual({ ok: 1 });
    await revived.close('explicit');
  });

  it('keeps a disposed (unregistered) runtime down across a reconnect', async () => {
    const provider = new FakeRemoteWorkspaceProvider();
    const registration = await provider.open(DESCRIPTOR);
    const runtime = registration.runtime as FakeRemoteWorkspaceRuntime;
    await registration.dispose();
    expect(runtime.status()).toBe('offline');

    runtime.connection.reconnect();
    expect(runtime.status()).toBe('offline');
    await expect(runtime.sessions.list()).rejects.toMatchObject({
      code: 'session.runtime_unavailable',
    });
  });
});
