import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildCompactionSummaryText,
  createCompactionSummaryMessage,
} from '#/agent/contextMemory/compactionHandoff';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { collectSpanUserRequests } from '#/agent/spine/spineFold';
import { MASTER_ENV } from '#/app/flag/flagService';
import {
  ACCEPTED_OUTPUT,
  AGENT_WIRE_PROTOCOL_VERSION,
  appendSpineView,
  assembleMemoryBody,
  closedChildMemories,
  deriveSpineState,
  IAgentContextSizeService,
  IAgentLLMRequesterService,
  IAgentProfileService,
  IAgentSpineService,
  IAgentWireService,
  loadSpineViewOverride,
  spineClose,
  SpineModel,
  spineNext,
  spineOpen,
  spineRootCompact,
  type PersistedWireRecord,
} from '#/index';

import {
  agentService,
  execEnvServices,
  hostEnvironmentServices,
  InMemoryWireRecordPersistence,
  testAgent,
  wireRecordPersistenceServices,
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
  });

  it('replaces a closed node span with one memory message without mutating storage', () => {
    const ctx = testAgent();
    const idx = buildClosedNodeHistory(ctx);

    const stored = ctx.context.get();
    const folded = fold(ctx);

    expect(stored).toHaveLength(idx.after + 1);
    expect(folded).toHaveLength(6);
    expect(textOf(folded[0])).toContain('[U1]');
    expect(textOf(folded[0])).toContain('start');
    expect(textOf(folded[1])).toContain('<spine_memory>');
    expect(textOf(folded[1])).toContain('did A');
    // The close carrier and its receipt stay visible past the folded span.
    expect(textOf(folded[2])).toContain('calling spine_close');
    expect(textOf(folded[4])).toContain('[U2]');
    expect(textOf(folded[4])).toContain('after');
    expect(textOf(folded[5])).toContain('<spine_status');
    expect(textOf(folded[5])).toContain('cursor="1.1"');
    // No usage anchor in this harness: the projected whole-context number
    // carries the estimate marker, and the raw stored history is contrasted
    // beside it.
    expect(textOf(folded[5])).toMatch(/ raw_context="~\d/);
    expect(textOf(folded[5])).toMatch(/ projected_context="~\d/);
  });

  it('carries the parent goal summary in the status line', () => {
    const ctx = testAgent();
    buildClosedNodeHistory(ctx);

    const status = statusText(fold(ctx));
    expect(status).toContain('cursor="1.1"');
    expect(status).toContain('parent="1"');
    expect(status).toContain('parent_summary="root epoch 1"');
  });

  it('folds only the outermost closed node (no double folding)', () => {
    const ctx = testAgent();
    buildNestedClosedHistory(ctx);

    const folded = fold(ctx);
    const memoryMessages = folded.filter((m) => textOf(m).includes('<spine_memory>'));
    expect(memoryMessages).toHaveLength(1);
    expect(textOf(memoryMessages[0])).toContain('parent mem');
  });

  it('is the identity transform when spine is disabled', () => {
    vi.stubEnv(SPINE_ENV, '0');
    const ctx = testAgent();
    buildClosedNodeHistory(ctx);

    const folded = fold(ctx);
    expect(folded.some((m) => textOf(m).includes('<spine_memory>'))).toBe(false);
    expect(folded.some((m) => textOf(m).includes('<spine_status'))).toBe(false);
  });

  it('folds the projection through the context projector hook', () => {
    const ctx = testAgent();
    buildClosedNodeHistory(ctx);

    const projected = ctx.project();
    expect(projected.some((m) => textOf(m).includes('<spine_memory>'))).toBe(true);
    expect(projected.some((m) => textOf(m).includes('did A'))).toBe(true);
    expect(projected.some((m) => textOf(m).includes('working'))).toBe(false);
  });

  it('leaves the projection untouched when spine is disabled', () => {
    vi.stubEnv(SPINE_ENV, '0');
    const ctx = testAgent();
    buildClosedNodeHistory(ctx);

    const projected = ctx.project();
    expect(projected.some((m) => textOf(m).includes('<spine_memory>'))).toBe(false);
    expect(projected.some((m) => textOf(m).includes('working'))).toBe(true);
  });

  it('drops messages before the current epoch after a root compact', () => {
    const ctx = testAgent();
    buildClosedNodeHistory(ctx);
    append(ctx, createCompactionSummaryMessage(buildCompactionSummaryText('epoch summary')));
    append(ctx, userMessage('new epoch work'));

    const folded = fold(ctx);
    expect(textOf(folded[0])).toBe(buildCompactionSummaryText('epoch summary'));
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
    const view = await loadSpineViewOverride(hostFs, homeDir);

    const spliced = appendSpineView('BASE SYSTEM', view);
    expect(spliced).toContain('CUSTOM SPINE PROTOCOL');
    expect(spliced).not.toContain('Spine-managed');
    expect(spliced.startsWith('BASE SYSTEM')).toBe(true);
  });

  it('carries the override already in the first turn request', async () => {
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

    const ctx = testAgent(hostEnvironmentServices(homeDir), execEnvServices({ hostFs }));
    await configureLoop(ctx);
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hi' }] });
    await ctx.untilTurnEnd();

    // The override load is awaited before the first step assembles its
    // request: the default view must never leak into an early request (a
    // mid-session system-prompt swap would invalidate the prefix cache).
    const systemPrompt = ctx.llmCalls[0]?.systemPrompt ?? '';
    expect(systemPrompt).toContain('CUSTOM SPINE PROTOCOL');
    expect(systemPrompt).not.toContain('Spine-managed');
  });

  it('reports cursor_context as the projected growth since the cursor opened', () => {
    const ctx = testAgent();
    const spine = ctx.get(IAgentSpineService);
    // A sizable pre-open history the baseline must exclude from the delta.
    append(ctx, userMessage('start'));
    append(ctx, assistantText('earlier work '.repeat(40)));
    // Accept records the open baseline, then the carrier and its receipt land.
    expect(spine.acceptOpen('task A').accepted).toBe(true);
    append(ctx, assistantToolCall('c_open', 'spine_open', JSON.stringify({ summary: 'task A' })));
    append(ctx, spineAcceptedReceipt('c_open'));

    const status = statusText(fold(ctx));
    const cursorContext = Number(/cursor_context="~(\d+)"/.exec(status)?.[1]);
    // Only the carrier and its receipt rode in since the baseline; the
    // pre-open history (~130 tokens) must not leak into the budget signal.
    expect(cursorContext).toBeLessThan(60);
  });

  it('derives context_left from the overflow-observed effective max', () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.get(IAgentProfileService).observeMaxContextTokens(100_000);
    append(ctx, userMessage('hi'));

    // The catalogued 256K window clamps to the observed 100K ceiling; the
    // tiny harness history leaves (nearly) the full observed window as
    // headroom instead of ~256K.
    expect(statusText(fold(ctx))).toContain('context_left="~100K"');
  });

  it('renders a closed node cost from its baseline-to-close gauge delta', async () => {
    let sizeNow = 10_000;
    const fakeSize = {
      _serviceBrand: undefined,
      get: () => ({ size: sizeNow, measured: sizeNow, estimated: 0 }),
      rawSize: () => sizeNow,
      measured: () => {},
      latestMeasurement: () => undefined,
    } as unknown as IAgentContextSizeService;
    const ctx = testAgent(agentService(IAgentContextSizeService, fakeSize));
    await configureLoop(ctx);
    // Turn 1: the open accept records the 10K baseline.
    ctx.mockNextResponse(toolCallPart('c_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse({ type: 'text', text: 'opened' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    // Turn 2: the close accept records the 24K high-water mark.
    sizeNow = 24_000;
    ctx.mockNextResponse(toolCallPart('c_close', 'spine_close', { memory: 'mem A' }));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'continue' }] });
    await ctx.untilTurnEnd();

    expect(ctx.get(IAgentSpineService).renderTree()).toContain('1.1.1 [closed, ~14K, archive:');
  });

  it('replaces each sibling of a next-chain with its own memory', () => {
    // `spine.next` opens the new sibling right after the closing span
    // (`openedAt == closedAt + 1`) — the index the fold lands on right after
    // firing the previous span. Regression: only the first sibling folded;
    // every later sibling stayed raw and its memory was never injected.
    const ctx = testAgent();
    append(ctx, userMessage('start'));
    append(ctx, assistantToolCall('o1', 'spine_open', JSON.stringify({ summary: 'task A' })));
    append(ctx, spineAcceptedReceipt('o1'));
    append(ctx, assistantText('A body'));
    append(
      ctx,
      assistantToolCall('n1', 'spine_next', JSON.stringify({ summary: 'task B', memory: 'mem A' })),
    );
    append(ctx, spineAcceptedReceipt('n1'));
    append(ctx, assistantText('B body'));
    append(
      ctx,
      assistantToolCall('n2', 'spine_next', JSON.stringify({ summary: 'task C', memory: 'mem B' })),
    );
    append(ctx, spineAcceptedReceipt('n2'));
    append(ctx, assistantText('C body'));
    append(ctx, assistantToolCall('c1', 'spine_close', JSON.stringify({ memory: 'mem C' })));
    append(ctx, spineAcceptedReceipt('c1'));
    append(ctx, userMessage('finished'));

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
    expect(textOf(folded[6])).toContain('[U2] finished');
  });

  it('folds a closed subtree once at the outermost closed node', () => {
    // Guards the drain change: re-firing nested closed spans would corrupt the
    // projection (double memory injection, wrong [U#] anchors).
    const ctx = testAgent();
    append(ctx, userMessage('start'));
    append(ctx, assistantToolCall('po', 'spine_open', JSON.stringify({ summary: 'parent' })));
    append(ctx, spineAcceptedReceipt('po'));
    append(ctx, assistantToolCall('co', 'spine_open', JSON.stringify({ summary: 'task A' })));
    append(ctx, spineAcceptedReceipt('co'));
    append(ctx, assistantText('A body'));
    append(
      ctx,
      assistantToolCall('n1', 'spine_next', JSON.stringify({ summary: 'task B', memory: 'mem A' })),
    );
    append(ctx, spineAcceptedReceipt('n1'));
    append(ctx, assistantText('B body'));
    append(
      ctx,
      assistantToolCall('n2', 'spine_next', JSON.stringify({ summary: 'task C', memory: 'mem B' })),
    );
    append(ctx, spineAcceptedReceipt('n2'));
    append(ctx, assistantText('C body'));
    append(ctx, assistantToolCall('cc', 'spine_close', JSON.stringify({ memory: 'mem C' })));
    append(ctx, spineAcceptedReceipt('cc'));
    append(ctx, assistantText('parent tail'));
    append(ctx, assistantToolCall('pc', 'spine_close', JSON.stringify({ memory: 'mem parent' })));
    append(ctx, spineAcceptedReceipt('pc'));
    append(ctx, userMessage('final'));

    const folded = fold(ctx);
    const memories = folded.filter((m) => textOf(m).includes('<spine_memory>'));
    expect(memories).toHaveLength(1);
    expect(textOf(memories[0])).toContain('mem parent');
    for (const body of ['A body', 'B body', 'C body', 'parent tail']) {
      expect(folded.some((m) => textOf(m).includes(body))).toBe(false);
    }
    expect(textOf(folded[0])).toContain('[U1] start');
    expect(textOf(folded[4])).toContain('[U2] final');
  });

  it('skips nodes closed before the epoch boundary and still folds post-epoch nodes', () => {
    // A node closed before the root compact belongs to the epoch summary: its
    // memory must not resurface past the boundary, and its span must not pin
    // the fold queue — the post-epoch node behind it must still fold. Both
    // failed when spans only fired on an exact `openedAt` match.
    const ctx = testAgent();
    buildClosedNodeHistory(ctx);
    append(ctx, createCompactionSummaryMessage(buildCompactionSummaryText('epoch summary')));
    append(ctx, userMessage('new epoch work'));
    append(ctx, assistantToolCall('b_open', 'spine_open', JSON.stringify({ summary: 'task B' })));
    append(ctx, spineAcceptedReceipt('b_open'));
    append(ctx, assistantText('B working'));
    append(ctx, assistantToolCall('b_close', 'spine_close', JSON.stringify({ memory: 'did B' })));
    append(ctx, spineAcceptedReceipt('b_close'));
    append(ctx, userMessage('tail'));

    const folded = fold(ctx);
    expect(textOf(folded[0])).toBe(buildCompactionSummaryText('epoch summary'));
    expect(folded.some((m) => textOf(m).includes('did A'))).toBe(false);
    const memories = folded.filter((m) => textOf(m).includes('<spine_memory>'));
    expect(memories).toHaveLength(1);
    expect(textOf(memories[0])).toContain('did B');
    expect(folded.some((m) => textOf(m).includes('B working'))).toBe(false);
    expect(folded.some((m) => textOf(m).includes('new epoch work'))).toBe(true);
    expect(folded.some((m) => textOf(m).includes('tail'))).toBe(true);
  });
});

