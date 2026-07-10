import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MASTER_ENV } from '#/app/flag/flagService';
import {
  IAgentSpineService,
  IAgentWireService,
  SpineModel,
  spineClose,
  spineOpen,
  spineRootCompact,
} from '#/index';

import { execEnvServices, logServices, testAgent, type TestAgentContext } from '../harness';

const SPINE_ENV = 'KIMI_CODE_SPINE';
const MINUTE = 60 * 1000;

const CATALOGUED_PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  model: 'kimi-code',
  baseUrl: 'http://127.0.0.1',
} as const;
const CATALOGUED_MODEL_CAPABILITIES = {
  image_in: true,
  video_in: true,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 256_000,
} as const;

describe('Spine / compaction interaction', () => {
  beforeEach(() => {
    vi.stubEnv(MASTER_ENV, '0');
    vi.stubEnv(SPINE_ENV, '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('routes full compaction into a spine root epoch instead of rebuilding history', async () => {
    vi.useFakeTimers();
    const ctx = testAgent();
    ctx.configure({ provider: CATALOGUED_PROVIDER, modelCapabilities: CATALOGUED_MODEL_CAPABILITIES });

    vi.setSystemTime(0);
    ctx.appendExchange(1, 'old user', 'old assistant', 20);
    ctx.appendExchange(2, 'recent user', 'recent assistant', 80);

    vi.setSystemTime(61 * MINUTE);
    const completed = ctx.once('full_compaction.complete');
    ctx.mockNextResponse({ type: 'text', text: 'Summary.' });
    await ctx.rpc.beginCompaction({});
    await completed;

    const recordTypes = ctx.recordHistory.map((record) => record.type);
    expect(recordTypes).toContain('spine.root_compact');
    expect(recordTypes).not.toContain('context.apply_compaction');

    const state = readSpine(ctx);
    expect(state.rootEpoch).toBe(2);
    expect(state.openStack).toEqual(['2', '2.1']);
    expect(state.epochMemoryAt).toBeDefined();

    const lastMessage = ctx.context.get().at(-1);
    expect(lastMessage?.origin?.kind).toBe('compaction_summary');
    expect(textOf(lastMessage)).toContain('Summary.');

    const projected = ctx.project();
    expect(projected.some((m) => textOf(m).includes('old assistant'))).toBe(false);
    expect(textOf(projected[0])).toContain('Summary.');
  });

  it('archives the folded-out context and publishes the path on the new epoch node', async () => {
    vi.useFakeTimers();
    const writes = new Map<string, string>();
    const ctx = testAgent(execEnvServices({ hostFs: recordingHostFs(writes) }));
    ctx.configure({ provider: CATALOGUED_PROVIDER, modelCapabilities: CATALOGUED_MODEL_CAPABILITIES });

    vi.setSystemTime(0);
    ctx.appendExchange(1, 'old user', 'old assistant', 20);
    ctx.appendExchange(2, 'recent user', 'recent assistant', 80);

    vi.setSystemTime(61 * MINUTE);
    const completed = ctx.once('full_compaction.complete');
    ctx.mockNextResponse({ type: 'text', text: 'Summary.' });
    await ctx.rpc.beginCompaction({});
    await completed;

    const state = readSpine(ctx);
    const epochNode = state.nodes[String(state.rootEpoch)];
    expect(epochNode?.archivePath).toBeDefined();
    const archivePath = epochNode?.archivePath as string;
    expect(archivePath.endsWith('/2.md')).toBe(true);
    expect(writes.has(archivePath)).toBe(true);
    const content = writes.get(archivePath) ?? '';
    expect(content).toContain('# Spine Root Epoch 2');
    expect(content).toContain('## Epoch Summary');
    expect(content).toContain('Summary.');
    expect(content).toContain('## Trajectory');
    expect(content).toContain('old user');
    expect(content).toContain('old assistant');
    expect(content).toContain('recent user');
    expect(content).toContain('recent assistant');

    expect(ctx.get(IAgentSpineService).renderTree()).toContain(archivePath);
  });

  it('keeps the epoch archive path on the new epoch node through dispatch', () => {
    const ctx = testAgent();
    const wire = ctx.get(IAgentWireService);

    wire.dispatch(
      spineRootCompact({
        epoch: 2,
        epochStartAt: 10,
        epochMemoryAt: 9,
        archivePath: '/work/spine/agent-0/2.md',
      }),
    );

    const state = readSpine(ctx);
    expect(state.nodes['2']?.archivePath).toBe('/work/spine/agent-0/2.md');
    expect(ctx.get(IAgentSpineService).renderTree()).toContain('archive: /work/spine/agent-0/2.md');
  });

  it('completes the root compaction without an archive path when the archive write fails', async () => {
    vi.useFakeTimers();
    const logEntries: Array<{ level: string; message: string }> = [];
    const ctx = testAgent(
      execEnvServices({ hostFs: failingHostFs() }),
      logServices(recordingLogger(logEntries)),
    );
    ctx.configure({ provider: CATALOGUED_PROVIDER, modelCapabilities: CATALOGUED_MODEL_CAPABILITIES });

    vi.setSystemTime(0);
    ctx.appendExchange(1, 'old user', 'old assistant', 20);

    vi.setSystemTime(61 * MINUTE);
    const completed = ctx.once('full_compaction.complete');
    ctx.mockNextResponse({ type: 'text', text: 'Summary.' });
    await ctx.rpc.beginCompaction({});
    await completed;

    const recordTypes = ctx.recordHistory.map((record) => record.type);
    expect(recordTypes).toContain('spine.root_compact');
    expect(recordTypes).toContain('full_compaction.complete');
    const state = readSpine(ctx);
    expect(state.nodes[String(state.rootEpoch)]?.archivePath).toBeUndefined();
    expect(
      logEntries.some(
        (entry) => entry.level === 'warn' && entry.message.toLowerCase().includes('archive'),
      ),
    ).toBe(true);
  });

  it('keeps previous epochs and their archive paths reachable in the tree after a root compaction', () => {
    const ctx = testAgent();
    const wire = ctx.get(IAgentWireService);

    wire.dispatch(spineOpen({ id: '1.1.1', summary: 'task A', parentId: '1.1', openedAt: 0 }));
    wire.dispatch(
      spineClose({
        id: '1.1.1',
        closedAt: 5,
        memory: 'did A',
        archivePath: '/work/spine/agent-0/1-1-1.md',
      }),
    );
    wire.dispatch(spineRootCompact({ epoch: 2, epochStartAt: 10, epochMemoryAt: 9 }));

    const tree = ctx.get(IAgentSpineService).renderTree();

    expect(tree).toContain('1 [closed]');
    expect(tree).toContain('1.1.1');
    expect(tree).toContain('task A');
    expect(tree).toContain('archive: /work/spine/agent-0/1-1-1.md');
    expect(tree).toContain('2 [open]');
  });
});

function readSpine(ctx: TestAgentContext) {
  return ctx.get(IAgentWireService).getModel(SpineModel);
}

function recordingHostFs(writes: Map<string, string>) {
  return {
    writeText: async (path: string, data: string) => {
      writes.set(path, data);
    },
    mkdir: async () => {},
  };
}

function failingHostFs() {
  return {
    writeText: async () => {
      throw new Error('disk full');
    },
    mkdir: async () => {},
  };
}

function recordingLogger(entries: Array<{ level: string; message: string }>) {
  const record = (level: string) => (message: string) => {
    entries.push({ level, message });
  };
  return {
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
  };
}

function textOf(message: { content?: readonly { type: string; text?: string }[] } | undefined): string {
  return (
    message?.content
      ?.map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
      .join('') ?? ''
  );
}
