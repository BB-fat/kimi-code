import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MASTER_ENV } from '#/app/flag/flagService';
import { IAgentProfileCatalogService } from '#/app/agentProfileCatalog/agentProfileCatalog';
import {
  resetUnexpectedErrorHandler,
  setUnexpectedErrorHandler,
} from '#/_base/errors/unexpectedError';
import { Disposable } from '#/_base/di/lifecycle';
import {
  IAgentLoopService,
  type AfterStepContext,
  type BeforeStepContext,
} from '#/agent/loop/loop';
import { ACCEPTED_OUTPUT, toControlResult } from '#/agent/spine/tools/controlResult';
import type { PersistedWireRecord } from '#/agent/wireRecord/wireRecord';
import type { PersistedRecord } from '#/wire/wireService';
import {
  IAgentSpineService,
  IAgentWireRecordService,
  IAgentWireService,
  SPINE_STARTUP_OPENED_AT,
  SpineModel,
  spineClose,
  spineNext,
  spineOpen,
  spineRootCompact,
  spineTruncateRepair,
} from '#/index';
import type { Message } from '#/app/llmProtocol/message';

import {
  agentService,
  execEnvServices,
  InMemoryWireRecordPersistence,
  testAgent,
  type TestAgentContext,
  type TestAgentOptions,
} from '../harness';

const SPINE_ENV = 'KIMI_CODE_SPINE';

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

async function configureLoop(ctx: TestAgentContext): Promise<void> {
  ctx.configure({
    provider: CATALOGUED_PROVIDER,
    modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
  });
  await ctx.rpc.setPermission({ mode: 'yolo' });
}

function recordingHostFs() {
  const writes = new Map<string, string>();
  return {
    writes,
    fs: {
      writeText: async (path: string, data: string) => {
        writes.set(path, data);
      },
      mkdir: async () => {},
    },
  };
}

function loopContext(): TestAgentContext {
  return testAgent(execEnvServices({ hostFs: recordingHostFs().fs }));
}

