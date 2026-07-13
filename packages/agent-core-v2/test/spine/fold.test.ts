import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContextMessage } from '#/agent/contextMemory/types';
import { MASTER_ENV } from '#/app/flag/flagService';
import {
  _resetSpineViewOverrideForTests,
  appendSpineView,
  IAgentLLMRequesterService,
  IAgentSpineService,
  IAgentWireService,
  loadSpineViewOverride,
  spineClose,
  spineNext,
  spineOpen,
  spineRootCompact,
} from '#/index';

import {
  execEnvServices,
  hostEnvironmentServices,
  testAgent,
  type TestAgentContext,
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

describe('Spine projection fold', () => {
  beforeEach(() => {
    vi.stubEnv(MASTER_ENV, '0');
    vi.stubEnv(SPINE_ENV, '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    _resetSpineViewOverrideForTests();
  });

  it('replaces a closed node span with one memory message without mutating storage', () => {
    const ctx = testAgent();
    const idx = buildClosedNodeHistory(ctx);
    wireNode(ctx, {
      id: '1.1.1',
      openedAt: idx.openCall,
      closedAt: idx.closeResult,
      memory: 'did A',
    });

    const stored = ctx.context.get();
    const folded = fold(ctx);

    expect(stored).toHaveLength(idx.after + 1);
    expect(folded).toHaveLength(4);
    expect(textOf(folded[0])).toContain('[U1]');
    expect(textOf(folded[0])).toContain('start');
    expect(textOf(folded[1])).toContain('<spine_memory>');
    expect(textOf(folded[1])).toContain('did A');
    expect(textOf(folded[2])).toContain('[U2]');
    expect(textOf(folded[2])).toContain('after');
    expect(textOf(folded[3])).toContain('<spine_status');
    expect(textOf(folded[3])).toContain('cursor="1.1"');
    // No usage anchor in this harness: the projected whole-context number
    // carries the estimate marker, and the raw stored history is contrasted
    // beside it.
    expect(textOf(folded[3])).toMatch(/ raw_context="~\d/);
    expect(textOf(folded[3])).toMatch(/ projected_context="~\d/);
  });

  it('folds only the outermost closed node (no double folding)', () => {
    const ctx = testAgent();
    const idx = buildNestedClosedHistory(ctx);
    const wire = ctx.get(IAgentWireService);
    wire.dispatch(
      spineOpen({ id: '1.1.1', summary: 'parent', parentId: '1.1', openedAt: idx.parentOpen }),
    );
    wire.dispatch(
      spineOpen({ id: '1.1.1.1', summary: 'child', parentId: '1.1.1', openedAt: idx.childOpen }),
    );
    wire.dispatch(spineClose({ id: '1.1.1.1', closedAt: idx.childClose, memory: 'child mem' }));
    wire.dispatch(spineClose({ id: '1.1.1', closedAt: idx.parentClose, memory: 'parent mem' }));

    const folded = fold(ctx);
    const memoryMessages = folded.filter((m) => textOf(m).includes('<spine_memory>'));
    expect(memoryMessages).toHaveLength(1);
    expect(textOf(memoryMessages[0])).toContain('parent mem');
  });

  it('is the identity transform when spine is disabled', () => {
    vi.stubEnv(SPINE_ENV, '0');
    const ctx = testAgent();
    const idx = buildClosedNodeHistory(ctx);
    wireNode(ctx, {
      id: '1.1.1',
      openedAt: idx.openCall,
      closedAt: idx.closeResult,
      memory: 'did A',
    });

    const folded = fold(ctx);
    expect(folded.some((m) => textOf(m).includes('<spine_memory>'))).toBe(false);
    expect(folded.some((m) => textOf(m).includes('<spine_status'))).toBe(false);
  });

  it('folds the projection through the context projector hook', () => {
    const ctx = testAgent();
    const idx = buildClosedNodeHistory(ctx);
    wireNode(ctx, {
      id: '1.1.1',
      openedAt: idx.openCall,
      closedAt: idx.closeResult,
      memory: 'did A',
    });

    const projected = ctx.project();
    expect(projected.some((m) => textOf(m).includes('<spine_memory>'))).toBe(true);
    expect(projected.some((m) => textOf(m).includes('did A'))).toBe(true);
    expect(projected.some((m) => textOf(m).includes('working'))).toBe(false);
  });

  it('leaves the projection untouched when spine is disabled', () => {
    vi.stubEnv(SPINE_ENV, '0');
    const ctx = testAgent();
    const idx = buildClosedNodeHistory(ctx);
    wireNode(ctx, {
      id: '1.1.1',
      openedAt: idx.openCall,
      closedAt: idx.closeResult,
      memory: 'did A',
    });

    const projected = ctx.project();
    expect(projected.some((m) => textOf(m).includes('<spine_memory>'))).toBe(false);
    expect(projected.some((m) => textOf(m).includes('working'))).toBe(true);
  });

  it('drops messages before the current epoch after a root compact', () => {
    const ctx = testAgent();
    const idx = buildClosedNodeHistory(ctx);
    wireNode(ctx, {
      id: '1.1.1',
      openedAt: idx.openCall,
      closedAt: idx.closeResult,
      memory: 'did A',
    });
    const summaryAt = append(ctx, userMessage('epoch summary'));
    const boundaryAt = ctx.context.get().length;
    append(ctx, userMessage('new epoch work'));
    ctx
      .get(IAgentWireService)
      .dispatch(spineRootCompact({ epoch: 2, epochStartAt: boundaryAt, epochMemoryAt: summaryAt }));

    const folded = fold(ctx);
    expect(textOf(folded[0])).toBe('epoch summary');
    expect(folded.some((m) => textOf(m).includes('did A'))).toBe(false);
    expect(folded.some((m) => textOf(m).includes('new epoch work'))).toBe(true);
  });

  it('appends the spine view to the system prompt when enabled', async () => {
    const ctx = testAgent();
    await configureLoop(ctx);
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hi' }] });
    await ctx.untilTurnEnd();

    const systemPrompt = ctx.llmCalls[0]?.systemPrompt ?? '';
    expect(systemPrompt).toContain('<spine_view>');
    expect(systemPrompt).toContain('Spine-managed');
  });

  it('leaves the system prompt untouched when disabled', async () => {
    vi.stubEnv(SPINE_ENV, '0');
    const ctx = testAgent();
    await configureLoop(ctx);
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hi' }] });
    await ctx.untilTurnEnd();

    const systemPrompt = ctx.llmCalls[0]?.systemPrompt ?? '';
    expect(systemPrompt).not.toContain('<spine_view>');
  });

  it('omits the spine view for operation requests even when enabled', async () => {
    // Compaction-style requests carry their own explicit message list and have
    // no use for the tree protocol; the block would only burn tokens.
    const ctx = testAgent();
    await configureLoop(ctx);
    ctx.mockNextResponse({ type: 'text', text: 'summary' });

    const requester = ctx.get(IAgentLLMRequesterService);
    await requester.request({
      messages: [userMessage('summarize this')],
      source: { type: 'operation', requestKind: 'full_compaction' },
    });

    const systemPrompt = ctx.llmCalls.at(-1)?.systemPrompt ?? '';
    expect(systemPrompt).not.toContain('<spine_view>');
  });

  it('omits the spine view when the request tools do not offer spine_open', async () => {
    // Sub-agent whitelists (coder/explore) exclude the spine tools; showing
    // the protocol there asks the model to use tools it does not have.
    const ctx = testAgent();
    await configureLoop(ctx);
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    const requester = ctx.get(IAgentLLMRequesterService);
    await requester.request({
      tools: [{ name: 'Read', description: 'read files', parameters: {} }],
      source: { type: 'turn', turnId: 1 },
    });

    const systemPrompt = ctx.llmCalls.at(-1)?.systemPrompt ?? '';
    expect(systemPrompt).not.toContain('<spine_view>');
  });

  it('appends the spine view when the request tools offer spine_open', async () => {
    const ctx = testAgent();
    await configureLoop(ctx);
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    const requester = ctx.get(IAgentLLMRequesterService);
    await requester.request({
      tools: [{ name: 'spine_open', description: 'open a node', parameters: {} }],
      source: { type: 'turn', turnId: 1 },
    });

    const systemPrompt = ctx.llmCalls.at(-1)?.systemPrompt ?? '';
    expect(systemPrompt).toContain('<spine_view>');
  });

  it('uses a spine_instruction.md override in place of the built-in view', async () => {
    const homeDir = '/home/test';
    const override = '<spine_view>\nCUSTOM SPINE PROTOCOL\n</spine_view>';
    const hostFs = {
      readText: async (path: string) => {
        if (path === `${homeDir}/spine_instruction.md`) return override;
        throw new Error('ENOENT');
      },
      writeText: async () => {},
      mkdir: async () => {},
    };

    testAgent(hostEnvironmentServices(homeDir), execEnvServices({ hostFs }));
    await loadSpineViewOverride(hostFs, homeDir);

    const spliced = appendSpineView('BASE SYSTEM');
    expect(spliced).toContain('CUSTOM SPINE PROTOCOL');
    expect(spliced).not.toContain('Spine-managed');
    expect(spliced.startsWith('BASE SYSTEM')).toBe(true);
  });

  it('replaces each sibling of a next-chain with its own memory', () => {
    // `spine.next` opens the new sibling right after the closing span
    // (`openedAt == closedAt + 1`) — the index the fold lands on right after
    // firing the previous span. Regression: only the first sibling folded;
    // every later sibling stayed raw and its memory was never injected.
    const ctx = testAgent();
    append(ctx, userMessage('start'));
    append(ctx, assistantText('A body 1'));
    append(ctx, toolResult('a_2'));
    append(ctx, assistantText('B body 1'));
    append(ctx, toolResult('b_2'));
    append(ctx, assistantText('C body 1'));
    append(ctx, toolResult('c_2'));
    append(ctx, assistantText('C body 3'));
    append(ctx, userMessage('finished'));

    const wire = ctx.get(IAgentWireService);
    wire.dispatch(spineOpen({ id: '1.1.1', summary: 'task A', parentId: '1.1', openedAt: 1 }));
    wire.dispatch(
      spineNext({
        closedId: '1.1.1',
        closedAt: 3,
        memory: 'mem A',
        openedId: '1.1.2',
        summary: 'task B',
      }),
    );
    wire.dispatch(
      spineNext({
        closedId: '1.1.2',
        closedAt: 5,
        memory: 'mem B',
        openedId: '1.1.3',
        summary: 'task C',
      }),
    );
    wire.dispatch(spineClose({ id: '1.1.3', closedAt: 7, memory: 'mem C' }));

    const folded = fold(ctx);
    const memories = folded.filter((m) => textOf(m).includes('<spine_memory>'));
    expect(memories).toHaveLength(3);
    expect(textOf(memories[0])).toContain('mem A');
    expect(textOf(memories[1])).toContain('mem B');
    expect(textOf(memories[2])).toContain('mem C');
    for (const body of ['A body', 'B body', 'C body']) {
      expect(folded.some((m) => textOf(m).includes(body))).toBe(false);
    }
    expect(textOf(folded[0])).toContain('[U1] start');
    expect(textOf(folded[4])).toContain('[U2] finished');
  });

  it('folds a closed subtree once at the outermost closed node', () => {
    // Guards the drain change: re-firing nested closed spans would corrupt the
    // projection (double memory injection, wrong [U#] anchors).
    const ctx = testAgent();
    append(ctx, userMessage('start'));
    append(ctx, assistantText('A body 1'));
    append(ctx, toolResult('a_2'));
    append(ctx, assistantText('B body 1'));
    append(ctx, toolResult('b_2'));
    append(ctx, assistantText('C body 1'));
    append(ctx, toolResult('c_2'));
    append(ctx, assistantText('C body 3'));
    append(ctx, assistantText('parent tail 1'));
    append(ctx, toolResult('p_2'));
    append(ctx, userMessage('final'));

    const wire = ctx.get(IAgentWireService);
    wire.dispatch(spineOpen({ id: '1.1.1', summary: 'parent', parentId: '1.1', openedAt: 1 }));
    wire.dispatch(spineOpen({ id: '1.1.1.1', summary: 'task A', parentId: '1.1.1', openedAt: 1 }));
    wire.dispatch(
      spineNext({
        closedId: '1.1.1.1',
        closedAt: 3,
        memory: 'mem A',
        openedId: '1.1.1.2',
        summary: 'task B',
      }),
    );
    wire.dispatch(
      spineNext({
        closedId: '1.1.1.2',
        closedAt: 5,
        memory: 'mem B',
        openedId: '1.1.1.3',
        summary: 'task C',
      }),
    );
    wire.dispatch(spineClose({ id: '1.1.1.3', closedAt: 7, memory: 'mem C' }));
    wire.dispatch(spineClose({ id: '1.1.1', closedAt: 9, memory: 'mem parent' }));

    const folded = fold(ctx);
    const memories = folded.filter((m) => textOf(m).includes('<spine_memory>'));
    expect(memories).toHaveLength(1);
    expect(textOf(memories[0])).toContain('mem parent');
    for (const body of ['A body', 'B body', 'C body', 'parent tail']) {
      expect(folded.some((m) => textOf(m).includes(body))).toBe(false);
    }
    expect(textOf(folded[0])).toContain('[U1] start');
    expect(textOf(folded[2])).toContain('[U2] final');
  });

  it('skips nodes closed before the epoch boundary and still folds post-epoch nodes', () => {
    // A node closed before the root compact belongs to the epoch summary: its
    // memory must not resurface past the boundary, and its span must not pin
    // the fold queue — the post-epoch node behind it must still fold. Both
    // failed when spans only fired on an exact `openedAt` match.
    const ctx = testAgent();
    const epochOne = buildClosedNodeHistory(ctx);
    wireNode(ctx, {
      id: '1.1.1.1',
      openedAt: epochOne.openCall,
      closedAt: epochOne.closeResult,
      memory: 'did A',
    });
    const summaryAt = append(ctx, userMessage('epoch summary'));
    const boundaryAt = ctx.context.get().length;
    append(ctx, userMessage('new epoch work'));
    const bOpen = append(ctx, assistantToolCall('b_open', 'spine_open'));
    append(ctx, toolResult('b_open'));
    append(ctx, assistantText('B working'));
    append(ctx, assistantToolCall('b_close', 'spine_close'));
    const bClose = append(ctx, toolResult('b_close'));
    append(ctx, userMessage('tail'));

    const wire = ctx.get(IAgentWireService);
    wire.dispatch(
      spineRootCompact({ epoch: 2, epochStartAt: boundaryAt, epochMemoryAt: summaryAt }),
    );
    wire.dispatch(spineOpen({ id: '2.1.2', summary: 'task B', parentId: '2.1', openedAt: bOpen }));
    wire.dispatch(spineClose({ id: '2.1.2', closedAt: bClose, memory: 'did B' }));

    const folded = fold(ctx);
    expect(textOf(folded[0])).toBe('epoch summary');
    expect(folded.some((m) => textOf(m).includes('did A'))).toBe(false);
    const memories = folded.filter((m) => textOf(m).includes('<spine_memory>'));
    expect(memories).toHaveLength(1);
    expect(textOf(memories[0])).toContain('did B');
    expect(folded.some((m) => textOf(m).includes('B working'))).toBe(false);
    expect(folded.some((m) => textOf(m).includes('new epoch work'))).toBe(true);
    expect(folded.some((m) => textOf(m).includes('tail'))).toBe(true);
  });
});

function fold(ctx: TestAgentContext): readonly ContextMessage[] {
  return ctx.get(IAgentSpineService).fold(ctx.context.get()) as readonly ContextMessage[];
}

function wireNode(
  ctx: TestAgentContext,
  input: { id: string; openedAt: number; closedAt: number; memory: string },
): void {
  const wire = ctx.get(IAgentWireService);
  wire.dispatch(
    spineOpen({ id: input.id, summary: 'task A', parentId: '1.1', openedAt: input.openedAt }),
  );
  wire.dispatch(spineClose({ id: input.id, closedAt: input.closedAt, memory: input.memory }));
}

interface ClosedNodeIndices {
  readonly openCall: number;
  readonly closeResult: number;
  readonly after: number;
}

function buildClosedNodeHistory(ctx: TestAgentContext): ClosedNodeIndices {
  append(ctx, userMessage('start'));
  const openCall = append(ctx, assistantToolCall('c_open', 'spine_open'));
  append(ctx, toolResult('c_open'));
  append(ctx, assistantText('working'));
  append(ctx, assistantToolCall('c_close', 'spine_close'));
  const closeResult = append(ctx, toolResult('c_close'));
  const after = append(ctx, userMessage('after'));
  return { openCall, closeResult, after };
}

interface NestedClosedIndices {
  readonly parentOpen: number;
  readonly childOpen: number;
  readonly childClose: number;
  readonly parentClose: number;
}

function buildNestedClosedHistory(ctx: TestAgentContext): NestedClosedIndices {
  append(ctx, userMessage('start'));
  const parentOpen = append(ctx, assistantToolCall('c_parent_open', 'spine_open'));
  append(ctx, toolResult('c_parent_open'));
  const childOpen = append(ctx, assistantToolCall('c_child_open', 'spine_open'));
  append(ctx, toolResult('c_child_open'));
  append(ctx, assistantToolCall('c_child_close', 'spine_close'));
  const childClose = append(ctx, toolResult('c_child_close'));
  append(ctx, assistantToolCall('c_parent_close', 'spine_close'));
  const parentClose = append(ctx, toolResult('c_parent_close'));
  return { parentOpen, childOpen, childClose, parentClose };
}

async function configureLoop(ctx: TestAgentContext): Promise<void> {
  ctx.configure({
    provider: CATALOGUED_PROVIDER,
    modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
  });
  await ctx.rpc.setPermission({ mode: 'yolo' });
}

function append(ctx: TestAgentContext, message: ContextMessage): number {
  const index = ctx.context.get().length;
  ctx.context.append(message);
  return index;
}

function userMessage(text: string): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin: { kind: 'user' },
  };
}

function assistantText(text: string): ContextMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] };
}

function assistantToolCall(id: string, name: string): ContextMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: `calling ${name}` }],
    toolCalls: [{ type: 'function', id, name, arguments: '{}' }],
  };
}

function toolResult(toolCallId: string): ContextMessage {
  return {
    role: 'tool',
    content: [{ type: 'text', text: `result of ${toolCallId}` }],
    toolCalls: [],
    toolCallId,
  };
}

function textOf(message: { content?: readonly { type: string; text?: string }[] } | undefined): string {
  return (
    message?.content?.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('') ?? ''
  );
}