describe('Spine logical session conformance', () => {
  beforeEach(() => {
    vi.stubEnv(MASTER_ENV, '0');
    vi.stubEnv(SPINE_ENV, '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('projects a basic open-work-close lifecycle end to end', () => {
    const ctx = testAgent();
    replaySession(ctx, [
      { kind: 'user', text: '调研 X' },
      { kind: 'spine_open', id: '1.1.1', summary: '调研 X', parentId: '1.1' },
      { kind: 'assistant', text: 'working on X' },
      { kind: 'tool', id: 'read_1', name: 'Read' },
      { kind: 'spine_close', id: '1.1.1', memory: 'did X' },
      { kind: 'user', text: '下一步' },
    ]);

    // The close carrier and its receipt stay visible in the parent context;
    // everything between the open carrier and the message before the close
    // carrier folds into the memory.
    expect(canonicalProjection(fold(ctx))).toEqual([
      'user: [U1] 调研 X',
      'user (spine_memory): <spine_memory>\ndid X\n</spine_memory>',
      'assistant: calling spine_close',
      `tool: ${ACCEPTED_OUTPUT}`,
      'user: [U2] 下一步',
      'user (spine_status): <spine_status cursor="1.1" summary="startup" parent="1" parent_summary="root epoch 1" cursor_context="~N" context_left="~N" raw_context="~N" projected_context="~N" />',
    ]);
    expectDerivationMatchesOps(ctx);
  });

  it('projects a nested next-chain as one outermost memory', () => {
    const ctx = testAgent();
    replaySession(ctx, [
      { kind: 'user', text: 'start' },
      { kind: 'spine_open', id: '1.1.1', summary: 'parent', parentId: '1.1' },
      { kind: 'assistant', text: 'parent body' },
      { kind: 'spine_open', id: '1.1.1.1', summary: 'child A', parentId: '1.1.1' },
      { kind: 'assistant', text: 'A body' },
      {
        kind: 'spine_next',
        closedId: '1.1.1.1',
        memory: 'mem A',
        openedId: '1.1.1.2',
        summary: 'child B',
      },
      { kind: 'assistant', text: 'B body' },
      { kind: 'spine_close', id: '1.1.1.2', memory: 'mem B' },
      { kind: 'assistant', text: 'parent tail' },
      { kind: 'spine_close', id: '1.1.1', memory: 'mem parent' },
      { kind: 'user', text: 'final' },
    ]);

    expect(canonicalProjection(fold(ctx))).toEqual([
      'user: [U1] start',
      'user (spine_memory): <spine_memory>\n## Child Memory\n\nmem A\n\nmem B\n\n## Node Memory\n\nmem parent\n</spine_memory>',
      'assistant: calling spine_close',
      `tool: ${ACCEPTED_OUTPUT}`,
      'user: [U2] final',
      'user (spine_status): <spine_status cursor="1.1" summary="startup" parent="1" parent_summary="root epoch 1" cursor_context="~N" context_left="~N" raw_context="~N" projected_context="~N" />',
    ]);
    expectDerivationMatchesOps(ctx);
  });

  it('projects an epoch boundary with stable request anchors', () => {
    const ctx = testAgent();
    replaySession(ctx, [
      { kind: 'user', text: 'old request' },
      { kind: 'spine_open', id: '1.1.1', summary: 'epoch-1 task', parentId: '1.1' },
      { kind: 'assistant', text: 'epoch-1 body' },
      { kind: 'spine_close', id: '1.1.1', memory: 'epoch-1 mem' },
      { kind: 'root_compact', epoch: 2, summary: 'epoch summary' },
      { kind: 'user', text: 'new epoch request' },
      { kind: 'spine_open', id: '2.1.1', summary: 'epoch-2 task', parentId: '2.1' },
      { kind: 'assistant', text: 'epoch-2 body' },
      { kind: 'spine_close', id: '2.1.1', memory: 'epoch-2 mem' },
      { kind: 'user', text: 'tail' },
    ]);

    // Pre-epoch requests still consume their ordinals, but the epoch summary
    // is not a user request and consumes none — the surviving requests keep
    // [U2]/[U3].
    expect(canonicalProjection(fold(ctx))).toEqual([
      `user: ${buildCompactionSummaryText('epoch summary')}`,
      'user: [U2] new epoch request',
      'user (spine_memory): <spine_memory>\nepoch-2 mem\n</spine_memory>',
      'assistant: calling spine_close',
      `tool: ${ACCEPTED_OUTPUT}`,
      'user: [U3] tail',
      'user (spine_status): <spine_status cursor="2.1" summary="startup" parent="2" parent_summary="root epoch 2" cursor_context="~N" context_left="~N" raw_context="~N" projected_context="~N" />',
    ]);
    expectDerivationMatchesOps(ctx);
  });
});

describe('Spine derivation from the message stream', () => {
  it('derives the initial state from an empty history', () => {
    const state = deriveSpineState([]);
    expect(state.rootEpoch).toBe(1);
    expect(state.openStack).toEqual(['1', '1.1']);
    expect(state.epochStartAt).toBe(0);
    expect(state.epochMemoryAt).toBeUndefined();
  });

  it('ignores a transition whose receipt is a near-miss of the accepted carrier', () => {
    const state = deriveSpineState([
      userMessage('start'),
      assistantToolCall('c1', 'spine_open', JSON.stringify({ summary: 'task' })),
      toolReceipt('c1', `${ACCEPTED_OUTPUT}.`),
    ]);
    expect(state.openStack).toEqual(['1', '1.1']);
    expect(state.nodes['1.1.1']).toBeUndefined();
  });

  it('honors the legacy bare-accepted receipt from older sessions', () => {
    const state = deriveSpineState([
      userMessage('start'),
      assistantToolCall('c1', 'spine_open', JSON.stringify({ summary: 'task' })),
      toolReceipt('c1', 'accepted'),
    ]);
    expect(state.openStack).toEqual(['1', '1.1', '1.1.1']);
    expect(state.nodes['1.1.1']?.summary).toBe('task');
  });

  it('ignores a transition whose receipt is an error', () => {
    const state = deriveSpineState([
      userMessage('start'),
      assistantToolCall('c1', 'spine_open', JSON.stringify({ summary: 'task' })),
      { ...toolReceipt('c1', ACCEPTED_OUTPUT), isError: true },
    ]);
    expect(state.nodes['1.1.1']).toBeUndefined();
  });

  it('applies only the spine call from a carrier batched with other tool calls', () => {
    // A real assistant response can batch the spine carrier with unrelated
    // tool calls; the derivation must pick the spine call by its accepted
    // receipt and leave the rest alone.
    const state = deriveSpineState([
      userMessage('start'),
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'batching a spine call with a tool call' }],
        toolCalls: [
          {
            type: 'function',
            id: 'c_spine',
            name: 'spine_open',
            arguments: JSON.stringify({ summary: 'task' }),
          },
          { type: 'function', id: 'c_read', name: 'Read', arguments: '{}' },
        ],
      },
      toolReceipt('c_read', 'file contents'),
      toolReceipt('c_spine', ACCEPTED_OUTPUT),
    ]);
    expect(state.openStack).toEqual(['1', '1.1', '1.1.1']);
    expect(state.nodes['1.1.1']?.summary).toBe('task');
  });

  it('ignores a transition with malformed call arguments', () => {
    const state = deriveSpineState([
      userMessage('start'),
      assistantToolCall('c1', 'spine_open', '{not json'),
      toolReceipt('c1', ACCEPTED_OUTPUT),
    ]);
    expect(state.nodes['1.1.1']).toBeUndefined();
  });

  it('ignores a transition with an empty summary', () => {
    const state = deriveSpineState([
      userMessage('start'),
      assistantToolCall('c1', 'spine_open', JSON.stringify({ summary: '   ' })),
      toolReceipt('c1', ACCEPTED_OUTPUT),
    ]);
    expect(state.nodes['1.1.1']).toBeUndefined();
  });

  it('derives undo truncation from the surviving messages alone', () => {
    const messages = [
      userMessage('start'), // 0
      assistantToolCall('c1', 'spine_open', JSON.stringify({ summary: 'task' })), // 1
      toolReceipt('c1', ACCEPTED_OUTPUT), // 2
      assistantText('working'), // 3
      assistantToolCall('c2', 'spine_close', JSON.stringify({ memory: 'done' })), // 4
      toolReceipt('c2', ACCEPTED_OUTPUT), // 5
    ];
    const full = deriveSpineState(messages);
    expect(full.nodes['1.1.1']?.closedAt).toBe(3);
    expect(full.openStack).toEqual(['1', '1.1']);

    const beforeClose = deriveSpineState(messages.slice(0, 4));
    expect(beforeClose.nodes['1.1.1']?.closedAt).toBeUndefined();
    expect(beforeClose.openStack).toEqual(['1', '1.1', '1.1.1']);

    const beforeOpen = deriveSpineState(messages.slice(0, 1));
    expect(beforeOpen.nodes['1.1.1']).toBeUndefined();
    expect(beforeOpen.openStack).toEqual(['1', '1.1']);
  });

  it('derives multiple root epochs from summary messages', () => {
    const state = deriveSpineState([
      userMessage('old'),
      createCompactionSummaryMessage(buildCompactionSummaryText('epoch 1 done')),
      userMessage('mid'),
      createCompactionSummaryMessage(buildCompactionSummaryText('epoch 2 done')),
      userMessage('now'),
    ]);
    expect(state.rootEpoch).toBe(3);
    expect(state.openStack).toEqual(['3', '3.1']);
    expect(state.epochStartAt).toBe(4);
    expect(state.epochMemoryAt).toBe(3);
    expect(state.nodes['1']).toBeDefined();
    expect(state.nodes['2']).toBeDefined();
  });

  it('detects an epoch boundary from the summary prefix when the origin is absent', () => {
    const state = deriveSpineState([
      userMessage('old'),
      compactionSummaryTextMessage(buildCompactionSummaryText('done')),
      userMessage('now'),
    ]);
    expect(state.rootEpoch).toBe(2);
    expect(state.epochMemoryAt).toBe(1);
  });

  it('trusts a non-summary origin over the summary prefix text', () => {
    const state = deriveSpineState([
      userMessage('old'),
      {
        ...compactionSummaryTextMessage(buildCompactionSummaryText('done')),
        origin: { kind: 'user' },
      },
      userMessage('now'),
    ]);
    expect(state.rootEpoch).toBe(1);
  });
});

