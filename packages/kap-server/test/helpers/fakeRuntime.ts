/**
 * Test harness: a file-backed fake `ISessionHostRuntime` plus a real
 * `V1SessionRefResolver` wired onto it.
 *
 * kap-server unit tests seed session fixtures as real files under
 * `<home>/sessions/<ws>/<sid>/` (the legacy layout) and exercise services
 * (`TranscriptService`, `SnapshotReader`, broadcasters) through the v1
 * resolver + owner-runtime cold-reader path. The REAL local layout
 * implementation (`LocalWorkspaceRuntime`) is intentionally not exported
 * from agent-core-v2, so this fake re-implements just enough of the cold
 * read contract for the fixtures: directory-presence existence, `state.json`
 * descriptor metadata, `wire.jsonl` record streaming (torn final line
 * tolerated), `(size, mtimeMs)` record revisions and blob reads.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  SessionHostRuntimeRegistry,
  type ArtifactRef,
  type ColdRecord,
  type ColdRecordQuery,
  type ISessionColdReader,
  type ISessionHostRuntime,
  type ISessionManager,
  type ReadArtifactOptions,
  type SessionDescriptor,
} from '@moonshot-ai/agent-core-v2';

import { V1SessionRefResolver } from '../../src/app/v1Compatibility/v1SessionRefResolver';

export interface FakeRuntimeHarness {
  readonly runtime: ISessionHostRuntime;
  readonly registry: SessionHostRuntimeRegistry;
  readonly resolver: V1SessionRefResolver;
}

interface FakeRuntimeOptions {
  /** Bucket the fixtures live under (the tests' convention: `'ws'`). */
  readonly workspaceId?: string;
  readonly runtimeId?: string;
}

export function fakeRuntimeHarness(homeDir: string, options?: FakeRuntimeOptions): FakeRuntimeHarness {
  const runtimeId = options?.runtimeId ?? 'test-runtime';
  const ws = options?.workspaceId ?? 'ws';
  const sessionDir = (sid: string): string => join(homeDir, 'sessions', ws, sid);

  const readMeta = async (sid: string): Promise<Record<string, unknown>> => {
    try {
      const raw = await readFile(join(sessionDir(sid), 'state.json'), 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  };

  const descriptorFor = async (sid: string): Promise<SessionDescriptor | undefined> => {
    try {
      if (!(await stat(sessionDir(sid))).isDirectory()) return undefined;
    } catch {
      return undefined;
    }
    const meta = await readMeta(sid);
    const epoch = (value: unknown): number => {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      const parsed = Date.parse(String(value));
      return Number.isNaN(parsed) ? 0 : parsed;
    };
    const metadata: Record<string, unknown> = {};
    for (const key of ['title', 'lastPrompt', 'cwd', 'workDir', 'custom', 'agents'] as const) {
      if (meta[key] !== undefined) metadata[key] = meta[key];
    }
    if (metadata['cwd'] === undefined && metadata['workDir'] !== undefined) {
      metadata['cwd'] = metadata['workDir'];
    }
    delete metadata['workDir'];
    return {
      ref: { runtimeId, sessionId: sid },
      createdAt: new Date(epoch(meta['createdAt'])).toISOString(),
      updatedAt: new Date(epoch(meta['updatedAt'])).toISOString(),
      status: meta['archived'] === true ? 'archived' : 'active',
      metadata,
    };
  };

  const coldReaderFor = (sid: string): ISessionColdReader => ({
    descriptor: async () => {
      const descriptor = await descriptorFor(sid);
      if (descriptor === undefined) throw new Error(`session ${sid} does not exist`);
      return descriptor;
    },
    listAgents: async () => [],
    readRecords: async function* (query: ColdRecordQuery): AsyncIterable<ColdRecord> {
      if (query.agentId === undefined) return;
      let raw: string;
      try {
        raw = await readFile(
          join(sessionDir(sid), 'agents', query.agentId, 'wire.jsonl'),
          'utf8',
        );
      } catch {
        return; // No journal (ENOENT) — an empty stream, like the real reader.
      }
      const lines = raw.split('\n');
      for (let i = 0; i < lines.length; i++) {
        let line = lines[i]!;
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line.length === 0) continue;
        let data: unknown;
        try {
          data = JSON.parse(line);
        } catch {
          if (i === lines.length - 1) break; // torn final line
          throw new Error(`wire.jsonl: corrupted line ${i + 1}`);
        }
        const record = data as Record<string, unknown>;
        yield {
          kind: typeof record['type'] === 'string' ? record['type'] : 'unknown',
          timestamp: new Date(0).toISOString(),
          data: record,
        };
      }
    },
    readArtifact: async (ref: ArtifactRef, _options?: ReadArtifactOptions) => {
      const ownerPrefix = ref.owner.kind === 'agent' ? join('agents', ref.owner.agentId) : '';
      const bytes = await readFile(join(sessionDir(sid), ownerPrefix, 'blobs', ref.artifactId));
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(bytes));
          controller.close();
        },
      });
    },
    recordsRevision: async (agentId: string) => {
      try {
        const info = await stat(join(sessionDir(sid), 'agents', agentId, 'wire.jsonl'));
        return `${info.size}:${info.mtimeMs}`;
      } catch {
        return undefined;
      }
    },
  });

  const manager = {
    get: (sid: string) => descriptorFor(sid),
    list: async () => {
      let ids: string[] = [];
      try {
        ids = (await readdir(join(homeDir, 'sessions', ws))).filter(
          (id) => !id.includes('/') && id !== 'session_index.jsonl',
        );
      } catch {
        ids = [];
      }
      const items: SessionDescriptor[] = [];
      for (const id of ids) {
        const descriptor = await descriptorFor(id);
        if (descriptor !== undefined) items.push(descriptor);
      }
      return { items };
    },
    coldRead: async (sid: string) => {
      const descriptor = await descriptorFor(sid);
      if (descriptor === undefined) throw new Error(`session ${sid} does not exist`);
      return coldReaderFor(sid);
    },
  } as unknown as ISessionManager;

  const runtime: ISessionHostRuntime = {
    id: runtimeId,
    kind: 'test-fake',
    sessions: manager,
    status: () => 'online',
    capabilities: () => new Set(),
    close: async () => {},
  };

  const registry = new SessionHostRuntimeRegistry();
  registry.register(runtime);
  const resolver = new V1SessionRefResolver({
    registry,
    ensureDiscovered: async () => {},
  });
  return { runtime, registry, resolver };
}
