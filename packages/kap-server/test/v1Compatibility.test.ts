/**
 * Black-box v1 compatibility tests for the multi-runtime edge (plan §9.2/§9.8):
 * with TWO runtimes hosting the same bare session id, id-targeted routes keep
 * the frozen error envelope (50001, no candidates, no schema additions)
 * instead of silently serving the first match; with the owner runtime
 * offline, "unqueried" is not "not found". Boots a real server and registers
 * a second fake runtime into the live registry.
 *
 * Run with
 * `pnpm --filter @moonshot-ai/kap-server exec vitest run test/v1Compatibility.test.ts`.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ISessionHostRuntimeRegistry,
  type ISessionHostRuntime,
  type ISessionManager,
  type SessionDescriptor,
} from '@moonshot-ai/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: unknown;
}

function fakeRuntime(id: string, sessionIds: readonly string[]): ISessionHostRuntime {
  const descriptorOf = (sessionId: string): SessionDescriptor => ({
    ref: { runtimeId: id, sessionId },
    createdAt: new Date(1).toISOString(),
    updatedAt: new Date(2).toISOString(),
    status: 'active',
    metadata: { cwd: '/elsewhere' },
  });
  return {
    id,
    kind: 'test-fake',
    sessions: {
      get: async (sessionId: string) =>
        sessionIds.includes(sessionId) ? descriptorOf(sessionId) : undefined,
      list: async () => ({ items: sessionIds.map(descriptorOf) }),
    } as unknown as ISessionManager,
    status: () => 'online',
    capabilities: () => new Set(),
    close: async () => {},
  };
}

describe('v1 multi-runtime edge compatibility (plan §1.3/§9.2)', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-v1compat-'));
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as never);
      home = undefined;
    }
  });

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, { headers: authHeaders(server as RunningServer) } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function createSession(cwd: string): Promise<string> {
    const res = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: { ...authHeaders(server as RunningServer), 'content-type': 'application/json' } as never,
      body: JSON.stringify({ metadata: { cwd } }),
    });
    const body = (await res.json()) as Envelope<{ id: string }>;
    expect(body.code).toBe(0);
    return body.data.id;
  }

  it('unique bare ids keep working beside a second registered runtime', async () => {
    const sessionId = await createSession(home as string);
    server?.core.accessor.get(ISessionHostRuntimeRegistry).register(fakeRuntime('fake-other', ['other-session']));

    const got = await getJson<{ id: string }>(`/api/v1/sessions/${sessionId}`);
    expect(got.body.code).toBe(0);
    expect(got.body.data.id).toBe(sessionId);

    const missing = await getJson<null>('/api/v1/sessions/session_missing_000');
    expect(missing.body.code).toBe(40401);
    expect(missing.body.data).toBeNull();
  });

  it('a bare id hosted by two runtimes answers the frozen 50001 envelope (no candidates)', async () => {
    const sessionId = await createSession(home as string);
    // A second runtime claiming the SAME session id: the edge must not pick one.
    server?.core.accessor.get(ISessionHostRuntimeRegistry).register(fakeRuntime('fake-shadow', [sessionId]));

    const got = await getJson<null>(`/api/v1/sessions/${sessionId}`);
    expect(got.body.code).toBe(50001);
    expect(got.body.data).toBeNull();
    const serialized = JSON.stringify(got.body);
    expect(serialized).not.toContain('fake-shadow');
    expect(serialized).not.toContain('local-workspace');
    expect(serialized).not.toContain('identity_ambiguous');

    // Snapshot/tasks resolve the bare id on every read (no live shortcut).
    const snapshot = await getJson<null>(`/api/v1/sessions/${sessionId}/snapshot`);
    expect(snapshot.body.code).toBe(50001);
    const tasks = await getJson<null>(`/api/v1/sessions/${sessionId}/tasks`);
    expect(tasks.body.code).toBe(50001);

    // Transcript answers live sessions from the live store (unchanged live
    // dependency), so the ambiguous mapping is asserted on the COLD path:
    // restart the server so the session drops out of memory.
    await server?.close();
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home as string,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
    server.core.accessor.get(ISessionHostRuntimeRegistry).register(fakeRuntime('fake-shadow', [sessionId]));

    const transcript = await getJson<null>(
      `/api/v1/sessions/${sessionId}/transcript?agent_id=main`,
    );
    expect(transcript.body.code).toBe(50001);
  });
});