describe('Spine legacy-op restore compat', () => {
  beforeEach(() => {
    vi.stubEnv(MASTER_ENV, '0');
    vi.stubEnv(SPINE_ENV, '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('derives the same tree as the persisted legacy ops after a restore', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const ctx = testAgent(
      execEnvServices({ hostFs: recordingHostFs(new Map()) }),
      wireRecordPersistenceServices(persistence),
    );
    // An old-style session: the transcript plus the legacy spine ops the
    // pre-derivation commit path persisted alongside it (open anchors at its
    // carrier, close/next end the span right before the carrier).
    replaySession(ctx, [
      { kind: 'user', text: 'epoch-1 request' },
      { kind: 'spine_open', id: '1.1.1', summary: 'task A', parentId: '1.1' },
      { kind: 'assistant', text: 'A body' },
      { kind: 'spine_close', id: '1.1.1', memory: 'mem A' },
      { kind: 'root_compact', epoch: 2, summary: 'epoch summary' },
      { kind: 'user', text: 'epoch-2 request' },
      { kind: 'spine_open', id: '2.1.1', summary: 'task B', parentId: '2.1' },
      { kind: 'assistant', text: 'B body' },
      {
        kind: 'spine_next',
        closedId: '2.1.1',
        memory: 'mem B',
        openedId: '2.1.2',
        summary: 'task C',
      },
      { kind: 'assistant', text: 'C body' },
      { kind: 'spine_close', id: '2.1.2', memory: 'mem C' },
      { kind: 'user', text: 'tail' },
    ]);
    await ctx.get(IAgentWireService).flush();
    await ctx.wireRecord.flush();

    const resumed = testAgent(
      execEnvServices({ hostFs: recordingHostFs(new Map()) }),
      wireRecordPersistenceServices(
        new InMemoryWireRecordPersistence(withMetadata(cloneRecords(persistence.records))),
      ),
    );
    await resumed.restorePersisted();

    // After the persistence round-trip the message stream alone still derives
    // the same tree the persisted legacy ops replay into: the derivation is
    // the single source of truth and the ops are now inert records.
    expect(resumed.get(IAgentSpineService).currentState()).toEqual(
      resumed.get(IAgentWireService).getModel(SpineModel),
    );
  });
});

