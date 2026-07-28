/**
 * Unit tests for the server-layer cold reader (`services/snapshot`).
 *
 * M5a: the reader resolves the bare id through the v1 `IV1SessionRefResolver`
 * and reads metadata / wire records / blobs through the OWNER runtime's cold
 * reader — never the App home dir. These tests construct `SnapshotReader`
 * with a file-backed fake runtime (`test/helpers/fakeRuntime`) over a real
 * tmp home (`state.json` + `agents/main/wire.jsonl` fixtures), exercising the
 * resolver mapping, the v1 404 conditions (unknown session, unregistered
 * workspace), the `context.*` reduction, the revision-keyed transcript cache,
 * created_at synthesis, blobref rehydration, and `KIMI_SNAPSHOT_*` config
 * parsing without booting a Fastify daemon.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ISessionLifecycleService,
  IWorkspaceRuntimeManager,
  IWorkspaceService,
  type ContextMessage,
} from '@moonshot-ai/agent-core-v2';
import { afterEach, describe, expect, it } from 'vitest';

import {
  loadSnapshotConfig,
  SnapshotNotFoundError,
  SnapshotReader,
  type SnapshotReaderDeps,
} from '../src/services/snapshot';
import { fakeRuntimeHarness } from './helpers/fakeRuntime';

// ─── tiny stubs ───────────────────────────────────────────────────────────

function fakeAccessor(entries: ReadonlyArray<readonly [unknown, unknown]>) {
  const services = new Map<unknown, unknown>(entries);
  return {
    get<T>(id: unknown): T {
      if (!services.has(id)) throw new Error(`unexpected service request: ${String(id)}`);
      return services.get(id) as T;
    },
  };
}

const noopLogger = { info: () => {} };

interface Fixture {
  homeDir: string;
  workspaceId: string;
  workspaces: Map<string, { root: string }>;
  sessionDir: (sid: string) => string;
  reader: SnapshotReader;
  broadcaster: { seq: number; epoch: string; inFlightTurn: unknown };
}

const tmpDirs: string[] = [];

async function makeFixtureAsync(opts?: { cacheLimit?: number }): Promise<Fixture> {
  const homeDir = await mkdtemp(join(tmpdir(), 'kimi-snapshot-reader-'));
  tmpDirs.push(homeDir);
  const workspaceId = 'wd_unittest_012345abcdef';
  const workspaces = new Map([[workspaceId, { root: join(homeDir, 'workspace') }]]);
  const harness = fakeRuntimeHarness(homeDir, { workspaceId });

  const core = {
    accessor: fakeAccessor([
      [
        IWorkspaceService,
        {
          list: async () =>
            [...workspaces].map(([id, w]) => ({
              id,
              root: w.root,
              name: id,
              createdAt: 0,
              lastOpenedAt: 0,
            })),
          get: async (id: string) => {
            const found = workspaces.get(id);
            return found === undefined
              ? undefined
              : { id, root: found.root, name: id, createdAt: 0, lastOpenedAt: 0 };
          },
        },
      ],
      [
        IWorkspaceRuntimeManager,
        {
          list: () => [{ workspaceId, runtimeId: harness.runtime.id, kind: harness.runtime.kind }],
        },
      ],
      // Cold by default — no live handle.
      [ISessionLifecycleService, { get: () => undefined }],
    ]),
  };
  const broadcaster = { seq: 0, epoch: 'ep_unit', inFlightTurn: null };
  const deps: SnapshotReaderDeps = {
    core: core as never,
    broadcaster: {
      getSnapshotState: async () => ({
        seq: broadcaster.seq,
        epoch: broadcaster.epoch,
        inFlightTurn: broadcaster.inFlightTurn as never,
        subagents: [],
      }),
    } as never,
    logger: noopLogger,
    config: { mode: 'auto', timeoutMs: 4000, cacheLimit: opts?.cacheLimit ?? 32 },
    resolver: harness.resolver,
  };
  return {
    homeDir,
    workspaceId,
    workspaces,
    sessionDir: (sid) => join(homeDir, 'sessions', workspaceId, sid),
    reader: new SnapshotReader(deps),
    broadcaster,
  };
}

function userMessage(text: string): ContextMessage {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [] };
}

async function seedSession(
  f: Fixture,
  sid: string,
  opts?: { createdAt?: number; title?: string; rawState?: Record<string, unknown> },
): Promise<void> {
  const createdAt = opts?.createdAt ?? 1700000000000;
  const state = opts?.rawState ?? {
    id: sid,
    version: 2,
    createdAt,
    updatedAt: createdAt,
    archived: false,
    title: opts?.title,
  };
  await mkdir(f.sessionDir(sid), { recursive: true });
  await writeFile(join(f.sessionDir(sid), 'state.json'), JSON.stringify(state), 'utf-8');
}

async function writeWire(sessionDir: string, lines: ReadonlyArray<unknown>): Promise<void> {
  const agentDir = join(sessionDir, 'agents', 'main');
  await mkdir(agentDir, { recursive: true });
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length > 0 ? '\n' : '');
  await writeFile(join(agentDir, 'wire.jsonl'), body, 'utf-8');
}

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

// ─── SnapshotReader.read ──────────────────────────────────────────────────

describe('SnapshotReader.read', () => {
  it('throws SnapshotNotFoundError for an unknown session', async () => {
    const f = await makeFixtureAsync();
    await expect(f.reader.read('sess_missing')).rejects.toBeInstanceOf(SnapshotNotFoundError);
  });

  it('throws SnapshotNotFoundError when the workspace is gone', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_orphan');
    // The catalog no longer holds the workspace: the session stays gettable
    // elsewhere but loses its snapshot (the pre-migration 404 condition).
    f.workspaces.clear();
    await expect(f.reader.read('sess_orphan')).rejects.toBeInstanceOf(SnapshotNotFoundError);
  });

  it('returns empty messages for a session with no wire.jsonl', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_empty');
    const snap = await f.reader.read('sess_empty');
    expect(snap.session.id).toBe('sess_empty');
    expect(snap.session.busy).toBe(false);
    expect(snap.messages.items).toEqual([]);
    expect(snap.messages.has_more).toBe(false);
    expect(snap.in_flight_turn).toBeNull();
    expect(snap.subagents).toEqual([]);
    expect(snap.pending_approvals).toEqual([]);
    expect(snap.as_of_seq).toBe(0);
    expect(snap.epoch).toBe('ep_unit');
  });

  it('builds messages from context.append_message records', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_msgs');
    await writeWire(f.sessionDir('sess_msgs'), [
      { type: 'metadata', protocol_version: '1.4', created_at: 1 },
      { type: 'context.append_message', message: userMessage('one') },
      { type: 'context.append_message', message: userMessage('two') },
    ]);
    const snap = await f.reader.read('sess_msgs');
    expect(snap.messages.items).toHaveLength(2);
    expect(snap.messages.items.map((m) => (m.content[0] as { text: string }).text)).toEqual([
      'one',
      'two',
    ]);
  });

  it('folds v1 context.append_loop_event records into assistant and tool messages', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_loop');
    await writeWire(f.sessionDir('sess_loop'), [
      { type: 'metadata', protocol_version: '1.4', created_at: 1 },
      { type: 'context.append_message', message: userMessage('question') },
      { type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 's1', turnId: '0', step: 1 } },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          uuid: 'p1',
          turnId: '0',
          step: 1,
          stepUuid: 's1',
          part: { type: 'text', text: 'hello' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          uuid: 'c1',
          turnId: '0',
          step: 1,
          stepUuid: 's1',
          toolCallId: 'call_1',
          name: 'Bash',
          args: { command: 'echo hi' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          parentUuid: 'c1',
          toolCallId: 'call_1',
          result: { output: 'hi' },
        },
      },
      { type: 'context.append_loop_event', event: { type: 'step.end', uuid: 's1', turnId: '0', step: 1 } },
    ]);
    const snap = await f.reader.read('sess_loop');
    expect(snap.messages.items.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    const assistant = snap.messages.items[1]!;
    expect((assistant.content[0] as { text: string }).text).toBe('hello');
    const toolUse = assistant.content.find((p) => p.type === 'tool_use') as
      | { tool_call_id: string; tool_name: string }
      | undefined;
    expect(toolUse?.tool_call_id).toBe('call_1');
    expect(toolUse?.tool_name).toBe('Bash');
    const tool = snap.messages.items[2]!;
    expect(tool.role).toBe('tool');
    expect((tool.content[0] as { tool_call_id: string }).tool_call_id).toBe('call_1');
  });

  it('keeps the full history across context.apply_compaction and appends a summary marker', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_compact');
    await writeWire(f.sessionDir('sess_compact'), [
      { type: 'context.append_message', message: userMessage('old-1') },
      { type: 'context.append_message', message: userMessage('old-2') },
      {
        type: 'context.apply_compaction',
        count: 2,
        summary: { role: 'user', content: [{ type: 'text', text: 'summary' }], toolCalls: [] },
      },
      { type: 'context.append_message', message: userMessage('after') },
    ]);
    const snap = await f.reader.read('sess_compact');
    const texts = snap.messages.items.map((m) => (m.content[0] as { text: string }).text);
    expect(texts).toEqual(['old-1', 'old-2', 'summary', 'after']);
    expect(snap.messages.items[2]?.metadata).toEqual({ origin: { kind: 'compaction_summary' } });
  });

  it('keeps the full history across v1-shaped string summary compaction records', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_compact_v1');
    await writeWire(f.sessionDir('sess_compact_v1'), [
      { type: 'context.append_message', message: userMessage('old-1') },
      { type: 'context.append_message', message: userMessage('old-2') },
      {
        type: 'context.apply_compaction',
        summary: 'summary',
        compactedCount: 2,
        tokensBefore: 100,
        tokensAfter: 20,
      },
      { type: 'context.append_message', message: userMessage('after') },
    ]);
    const snap = await f.reader.read('sess_compact_v1');
    const messages = snap.messages.items;
    const texts = messages.map((m) => (m.content[0] as { text: string }).text);
    expect(texts).toEqual(['old-1', 'old-2', 'summary', 'after']);
    expect(messages[2]?.metadata).toEqual({ origin: { kind: 'compaction_summary' } });
  });

  it('keeps compacted-away assistant messages and uses the raw summary as the marker', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_compact_kept_users');
    await writeWire(f.sessionDir('sess_compact_kept_users'), [
      { type: 'context.append_message', message: userMessage('old user') },
      {
        type: 'context.append_message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'old assistant' }],
          toolCalls: [],
        },
      },
      { type: 'context.append_message', message: userMessage('recent user') },
      {
        type: 'context.apply_compaction',
        summary: 'raw summary',
        contextSummary: 'model-facing summary',
        compactedCount: 3,
        tokensBefore: 100,
        tokensAfter: 20,
        keptUserMessageCount: 2,
      },
    ]);
    const snap = await f.reader.read('sess_compact_kept_users');
    const messages = snap.messages.items;
    const texts = messages.map((m) => (m.content[0] as { text: string }).text);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user']);
    expect(texts).toEqual(['old user', 'old assistant', 'recent user', 'raw summary']);
    expect(messages[3]?.metadata).toEqual({ origin: { kind: 'compaction_summary' } });
  });

  it('preserves the pre-compaction assistant reply after a later undo', async () => {
    // Regression: send A, /compact, send B, undo. The snapshot must still show
    // A's assistant reply (compaction folds only the live context; the
    // transcript keeps the full history).
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_compact_undo');
    const assistant = (text: string): ContextMessage => ({
      role: 'assistant',
      content: [{ type: 'text', text }],
      toolCalls: [],
    });
    await writeWire(f.sessionDir('sess_compact_undo'), [
      { type: 'context.append_message', message: userMessage('message A') },
      { type: 'context.append_message', message: assistant('reply A') },
      {
        type: 'context.apply_compaction',
        summary: 'summary text',
        contextSummary: 'model-facing summary',
        compactedCount: 2,
        tokensBefore: 100,
        tokensAfter: 20,
        keptUserMessageCount: 1,
      },
      { type: 'context.append_message', message: userMessage('message B') },
      { type: 'context.append_message', message: assistant('reply B') },
      { type: 'context.undo', count: 1 },
    ]);
    const snap = await f.reader.read('sess_compact_undo');
    const messages = snap.messages.items;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages.map((m) => (m.content[0] as { text: string }).text)).toEqual([
      'message A',
      'reply A',
      'summary text',
    ]);
  });

  it('keeps pre-clear messages in the transcript and lets undo remove the tail', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_ops');
    await writeWire(f.sessionDir('sess_ops'), [
      { type: 'context.append_message', message: userMessage('a') },
      { type: 'context.append_message', message: userMessage('b') },
      { type: 'context.clear' },
      { type: 'context.append_message', message: userMessage('c') },
      { type: 'context.undo', count: 1 },
    ]);
    // /clear keeps prior messages for display; undo removes the post-clear tail (c).
    expect((await f.reader.read('sess_ops')).messages.items.map((m) => (m.content[0] as { text: string }).text)).toEqual(['a', 'b']);
  });

  it('caps the page at 100 and flags has_more', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_paged');
    await writeWire(
      f.sessionDir('sess_paged'),
      Array.from({ length: 150 }, (_, i) => ({
        type: 'context.append_message' as const,
        message: userMessage(`m${i}`),
      })),
    );
    const snap = await f.reader.read('sess_paged');
    expect(snap.messages.items).toHaveLength(100);
    expect(snap.messages.has_more).toBe(true);
    expect((snap.messages.items[0]!.content[0] as { text: string }).text).toBe('m50');
    expect((snap.messages.items.at(-1)!.content[0] as { text: string }).text).toBe('m149');
  });

  it('uses the wire record time as created_at, falling back and clamping to stay increasing', async () => {
    const f = await makeFixtureAsync();
    const createdAt = 1700000000000;
    const t0 = 1700001000000;
    await seedSession(f, 'sess_times', { createdAt });
    await writeWire(f.sessionDir('sess_times'), [
      { type: 'context.append_message', message: userMessage('one'), time: t0 },
      // No time stamp → falls back to createdAt + index, which is earlier than
      // the previous real time and gets clamped to previous + 1.
      { type: 'context.append_message', message: userMessage('two') },
      // A time stamp EARLIER than the previous entry → clamped to previous + 1.
      { type: 'context.append_message', message: userMessage('three'), time: t0 - 5000 },
    ]);
    const snap = await f.reader.read('sess_times');
    expect(snap.messages.items.map((m) => Date.parse(m.created_at))).toEqual([t0, t0 + 1, t0 + 2]);
  });

  it('synthesizes created_at from session createdAt + index when no record carries a time', async () => {
    const f = await makeFixtureAsync();
    const createdAt = 1700000000000;
    await seedSession(f, 'sess_no_times', { createdAt });
    await writeWire(f.sessionDir('sess_no_times'), [
      { type: 'context.append_message', message: userMessage('a') },
      { type: 'context.append_message', message: userMessage('b') },
    ]);
    const snap = await f.reader.read('sess_no_times');
    expect(snap.messages.items.map((m) => Date.parse(m.created_at))).toEqual([
      createdAt,
      createdAt + 1,
    ]);
  });

  it('maps record times by global index across the page offset', async () => {
    const f = await makeFixtureAsync();
    const createdAt = 1700000000000;
    const base = 1700002000000;
    await seedSession(f, 'sess_times_paged', { createdAt });
    await writeWire(
      f.sessionDir('sess_times_paged'),
      Array.from({ length: 102 }, (_, i) => ({
        type: 'context.append_message' as const,
        message: userMessage(`m${i}`),
        time: base + i * 1000,
      })),
    );
    const snap = await f.reader.read('sess_times_paged');
    expect(snap.messages.items).toHaveLength(100);
    // The page starts at global index 2, so the first item carries record[2]'s time.
    expect(Date.parse(snap.messages.items[0]!.created_at)).toBe(base + 2000);
    expect(Date.parse(snap.messages.items.at(-1)!.created_at)).toBe(base + 101 * 1000);
  });

  it('normalizes a v1-layout state.json (ISO timestamps, no id)', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_v1', {
      rawState: {
        title: 'v1 session',
        createdAt: '2026-06-01T10:00:00.000Z',
        updatedAt: '2026-06-01T11:00:00.000Z',
        archived: false,
      },
    });
    const snap = await f.reader.read('sess_v1');
    expect(snap.session.id).toBe('sess_v1');
    expect(snap.session.title).toBe('v1 session');
    expect(Number.isNaN(Date.parse(snap.session.created_at))).toBe(false);
  });

  it('serves repeated reads from the revision-keyed cache', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_cache');
    await writeWire(f.sessionDir('sess_cache'), [
      { type: 'context.append_message', message: userMessage('cached') },
    ]);
    const first = await f.reader.read('sess_cache');
    expect(first.messages.items).toHaveLength(1);
    // Rewrite with identical content — the cache is keyed on the runtime's
    // opaque revision token (`(size, mtimeMs)` locally); just assert stability.
    const second = await f.reader.read('sess_cache');
    expect(second.messages.items.map((m) => (m.content[0] as { text: string }).text)).toEqual([
      'cached',
    ]);
  });

  it('invalidates the cache when the wire shrinks (compaction rewrite)', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_shrink');
    await writeWire(f.sessionDir('sess_shrink'), [
      { type: 'context.append_message', message: userMessage('a') },
      { type: 'context.append_message', message: userMessage('b') },
      { type: 'context.append_message', message: userMessage('c') },
    ]);
    expect((await f.reader.read('sess_shrink')).messages.items).toHaveLength(3);
    await new Promise((r) => setTimeout(r, 20));
    await writeWire(f.sessionDir('sess_shrink'), [
      { type: 'context.append_message', message: userMessage('only-one') },
    ]);
    const snap = await f.reader.read('sess_shrink');
    expect(snap.messages.items).toHaveLength(1);
    expect((snap.messages.items[0]!.content[0] as { text: string }).text).toBe('only-one');
  });

  it('rehydrates blobref media URLs through the runtime cold reader and placeholders missing blobs', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_blob');
    const hash = 'a1b2c3d4e5f60718';
    const blobDir = join(f.sessionDir('sess_blob'), 'agents', 'main', 'blobs');
    await mkdir(blobDir, { recursive: true });
    await writeFile(join(blobDir, hash), Buffer.from([1, 2, 3, 255]), 'binary');
    const mediaMessage = (url: string): ContextMessage => ({
      role: 'user',
      content: [{ type: 'image_url', imageUrl: { url } } as never],
      toolCalls: [],
    });
    await writeWire(f.sessionDir('sess_blob'), [
      { type: 'context.append_message', message: mediaMessage(`blobref:image/png;${hash}`) },
      { type: 'context.append_message', message: mediaMessage('blobref:image/png;0000000000000000') },
    ]);
    const snap = await f.reader.read('sess_blob');
    const urlOf = (index: number): unknown =>
      (snap.messages.items[index]!.content[0] as { source?: { url?: unknown } }).source?.url;
    expect(urlOf(0)).toBe(`data:image/png;base64,${Buffer.from([1, 2, 3, 255]).toString('base64')}`);
    expect(urlOf(1)).toBe('[media missing]');
  });
});

describe('loadSnapshotConfig', () => {
  it('defaults to auto / 4000ms / 32', () => {
    const c = loadSnapshotConfig({});
    expect(c).toEqual({ mode: 'auto', timeoutMs: 4000, cacheLimit: 32 });
  });

  it('parses legacy mode and integer knobs with floors', () => {
    const c = loadSnapshotConfig({
      KIMI_SNAPSHOT_READER: 'legacy',
      KIMI_SNAPSHOT_TIMEOUT_MS: '2500',
      KIMI_SNAPSHOT_CACHE_LIMIT: '0', // below min → default
    });
    expect(c.mode).toBe('legacy');
    expect(c.timeoutMs).toBe(2500);
    expect(c.cacheLimit).toBe(32);
  });

  it('falls back on non-numeric / sub-minimum timeout', () => {
    expect(loadSnapshotConfig({ KIMI_SNAPSHOT_TIMEOUT_MS: 'abc' }).timeoutMs).toBe(4000);
    expect(loadSnapshotConfig({ KIMI_SNAPSHOT_TIMEOUT_MS: '50' }).timeoutMs).toBe(4000);
  });
});