describe('Spine reducers (via wire)', () => {
  beforeEach(() => {
    vi.stubEnv(MASTER_ENV, '0');
    vi.stubEnv(SPINE_ENV, '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('starts with an open root epoch and startup node', () => {
    const ctx = testAgent();
    const state = readSpine(ctx);
    expect(state.rootEpoch).toBe(1);
    expect(state.openStack).toEqual(['1', '1.1']);
    expect(state.nodes['1']?.children).toEqual(['1.1']);
    expect(state.nodes['1.1']?.closedAt).toBeUndefined();
  });

  it('opens a child under the cursor and tracks parent linkage', () => {
    const ctx = testAgent();
    const wire = ctx.get(IAgentWireService);

    wire.dispatch(spineOpen({ id: '1.1.1', summary: 'task A', parentId: '1.1', openedAt: 0 }));

    const state = readSpine(ctx);
    expect(state.openStack).toEqual(['1', '1.1', '1.1.1']);
    expect(state.nodes['1.1']?.children).toEqual(['1.1.1']);
    expect(state.nodes['1.1.1']?.summary).toBe('task A');
    expect(state.nodes['1.1.1']?.openedAt).toBe(0);
  });

  it('closes the cursor and pops the open stack', () => {
    const ctx = testAgent();
    const wire = ctx.get(IAgentWireService);
    wire.dispatch(spineOpen({ id: '1.1.1', summary: 'task A', parentId: '1.1', openedAt: 0 }));

    const before = readSpine(ctx);
    wire.dispatch(spineClose({ id: '1.1.1', closedAt: 5, memory: 'did A' }));

    const state = readSpine(ctx);
    expect(state.openStack).toEqual(['1', '1.1']);
    expect(state.nodes['1.1.1']?.closedAt).toBe(5);
    expect(state.nodes['1.1.1']?.memory).toBe('did A');
    expect(before).not.toBe(state);
  });

  it('repairs spans and the epoch boundary at a truncation cut', () => {
    const ctx = testAgent();
    const wire = ctx.get(IAgentWireService);
    wire.dispatch(spineOpen({ id: '1.1.1', summary: 'task A', parentId: '1.1', openedAt: 2 }));
    wire.dispatch(spineClose({ id: '1.1.1', closedAt: 9, memory: 'did A' }));
    wire.dispatch(spineOpen({ id: '1.1.2', summary: 'task B', parentId: '1.1', openedAt: 10 }));
    wire.dispatch(spineClose({ id: '1.1.2', closedAt: 14, memory: 'did B' }));
    wire.dispatch(spineOpen({ id: '1.1.3', summary: 'task C', parentId: '1.1', openedAt: 15 }));
    wire.dispatch(spineRootCompact({ epoch: 2, epochStartAt: 20, epochMemoryAt: 19 }));

    wire.dispatch(spineTruncateRepair({ cut: 8 }));

    const state = readSpine(ctx);
    // Straddling span [2, 9]: fold only the surviving prefix.
    expect(state.nodes['1.1.1']?.closedAt).toBe(7);
    // Span fully inside the truncated range: voided (fold-excluded).
    expect(state.nodes['1.1.2']?.openedAt).toBe(SPINE_STARTUP_OPENED_AT);
    // Open span whose start was truncated: restarted at the cut.
    expect(state.nodes['1.1.3']?.openedAt).toBe(8);
    // The cut removed the epoch summary anchor: the boundary falls back to 0
    // (no-loss) so the surviving history stays fully visible.
    expect(state.epochStartAt).toBe(0);
    expect(state.epochMemoryAt).toBeUndefined();
  });

  it('keeps the epoch boundary when the cut stays after it', () => {
    const ctx = testAgent();
    const wire = ctx.get(IAgentWireService);
    wire.dispatch(spineOpen({ id: '1.1.1', summary: 'task A', parentId: '1.1', openedAt: 22 }));
    wire.dispatch(spineClose({ id: '1.1.1', closedAt: 30, memory: 'did A' }));
    wire.dispatch(spineRootCompact({ epoch: 2, epochStartAt: 20, epochMemoryAt: 19 }));
    const before = readSpine(ctx);

    wire.dispatch(spineTruncateRepair({ cut: 25 }));

    const state = readSpine(ctx);
    expect(state.epochStartAt).toBe(20);
    expect(state.epochMemoryAt).toBe(19);
    // Only the straddling span is repaired; the boundary is untouched.
    expect(state.nodes['1.1.1']?.closedAt).toBe(24);
    expect(state).not.toBe(before);
  });

  it('keeps a same-shape state on a repair that changes nothing', () => {
    const ctx = testAgent();
    const wire = ctx.get(IAgentWireService);
    wire.dispatch(spineOpen({ id: '1.1.1', summary: 'task A', parentId: '1.1', openedAt: 2 }));
    const before = readSpine(ctx);

    wire.dispatch(spineTruncateRepair({ cut: 8 }));

    expect(readSpine(ctx)).toBe(before);
  });

  it('rejects closing a root epoch (no-op, same reference)', () => {
    const ctx = testAgent();
    const wire = ctx.get(IAgentWireService);
    const before = readSpine(ctx);

    wire.dispatch(spineClose({ id: '1', closedAt: 5, memory: 'nope' }));

    expect(readSpine(ctx)).toBe(before);
  });

  it('rejects closing a node that is not the cursor', () => {
    const ctx = testAgent();
    const wire = ctx.get(IAgentWireService);
    wire.dispatch(spineOpen({ id: '1.1.1', summary: 'task A', parentId: '1.1', openedAt: 0 }));
    const before = readSpine(ctx);

    wire.dispatch(spineClose({ id: '1.1', closedAt: 5, memory: 'nope' }));

    expect(readSpine(ctx)).toBe(before);
  });

  it('commits next atomically (close cursor, open sibling under the same parent)', () => {
    const ctx = testAgent();
    const wire = ctx.get(IAgentWireService);
    wire.dispatch(spineOpen({ id: '1.1.1', summary: 'task A', parentId: '1.1', openedAt: 0 }));

    wire.dispatch(
      spineNext({
        closedId: '1.1.1',
        closedAt: 5,
        memory: 'did A',
        openedId: '1.1.2',
        summary: 'task B',
      }),
    );

    const state = readSpine(ctx);
    expect(state.openStack).toEqual(['1', '1.1', '1.1.2']);
    expect(state.nodes['1.1.1']?.closedAt).toBe(5);
    expect(state.nodes['1.1.1']?.memory).toBe('did A');
    expect(state.nodes['1.1.2']?.summary).toBe('task B');
    expect(state.nodes['1.1.2']?.openedAt).toBe(5);
    expect(state.nodes['1.1']?.children).toEqual(['1.1.1', '1.1.2']);
  });

  it('rejects opening under a parent that is not the cursor', () => {
    const ctx = testAgent();
    const wire = ctx.get(IAgentWireService);
    const before = readSpine(ctx);

    wire.dispatch(spineOpen({ id: '1.2', summary: 'task X', parentId: '1', openedAt: 0 }));

    expect(readSpine(ctx)).toBe(before);
  });
});

describe('Spine control tools', () => {
  beforeEach(() => {
    vi.stubEnv(MASTER_ENV, '0');
    vi.stubEnv(SPINE_ENV, '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('registers the four spine tools when enabled', () => {
    const ctx = testAgent();
    const names = spineToolNames(ctx);
    expect(names).toEqual(
      expect.arrayContaining(['spine_open', 'spine_close', 'spine_next', 'spine_tree']),
    );
    expect(names).toHaveLength(4);
  });

  it('default agent profile whitelists the spine tools', () => {
    // The profile's active-tool whitelist gates what reaches the LLM request.
    // If the spine tools are absent here, `profile.isToolActive` filters them
    // out even though they are registered — the model would see `<spine_view>`
    // with no tools to act on. Guards the whitelist entry in `profiles.ts`.
    const ctx = testAgent();
    const profile = ctx.get(IAgentProfileCatalogService).getDefault();
    expect(profile.tools).toEqual(
      expect.arrayContaining(['spine_open', 'spine_close', 'spine_next', 'spine_tree']),
    );
  });

  it('keeps spine tools active under a whitelist that lists them', () => {
    const ctx = testAgent();
    ctx.configure({
      tools: ['Read', 'spine_open', 'spine_close', 'spine_next', 'spine_tree'],
    });
    const spine = ctx.toolsData().filter((tool) => tool.name.startsWith('spine_'));
    expect(spine).toHaveLength(4);
    expect(spine.every((tool) => tool.active)).toBe(true);
  });

  it('a whitelist omitting spine names filters them out of the request', () => {
    // Reproduces the pre-fix defect: the tools stay in the registry but are
    // inactive, so `llmRequester.defaultTools()` excludes them entirely.
    const ctx = testAgent();
    ctx.configure({ tools: ['Read'] });
    const spine = ctx.toolsData().filter((tool) => tool.name.startsWith('spine_'));
    expect(spine).toHaveLength(4);
    expect(spine.some((tool) => tool.active)).toBe(false);
  });

  it('does not register spine tools when disabled', () => {
    vi.stubEnv(SPINE_ENV, '0');
    const ctx = testAgent();
    expect(spineToolNames(ctx)).toHaveLength(0);
  });

  it('commits open then close across steps via the loop', async () => {
    const ctx = loopContext();
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('call_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse(toolCallPart('call_close', 'spine_close', { memory: 'did A' }));
    ctx.mockNextResponse({ type: 'text', text: 'finished' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    const state = readSpine(ctx);
    expect(state.nodes['1.1.1']?.summary).toBe('task A');
    expect(state.nodes['1.1.1']?.closedAt).toBeDefined();
    expect(state.nodes['1.1.1']?.memory).toBe('did A');
    expect(state.openStack).toEqual(['1', '1.1']);
  });

  it('commits a spine transition after an undo shrank the history', async () => {
    // Reproduces the pre-fix defect: undo truncated the context below
    // `lastObservedIndex`, so the next transition's evidence search started
    // past the end of the history, found nothing, and dropped the transition
    // even though the accepted receipt landed in the transcript.
    const ctx = loopContext();
    await configureLoop(ctx);
    for (let i = 0; i < 3; i++) ctx.appendExchange(i + 1, `seed u${i}`, `seed a${i}`, 100);
    ctx.mockNextResponse(toolCallPart('call_open_1', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();
    expect(readSpine(ctx).nodes['1.1.1']?.summary).toBe('task A');

    await ctx.rpc.undoHistory({ count: 1 });

    ctx.mockNextResponse(toolCallPart('call_open_2', 'spine_open', { summary: 'task B' }));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'continue' }] });
    await ctx.untilTurnEnd();

    const state = readSpine(ctx);
    expect(state.nodes['1.1.1.1']?.summary).toBe('task B');
    expect(state.openStack).toEqual(['1', '1.1', '1.1.1', '1.1.1.1']);
  });

  it('keeps post-undo messages out of a truncated closed span', async () => {
    // Reproduces the pre-fix defect: undo cutting into a closed span left its
    // indices dangling; the fold emitted the stale memory at `openedAt` and
    // jumped past the end of the truncated history, swallowing every message
    // appended after the undo — the model never saw the fresh prompt.
    let lastRequestText = '';
    const generate: GenerateFn = async (_provider, _system, _tools, history) => {
      lastRequestText = historyText(history);
      return textResult('answer');
    };
    const ctx = testAgent(execEnvServices({ hostFs: recordingHostFs().fs }), { generate });
    await configureLoop(ctx);
    for (let i = 0; i < 10; i++) ctx.appendExchange(i + 1, `u${String(i)}`, `a${String(i)}`, 100);
    const wire = ctx.get(IAgentWireService);
    wire.dispatch(spineOpen({ id: '1.1.1', parentId: '1.1', summary: 'old work', openedAt: 2 }));
    wire.dispatch(spineClose({ id: '1.1.1', closedAt: 9, memory: 'old memory' }));

    // Cut lands at index 8 — inside the closed span [2, 9].
    await ctx.rpc.undoHistory({ count: 6 });
    expect(readSpine(ctx).nodes['1.1.1']?.closedAt).toBe(7);

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'FRESH-PROMPT-MARKER' }] });
    await ctx.untilTurnEnd();

    expect(lastRequestText).toContain('FRESH-PROMPT-MARKER');
    expect(lastRequestText).toContain('old memory');
  });

  it('keeps the rebuilt history visible after /clear with a dangling epoch boundary', async () => {
    // Reproduces the pre-fix defect: /clear emptied the context while the tree
    // kept its epoch boundary, so the fold dropped every rebuilt message
    // (`i < epochStartAt`) and the model saw nothing but the status line.
    let lastRequestText = '';
    const generate: GenerateFn = async (_provider, _system, _tools, history) => {
      lastRequestText = historyText(history);
      return textResult('answer');
    };
    const ctx = testAgent(execEnvServices({ hostFs: recordingHostFs().fs }), { generate });
    await configureLoop(ctx);
    for (let i = 0; i < 11; i++) ctx.appendExchange(i + 1, `u${String(i)}`, `a${String(i)}`, 100);
    const wire = ctx.get(IAgentWireService);
    wire.dispatch(spineRootCompact({ epoch: 2, epochStartAt: 22, epochMemoryAt: 21 }));

    await ctx.rpc.clearContext({});

    const state = readSpine(ctx);
    expect(state.epochStartAt).toBe(0);
    expect(state.epochMemoryAt).toBeUndefined();
    // The old epochs stay in the tree for their archives.
    expect(state.nodes['2']).toBeDefined();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'AFTER-CLEAR-MARKER' }] });
    await ctx.untilTurnEnd();

    expect(lastRequestText).toContain('AFTER-CLEAR-MARKER');
  });

  it('commits next atomically across a single step', async () => {
    const ctx = loopContext();
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('call_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse(
      toolCallPart('call_next', 'spine_next', { summary: 'task B', memory: 'did A' }),
    );
    ctx.mockNextResponse({ type: 'text', text: 'finished' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    const state = readSpine(ctx);
    expect(state.nodes['1.1.1']?.memory).toBe('did A');
    expect(state.nodes['1.1.2']?.summary).toBe('task B');
    expect(state.openStack.at(-1)).toBe('1.1.2');
  });

  it('rejects a second control tool in the same step', async () => {
    const ctx = loopContext();
    await configureLoop(ctx);
    ctx.mockNextResponse(
      toolCallPart('call_open_1', 'spine_open', { summary: 'task A' }),
      toolCallPart('call_open_2', 'spine_open', { summary: 'task B' }),
    );
    ctx.mockNextResponse({ type: 'text', text: 'finished' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    const state = readSpine(ctx);
    expect(state.nodes['1.1.1']?.summary).toBe('task A');
    expect(state.nodes['1.1.2']).toBeUndefined();

    const rejectedToolMessage = ctx.context
      .get()
      .find((m) => m.role === 'tool' && m.toolCallId === 'call_open_2');
    expect(rejectedToolMessage?.isError).toBe(true);
  });

  it('rejects close memory that references a nonexistent [U#] anchor', async () => {
    const ctx = loopContext();
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('call_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse(
      toolCallPart('call_close', 'spine_close', { memory: 'wrapped up per [U9]' }),
    );
    ctx.mockNextResponse({ type: 'text', text: 'finished' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    const state = readSpine(ctx);
    expect(state.nodes['1.1.1']?.closedAt).toBeUndefined();
    const rejectedToolMessage = ctx.context
      .get()
      .find((m) => m.role === 'tool' && m.toolCallId === 'call_close');
    expect(rejectedToolMessage?.isError).toBe(true);
    expect(textOf(rejectedToolMessage)).toContain('[U9]');
  });

  it('accepts close memory that references an existing [U#] anchor', async () => {
    const ctx = loopContext();
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('call_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse(
      toolCallPart('call_close', 'spine_close', { memory: 'wrapped up per [U1]' }),
    );
    ctx.mockNextResponse({ type: 'text', text: 'finished' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    const state = readSpine(ctx);
    expect(state.nodes['1.1.1']?.closedAt).toBeDefined();
    expect(state.nodes['1.1.1']?.memory).toContain('wrapped up per [U1]');
  });

  it('rejects next memory that references a nonexistent [U#] anchor', async () => {
    const ctx = loopContext();
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('call_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse(
      toolCallPart('call_next', 'spine_next', { summary: 'task B', memory: 'did A per [U7]' }),
    );
    ctx.mockNextResponse({ type: 'text', text: 'finished' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    const state = readSpine(ctx);
    expect(state.nodes['1.1.1']?.closedAt).toBeUndefined();
    expect(state.nodes['1.1.2']).toBeUndefined();
    const rejectedToolMessage = ctx.context
      .get()
      .find((m) => m.role === 'tool' && m.toolCallId === 'call_next');
    expect(rejectedToolMessage?.isError).toBe(true);
    expect(textOf(rejectedToolMessage)).toContain('[U7]');
  });

  it('renders the current tree through spine.tree', async () => {
    const ctx = loopContext();
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('call_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse(toolCallPart('call_tree', 'spine_tree', {}));
    ctx.mockNextResponse({ type: 'text', text: 'finished' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    const treeMessage = ctx.context
      .get()
      .find((m) => m.role === 'tool' && m.toolCallId === 'call_tree');
    const output = textOf(treeMessage);
    expect(output).toContain('1.1.1');
    expect(output).toContain('task A');
    expect(output).toContain('cursor');
  });

  it('maps an accepted transition to the delayed-commit receipt', () => {
    const result = toControlResult({ accepted: true });
    expect(result.isError).toBe(false);
    expect(result.output).toBe(ACCEPTED_OUTPUT);
    expect(result.output).toMatch(/^accepted/);
    expect(result.output).toContain('commit');
  });

  it('returns the delayed-commit receipt as the tool output of an accepted open', async () => {
    const ctx = loopContext();
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('call_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse({ type: 'text', text: 'finished' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    const receipt = ctx.context.get().find((m) => m.role === 'tool' && m.toolCallId === 'call_open');
    expect(receipt?.isError).not.toBe(true);
    expect(textOf(receipt)).toBe(ACCEPTED_OUTPUT);
  });
});

describe('Spine durability', () => {
  beforeEach(() => {
    vi.stubEnv(MASTER_ENV, '0');
    vi.stubEnv(SPINE_ENV, '1');
  });
  afterEach(() => {
    resetUnexpectedErrorHandler();
    vi.unstubAllEnvs();
  });

  it('closes the node, marks its memory, and reports when the archive write fails', async () => {
    const reported: unknown[] = [];
    setUnexpectedErrorHandler((err) => {
      reported.push(err);
    });
    const failingHostFs = {
      writeText: async () => {
        throw new Error('disk full');
      },
      mkdir: async () => {},
    };
    const ctx = testAgent(execEnvServices({ hostFs: failingHostFs }));
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('call_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse(toolCallPart('call_close', 'spine_close', { memory: 'did A' }));
    ctx.mockNextResponse({ type: 'text', text: 'finished' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    const node = readSpine(ctx).nodes['1.1.1'];
    expect(node?.closedAt).toBeDefined();
    expect(node?.archivePath).toBeUndefined();
    expect(node?.memory).toContain('could not be written');
    expect(reported.some((err) => String(err).includes('disk full'))).toBe(true);
  });

  it('reports an accepted receipt that lost its committed op on restore', async () => {
    const records = await recordSpineTurn();
    const stripped = records.filter((record) => record.type !== 'spine.close');

    const reported = await restoreAndCaptureReports(stripped);

    const spineReports = reported.filter((err) => String(err).includes('Spine:'));
    expect(spineReports).toHaveLength(1);
    expect(String(spineReports[0])).toContain('spine_close');
  });

  it('stays quiet on restore when every receipt has its op', async () => {
    const reported = await restoreAndCaptureReports(await recordSpineTurn());

    expect(reported.filter((err) => String(err).includes('Spine:'))).toHaveLength(0);
  });

  it('stays quiet when ops outnumber receipts (a compaction can fold receipts away)', async () => {
    const records = await recordSpineTurn();
    const stripped = records.filter((record) => !isToolResultRecord(record, 'call_close'));

    const reported = await restoreAndCaptureReports(stripped);

    expect(reported.filter((err) => String(err).includes('Spine:'))).toHaveLength(0);
  });

  it('stays quiet on restore for legacy bare-accepted receipts', async () => {
    const records = await recordSpineTurn();
    const legacy = records.map((record) =>
      isToolResultRecord(record, 'call_close') ? withToolResultText(record, 'accepted') : record,
    );

    const reported = await restoreAndCaptureReports(legacy);

    expect(reported.filter((err) => String(err).includes('Spine:'))).toHaveLength(0);
  });

  it('reports a pending transition dropped when its step ends without evidence', async () => {
    const { beforeStep, afterStep, reported, spine } = spineWithCapturedStepHooks();
    await hookOf(beforeStep, 'spine')(beforeCtx(new AbortController().signal), noopNext);
    expect(spine.acceptOpen('task A', 'call_open').accepted).toBe(true);

    await hookOf(afterStep, 'spine')(afterCtx(new AbortController().signal), noopNext);

    expect(reported).toHaveLength(1);
    expect(String(reported[0])).toContain('call_open');

    // The drop cleared the pending transition: the next step stays quiet.
    await hookOf(beforeStep, 'spine')(beforeCtx(new AbortController().signal), noopNext);
    expect(reported).toHaveLength(1);
  });

  it('stays quiet when the dropped transition belonged to an aborted step', async () => {
    const { beforeStep, afterStep, reported, spine } = spineWithCapturedStepHooks();
    const controller = new AbortController();
    await hookOf(beforeStep, 'spine')(beforeCtx(controller.signal), noopNext);
    spine.acceptOpen('task A', 'call_open');
    controller.abort();

    await hookOf(afterStep, 'spine')(afterCtx(controller.signal), noopNext);

    expect(reported).toHaveLength(0);
  });

  it('attributes a leftover pending transition to its owning step across turns', async () => {
    const { beforeStep, reported, spine } = spineWithCapturedStepHooks();
    // Turn 1: the step owning the pending transition aborts before afterStep
    // ever runs (turn-level cancel), leaving the pending behind.
    const controller = new AbortController();
    await hookOf(beforeStep, 'spine')(beforeCtx(controller.signal), noopNext);
    spine.acceptOpen('task A', 'call_open');
    controller.abort();

    // Turn 2: dropping the leftover is routine — quiet.
    await hookOf(beforeStep, 'spine')(beforeCtx(new AbortController().signal), noopNext);
    expect(reported).toHaveLength(0);

    // A leftover from a step that did NOT abort is anomalous — reported.
    spine.acceptOpen('task B', 'call_open_2');
    await hookOf(beforeStep, 'spine')(beforeCtx(new AbortController().signal), noopNext);
    expect(reported).toHaveLength(1);
    expect(String(reported[0])).toContain('call_open_2');
  });
});

function readSpine(ctx: TestAgentContext) {
  return ctx.get(IAgentWireService).getModel(SpineModel);
}

function spineToolNames(ctx: TestAgentContext): string[] {
  return ctx
    .toolsData()
    .map((tool) => tool.name)
    .filter((name) => name.startsWith('spine_'));
}

function toolCallPart(
  id: string,
  name: string,
  args: Record<string, unknown>,
): {
  readonly type: 'function';
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
} {
  return { type: 'function', id, name, arguments: JSON.stringify(args) };
}

type GenerateFn = NonNullable<TestAgentOptions['generate']>;

function textResult(text: string): Awaited<ReturnType<GenerateFn>> {
  return {
    id: 'mock-spine-text',
    message: { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] },
    usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
    finishReason: 'completed',
    rawFinishReason: 'stop',
  };
}

function historyText(history: readonly Message[]): string {
  return history
    .flatMap((message) => message.content)
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function textOf(message: { content?: readonly { type: string; text?: string }[] } | undefined): string {
  return (
    message?.content?.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('') ?? ''
  );
}

async function recordSpineTurn(): Promise<readonly PersistedWireRecord[]> {
  const persistence = new InMemoryWireRecordPersistence();
  const ctx = testAgent({ persistence }, execEnvServices({ hostFs: recordingHostFs().fs }));
  await configureLoop(ctx);
  ctx.mockNextResponse(toolCallPart('call_open', 'spine_open', { summary: 'task A' }));
  ctx.mockNextResponse(toolCallPart('call_close', 'spine_close', { memory: 'did A' }));
  ctx.mockNextResponse({ type: 'text', text: 'finished' });
  await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
  await ctx.untilTurnEnd();
  return persistence.records;
}

async function restoreAndCaptureReports(
  records: readonly PersistedWireRecord[],
): Promise<unknown[]> {
  const reported: unknown[] = [];
  setUnexpectedErrorHandler((err) => {
    reported.push(err);
  });
  try {
    const ctx = testAgent();
    // Force the Eager spine service up so its onRestored audit is registered
    // before the replay fires the restored handlers.
    ctx.get(IAgentSpineService);
    const wireRecord = ctx.get(IAgentWireRecordService);
    await wireRecord.restore(records);
    const restored = wireRecord.getRecords() as readonly PersistedRecord[];
    await ctx.get(IAgentWireService).replay(...restored);
  } finally {
    resetUnexpectedErrorHandler();
  }
  return reported;
}

function isToolResultRecord(record: PersistedWireRecord, toolCallId: string): boolean {
  const r = record as {
    readonly type?: string;
    readonly event?: { readonly type?: string; readonly toolCallId?: string };
  };
  return (
    r.type === 'context.append_loop_event' &&
    r.event?.type === 'tool.result' &&
    r.event?.toolCallId === toolCallId
  );
}

function withToolResultText(record: PersistedWireRecord, text: string): PersistedWireRecord {
  const r = record as {
    readonly event?: { readonly result?: { readonly output?: unknown } };
  };
  if (r.event?.result === undefined) return record;
  return {
    ...record,
    event: { ...r.event, result: { ...r.event.result, output: text } },
  } as unknown as PersistedWireRecord;
}

type BeforeStepHook = (ctx: BeforeStepContext, next: () => Promise<void>) => Promise<void>;
type AfterStepHook = (ctx: AfterStepContext, next: () => Promise<void>) => Promise<void>;

const noopNext = async (): Promise<void> => {};

/**
 * Stand up the spine service against a fake loop that captures the registered
 * step hooks, so tests can drive beforeStep / afterStep by hand instead of
 * racing a real turn.
 */
function spineWithCapturedStepHooks(): {
  readonly beforeStep: Map<string, BeforeStepHook>;
  readonly afterStep: Map<string, AfterStepHook>;
  readonly reported: unknown[];
  readonly spine: IAgentSpineService;
} {
  const beforeStep = new Map<string, BeforeStepHook>();
  const afterStep = new Map<string, AfterStepHook>();
  const fakeLoop = {
    _serviceBrand: undefined,
    run: async () => ({ type: 'completed' as const, steps: 0, truncated: false }),
    hooks: {
      onWillBeginStep: {
        register: (name: string, fn: BeforeStepHook) => {
          beforeStep.set(name, fn);
          return Disposable.None;
        },
      },
      onDidFinishStep: {
        register: (name: string, fn: AfterStepHook) => {
          afterStep.set(name, fn);
          return Disposable.None;
        },
      },
      onError: { register: () => Disposable.None },
    },
    registerLoopErrorHandler: () => Disposable.None,
  } as unknown as IAgentLoopService;
  const reported: unknown[] = [];
  setUnexpectedErrorHandler((err) => {
    reported.push(err);
  });
  const ctx = testAgent(agentService(IAgentLoopService, fakeLoop));
  return { beforeStep, afterStep, reported, spine: ctx.get(IAgentSpineService) };
}

function hookOf<THook>(hooks: Map<string, THook>, name: string): THook {
  const hook = hooks.get(name);
  if (hook === undefined) throw new Error(`hook '${name}' was not registered`);
  return hook;
}

function beforeCtx(signal: AbortSignal): BeforeStepContext {
  return { turnId: 1, step: 1, signal };
}

function afterCtx(signal: AbortSignal): AfterStepContext {
  return { turnId: 1, step: 1, signal } as unknown as AfterStepContext;
}