function recordingHostFs(writes: Map<string, string>) {
  return {
    writeText: async (path: string, data: string) => {
      writes.set(path, data);
    },
    mkdir: async () => {},
  };
}

function cloneRecords<T>(records: readonly T[]): T[] {
  return records.map((record) => structuredClone(record));
}

function withMetadata(records: readonly PersistedWireRecord[]): PersistedWireRecord[] {
  if (records[0]?.type === 'metadata') return [...records];
  return [
    { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
    ...records,
  ];
}

function toolReceipt(toolCallId: string, text: string): ContextMessage {
  return {
    role: 'tool',
    content: [{ type: 'text', text }],
    toolCalls: [],
    toolCallId,
  };
}

function compactionSummaryTextMessage(text: string): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
  };
}

function fold(ctx: TestAgentContext): readonly ContextMessage[] {
  return ctx.get(IAgentSpineService).fold(ctx.context.get()) as readonly ContextMessage[];
}

interface ClosedNodeIndices {
  readonly openCall: number;
  readonly closeResult: number;
  readonly after: number;
}

// The history carries the transitions itself — real call arguments and the
// accepted receipt — so the derivation rebuilds the node from the messages.
function buildClosedNodeHistory(ctx: TestAgentContext): ClosedNodeIndices {
  append(ctx, userMessage('start'));
  const openCall = append(
    ctx,
    assistantToolCall('c_open', 'spine_open', JSON.stringify({ summary: 'task A' })),
  );
  append(ctx, spineAcceptedReceipt('c_open'));
  append(ctx, assistantText('working'));
  append(ctx, assistantToolCall('c_close', 'spine_close', JSON.stringify({ memory: 'did A' })));
  const closeResult = append(ctx, spineAcceptedReceipt('c_close'));
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
  const parentOpen = append(
    ctx,
    assistantToolCall('c_parent_open', 'spine_open', JSON.stringify({ summary: 'parent' })),
  );
  append(ctx, spineAcceptedReceipt('c_parent_open'));
  const childOpen = append(
    ctx,
    assistantToolCall('c_child_open', 'spine_open', JSON.stringify({ summary: 'child' })),
  );
  append(ctx, spineAcceptedReceipt('c_child_open'));
  append(ctx, assistantToolCall('c_child_close', 'spine_close', JSON.stringify({ memory: 'child mem' })));
  const childClose = append(ctx, spineAcceptedReceipt('c_child_close'));
  append(
    ctx,
    assistantToolCall('c_parent_close', 'spine_close', JSON.stringify({ memory: 'parent mem' })),
  );
  const parentClose = append(ctx, spineAcceptedReceipt('c_parent_close'));
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

function assistantToolCall(id: string, name: string, args: string = '{}'): ContextMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: `calling ${name}` }],
    toolCalls: [{ type: 'function', id, name, arguments: args }],
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

function spineAcceptedReceipt(toolCallId: string): ContextMessage {
  return {
    role: 'tool',
    content: [{ type: 'text', text: ACCEPTED_OUTPUT }],
    toolCalls: [],
    toolCallId,
  };
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

function textOf(message: { content?: readonly { type: string; text?: string }[] } | undefined): string {
  return (
    message?.content?.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('') ?? ''
  );
}

function statusText(folded: readonly ContextMessage[]): string {
  return textOf(folded.find((m) => textOf(m).includes('<spine_status')));
}

// --- Logical session fixtures ----------------------------------------------
//
// A host-agnostic session script: plain data (JSON-serializable by
// construction) describing the transcript and the spine transitions, so a
// session can later be shared as a conformance vector across hosts. Replaying
// uses the same context indices spineService commits — open anchors at its
// carrier message, close/next end the span right before the carrier — and the
// canonical projection pins the fold's end-to-end semantics so a reducer
// rewrite must reproduce it exactly.

type LogicalEvent =
  | { readonly kind: 'user'; readonly text: string }
  | { readonly kind: 'assistant'; readonly text: string }
  | { readonly kind: 'tool'; readonly id: string; readonly name: string }
  | {
      readonly kind: 'spine_open';
      readonly id: string;
      readonly summary: string;
      readonly parentId: string;
    }
  | { readonly kind: 'spine_close'; readonly id: string; readonly memory: string }
  | {
      readonly kind: 'spine_next';
      readonly closedId: string;
      readonly memory: string;
      readonly openedId: string;
      readonly summary: string;
    }
  | { readonly kind: 'root_compact'; readonly epoch: number; readonly summary: string };

function replaySession(ctx: TestAgentContext, events: readonly LogicalEvent[]): void {
  const wire = ctx.get(IAgentWireService);
  for (const event of events) {
    switch (event.kind) {
      case 'user':
        append(ctx, userMessage(event.text));
        break;
      case 'assistant':
        append(ctx, assistantText(event.text));
        break;
      case 'tool':
        append(ctx, assistantToolCall(event.id, event.name));
        append(ctx, toolResult(event.id));
        break;
      case 'spine_open': {
        const callId = `open_${event.id}`;
        const carrierAt = append(
          ctx,
          assistantToolCall(callId, 'spine_open', JSON.stringify({ summary: event.summary })),
        );
        append(ctx, spineAcceptedReceipt(callId));
        wire.dispatch(
          spineOpen({
            id: event.id,
            summary: event.summary,
            parentId: event.parentId,
            openedAt: carrierAt,
          }),
        );
        break;
      }
      case 'spine_close': {
        const callId = `close_${event.id}`;
        const carrierAt = append(
          ctx,
          assistantToolCall(callId, 'spine_close', JSON.stringify({ memory: event.memory })),
        );
        append(ctx, spineAcceptedReceipt(callId));
        wire.dispatch(
          spineClose({
            id: event.id,
            closedAt: carrierAt - 1,
            memory: assembleClosingMemory(ctx, event.id, carrierAt - 1, event.memory),
          }),
        );
        break;
      }
      case 'spine_next': {
        const callId = `next_${event.closedId}`;
        const carrierAt = append(
          ctx,
          assistantToolCall(
            callId,
            'spine_next',
            JSON.stringify({ summary: event.summary, memory: event.memory }),
          ),
        );
        append(ctx, spineAcceptedReceipt(callId));
        wire.dispatch(
          spineNext({
            closedId: event.closedId,
            closedAt: carrierAt - 1,
            memory: assembleClosingMemory(ctx, event.closedId, carrierAt - 1, event.memory),
            openedId: event.openedId,
            summary: event.summary,
          }),
        );
        break;
      }
      case 'root_compact': {
        const summaryAt = append(
          ctx,
          createCompactionSummaryMessage(buildCompactionSummaryText(event.summary)),
        );
        wire.dispatch(
          spineRootCompact({
            epoch: event.epoch,
            epochStartAt: ctx.context.get().length,
            epochMemoryAt: summaryAt,
          }),
        );
        break;
      }
    }
  }
}

// Mirrors the service's commit-time assembly so the op-recorded reference
// state carries the same memory body the derivation assembles from the stream.
function assembleClosingMemory(
  ctx: TestAgentContext,
  nodeId: string,
  closedAt: number,
  nodeMemory: string,
): string {
  const state = ctx.get(IAgentWireService).getModel(SpineModel);
  const node = state.nodes[nodeId];
  if (node === undefined) return nodeMemory;
  return assembleMemoryBody({
    userRequests: collectSpanUserRequests(ctx.context.get(), node.openedAt, closedAt),
    childMemories: closedChildMemories(state.nodes, node),
    nodeMemory,
  });
}

// The message stream alone must derive the same tree the ops recorded:
// derivation is the candidate single source of truth, so every fixture pins
// the equivalence the reducer rewrite must preserve.
function expectDerivationMatchesOps(ctx: TestAgentContext): void {
  expect(deriveSpineState(ctx.context.get())).toEqual(
    ctx.get(IAgentWireService).getModel(SpineModel),
  );
}

function canonicalProjection(folded: readonly ContextMessage[]): string[] {
  return folded.map((message) => {
    const variant = message.origin?.kind === 'injection' ? ` (${message.origin.variant})` : '';
    return `${message.role}${variant}: ${normalizeTokenGauges(textOf(message))}`;
  });
}

// Token gauges vary with harness message sizes; the conformance assertion pins
// the projection's shape and text, not its estimates.
function normalizeTokenGauges(text: string): string {
  return text.replaceAll(
    /(cursor_context|context_left|raw_context|projected_context)="~?[\d.]+K?"/g,
    '$1="~N"',
  );
}
