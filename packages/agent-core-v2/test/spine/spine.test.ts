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
import { SPINE_FLAG_ID } from '#/agent/spine/flag';
import { SpineCloseTool } from '#/agent/spine/tools/spine-close';
import { SpineNextTool } from '#/agent/spine/tools/spine-next';
import { SpineOpenTool } from '#/agent/spine/tools/spine-open';
import { SpineTreeTool } from '#/agent/spine/tools/spine-tree';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IFlagService } from '#/app/flag/flag';
import { getToolContributions } from '#/agent/toolRegistry/toolContribution';
import type { ServicesAccessor } from '#/_base/di/instantiation';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { PersistedWireRecord } from '#/agent/wireRecord/wireRecord';
import type { PersistedRecord } from '#/wire/wireService';
import {
  IAgentSpineService,
  IAgentWireRecordService,
  IAgentWireService,
  SPINE_VOID_OPENED_AT,
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
  createCommandRunner,
  execEnvServices,
  InMemoryWireRecordPersistence,
  testAgent,
  type TestAgentContext,
  type TestAgentOptions,
  type TestAgentServiceOverride,
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

  it('closes the startup node like any work node', () => {
    const ctx = testAgent();
    const wire = ctx.get(IAgentWireService);

    wire.dispatch(spineClose({ id: '1.1', closedAt: 3, memory: 'startup done' }));

    const state = readSpine(ctx);
    expect(state.openStack).toEqual(['1']);
    expect(state.nodes['1.1']?.closedAt).toBe(3);
    expect(state.nodes['1.1']?.memory).toBe('startup done');
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
    expect(state.nodes['1.1.2']?.openedAt).toBe(SPINE_VOID_OPENED_AT);
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
    // The sibling opens right after the closing span, at the transition
    // carrier's index.
    expect(state.nodes['1.1.2']?.openedAt).toBe(6);
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

  it('folds a closed startup node memory into the next projection', async () => {
    let lastRequestText = '';
    const generate: GenerateFn = async (_provider, _system, _tools, history) => {
      lastRequestText = historyText(history);
      return textResult('answer');
    };
    const ctx = testAgent(execEnvServices({ hostFs: recordingHostFs().fs }), { generate });
    await configureLoop(ctx);

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'STARTUP-PHASE-PROMPT' }] });
    await ctx.untilTurnEnd();
    ctx
      .get(IAgentWireService)
      .dispatch(
        spineClose({
          id: '1.1',
          closedAt: ctx.context.get().length - 1,
          memory: 'STARTUP-MEMORY-MARKER',
        }),
      );

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'AFTER-STARTUP-CLOSE' }] });
    await ctx.untilTurnEnd();

    expect(lastRequestText).toContain('<spine_memory>');
    expect(lastRequestText).toContain('STARTUP-MEMORY-MARKER');
    expect(lastRequestText).toContain('AFTER-STARTUP-CLOSE');
    expect(lastRequestText).not.toContain('STARTUP-PHASE-PROMPT');
  });

  it('compiles the closing span user requests into the memory body', async () => {
    const ctx = loopContext();
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('call_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse({ type: 'text', text: 'working' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start the work' }] });
    await ctx.untilTurnEnd();

    ctx.mockNextResponse(
      toolCallPart('call_close', 'spine_close', { memory: 'did A per [U2]' }),
    );
    ctx.mockNextResponse({ type: 'text', text: 'finished' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'MID-SPAN-REQUEST' }] });
    await ctx.untilTurnEnd();

    const memory = readSpine(ctx).nodes['1.1.1']?.memory ?? '';
    expect(memory).toContain('## User Message [U2]');
    expect(memory).toContain('MID-SPAN-REQUEST');
    expect(memory).not.toContain('start the work');
    expect(memory).toContain('## Node Memory');
    expect(memory).toContain('did A per [U2]');
  });

  it('keeps [U#] anchors stable when a span folds', async () => {
    let lastRequestText = '';
    const generate: GenerateFn = async (_provider, _system, _tools, history) => {
      lastRequestText = historyText(history);
      return textResult('answer');
    };
    const ctx = testAgent(execEnvServices({ hostFs: recordingHostFs().fs }), { generate });
    await configureLoop(ctx);
    for (let i = 0; i < 5; i++) {
      ctx.appendExchange(i + 1, `seed-u${String(i)}`, `seed-a${String(i)}`, 100);
    }
    const wire = ctx.get(IAgentWireService);
    wire.dispatch(spineOpen({ id: '1.1.1', parentId: '1.1', summary: 'old work', openedAt: 2 }));
    wire.dispatch(spineClose({ id: '1.1.1', closedAt: 5, memory: 'old memory' }));

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'NUMBER-CHECK-PROMPT' }] });
    await ctx.untilTurnEnd();

    expect(lastRequestText).toContain('[U1] seed-u0');
    expect(lastRequestText).toContain('[U4] seed-u3');
    expect(lastRequestText).toContain('[U6] NUMBER-CHECK-PROMPT');
    expect(lastRequestText).toContain('old memory');
    expect(lastRequestText).not.toContain('seed-u1');
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

  it('keeps batched tool results visible and paired after a close', async () => {
    // Reproduces the fold-boundary defect: the response batches an ordinary
    // tool with spine_close, and the instant receipt lands before the
    // ordinary result. Closing at the receipt index folded the carrier
    // assistant message away, leaving the ordinary result an orphan the
    // projector dropped (or an illegal wire when nothing else survived).
    const rec = recordingHostFs();
    const ctx = testAgent(
      execEnvServices({
        hostFs: rec.fs,
        processRunner: createCommandRunner('ORDINARY-RESULT-MARKER'),
      }),
    );
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('call_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse(
      toolCallPart('call_bash', 'Bash', { command: 'true', description: 'noop' }),
      toolCallPart('call_close', 'spine_close', { memory: 'did A' }),
    );
    ctx.mockNextResponse({ type: 'text', text: 'finished' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    const history = ctx.context.get();
    const carrierIndex = history.findIndex(
      (m) => m.role === 'assistant' && m.toolCalls.some((call) => call.id === 'call_close'),
    );
    expect(carrierIndex).toBeGreaterThan(0);
    // The span ends before the carrier, not at the receipt.
    expect(readSpine(ctx).nodes['1.1.1']?.closedAt).toBe(carrierIndex - 1);

    // The carrier and both tool results survive the fold, and every tool
    // result keeps its originating assistant message.
    const folded = ctx.get(IAgentSpineService).fold(history) as readonly ContextMessage[];
    expect(folded.some((m) => m.role === 'tool' && m.toolCallId === 'call_bash')).toBe(true);
    expect(folded.some((m) => m.role === 'tool' && m.toolCallId === 'call_close')).toBe(true);
    expect(toolPairingGaps(folded)).toEqual([]);

    // And the batched result reaches the model instead of being dropped as
    // an orphan.
    expect(historyText(ctx.project())).toContain('ORDINARY-RESULT-MARKER');

    // The archive mirrors the folded span: no carrier, no receipt, no
    // batched result.
    const archive = [...rec.writes.values()].join('\n');
    expect(archive).toContain('did A');
    expect(archive).not.toContain('call_bash');
    expect(archive).not.toContain('call_close');
  });

  it('hands the transition carrier to the new sibling span on next', async () => {
    const ctx = testAgent(
      execEnvServices({
        hostFs: recordingHostFs().fs,
        processRunner: createCommandRunner('ORDINARY-RESULT-MARKER'),
      }),
    );
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('call_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse(
      toolCallPart('call_bash', 'Bash', { command: 'true', description: 'noop' }),
      toolCallPart('call_next', 'spine_next', { summary: 'task B', memory: 'did A' }),
    );
    ctx.mockNextResponse(toolCallPart('call_close_b', 'spine_close', { memory: 'did B' }));
    ctx.mockNextResponse({ type: 'text', text: 'finished' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    const history = ctx.context.get();
    const carrierIndex = history.findIndex(
      (m) => m.role === 'assistant' && m.toolCalls.some((call) => call.id === 'call_next'),
    );
    const state = readSpine(ctx);
    expect(state.nodes['1.1.1']?.closedAt).toBe(carrierIndex - 1);
    // The sibling opens at the carrier index: the carrier, its receipt, and
    // the batched result belong to the sibling's span.
    expect(state.nodes['1.1.2']?.openedAt).toBe(carrierIndex);

    // After the sibling closes, the whole next-chain folds away — the
    // carrier, both receipts, and the batched result leave no orphans.
    const folded = ctx.get(IAgentSpineService).fold(history) as readonly ContextMessage[];
    expect(folded.some((m) => m.role === 'tool' && m.toolCallId === 'call_bash')).toBe(false);
    expect(toolPairingGaps(folded)).toEqual([]);
    const memories = folded.filter((m) => textOf(m).includes('<spine_memory>'));
    expect(memories).toHaveLength(2);
    expect(historyText(ctx.project())).not.toContain('ORDINARY-RESULT-MARKER');
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

  it('accepts close memory that references an unknown [U#] anchor', async () => {
    // Upstream parity: citations are not validated at accept time. User
    // requests inside the closing span are compiled into the memory body at
    // commit, and a reference to an anchor that exists nowhere stays
    // tolerable rather than blocking the transition.
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
    expect(state.nodes['1.1.1']?.closedAt).toBeDefined();
    const receipt = ctx.context.get().find((m) => m.role === 'tool' && m.toolCallId === 'call_close');
    expect(receipt?.isError).not.toBe(true);
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

  it('accepts next memory that references an unknown [U#] anchor', async () => {
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
    expect(state.nodes['1.1.1']?.closedAt).toBeDefined();
    expect(state.nodes['1.1.2']?.summary).toBe('task B');
    const receipt = ctx.context.get().find((m) => m.role === 'tool' && m.toolCallId === 'call_next');
    expect(receipt?.isError).not.toBe(true);
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

  it('clamps the closing boundary at the span start', async () => {
    // A truncation repair can restart an open span at the cut — past the end
    // of the surviving history — so `assistantIndex - 1` would invert the
    // span without the clamp.
    const { beforeStep, afterStep, spine, ctx } = spineWithCapturedStepHooks(
      execEnvServices({ hostFs: recordingHostFs().fs }),
    );
    ctx
      .get(IAgentWireService)
      .dispatch(spineOpen({ id: '1.1.1', summary: 'task A', parentId: '1.1', openedAt: 10 }));
    ctx.context.append({
      role: 'assistant',
      content: [{ type: 'text', text: 'closing' }],
      toolCalls: [{ type: 'function', id: 'call_close', name: 'spine_close', arguments: '{}' }],
    });
    ctx.context.append({
      role: 'tool',
      content: [{ type: 'text', text: ACCEPTED_OUTPUT }],
      toolCalls: [],
      toolCallId: 'call_close',
    });

    await hookOf(beforeStep, 'spine')(beforeCtx(new AbortController().signal), noopNext);
    expect(spine.acceptClose('did A', 'call_close').accepted).toBe(true);
    await hookOf(afterStep, 'spine')(afterCtx(new AbortController().signal), noopNext);

    expect(readSpine(ctx).nodes['1.1.1']?.closedAt).toBe(10);
  });

  it('commits a leftover close at the next step start when its receipt landed', async () => {
    // The abort path: afterStep never runs, so the close stays pending past its
    // owning step. The next step's beforeStep must commit it (the receipt is
    // already in context) so the tree catches up before the model sees the
    // context — rather than dropping it and forking the tree from the receipt.
    const { beforeStep, reported, spine, ctx } = spineWithCapturedStepHooks(
      execEnvServices({ hostFs: recordingHostFs().fs }),
    );
    ctx
      .get(IAgentWireService)
      .dispatch(spineOpen({ id: '1.1.1', summary: 'task A', parentId: '1.1', openedAt: 0 }));
    ctx.context.append({
      role: 'assistant',
      content: [{ type: 'text', text: 'work a' }],
      toolCalls: [],
    });
    ctx.context.append({
      role: 'assistant',
      content: [{ type: 'text', text: 'work b' }],
      toolCalls: [],
    });
    ctx.context.append({
      role: 'assistant',
      content: [{ type: 'text', text: 'closing' }],
      toolCalls: [toolCallPart('call_close', 'spine_close', {})],
    });
    ctx.context.append({
      role: 'tool',
      content: [{ type: 'text', text: ACCEPTED_OUTPUT }],
      toolCalls: [],
      toolCallId: 'call_close',
    });

    // Owning step: accept the close, then abort before afterStep can commit it.
    const controller = new AbortController();
    await hookOf(beforeStep, 'spine')(beforeCtx(controller.signal), noopNext);
    expect(spine.acceptClose('did A', 'call_close').accepted).toBe(true);
    controller.abort();

    // The next step begins: the leftover is committed (boundary = the carrier's
    // predecessor), not dropped — and nothing is reported.
    await hookOf(beforeStep, 'spine')(beforeCtx(new AbortController().signal), noopNext);

    expect(readSpine(ctx).nodes['1.1.1']?.closedAt).toBe(1);
    expect(reported).toHaveLength(0);
  });
});

describe('spine control tool main-agent gating', () => {
  const gatedTools = [
    ['spine_open', SpineOpenTool],
    ['spine_close', SpineCloseTool],
    ['spine_next', SpineNextTool],
    ['spine_tree', SpineTreeTool],
  ] as const;

  function accessorFor(agentId: string, spineEnabled: boolean): ServicesAccessor {
    const scopeContext: IAgentScopeContext = {
      _serviceBrand: undefined,
      agentId,
      scope: () => '',
    };
    const flags = {
      enabled: (id: string) => id === SPINE_FLAG_ID && spineEnabled,
    } as unknown as IFlagService;
    return {
      get: (id: unknown) => {
        if (id === IAgentScopeContext) return scopeContext;
        if (id === IFlagService) return flags;
        throw new Error(`unexpected service identifier: ${String(id)}`);
      },
    } as unknown as ServicesAccessor;
  }

  it.each(gatedTools)('%s registers only on the main agent with the flag on', (name, ctor) => {
    const contribution = getToolContributions().find((c) => c.ctor === ctor);
    expect(contribution, `${name} contribution`).toBeDefined();
    const when = contribution?.options.when;
    expect(when, `${name} must gate on flag + main-agent identity`).toBeDefined();
    expect(when?.(accessorFor('main', true))).toBe(true);
    expect(when?.(accessorFor('sub-1', true))).toBe(false);
    expect(when?.(accessorFor('main', false))).toBe(false);
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
function spineWithCapturedStepHooks(...overrides: readonly TestAgentServiceOverride[]): {
  readonly beforeStep: Map<string, BeforeStepHook>;
  readonly afterStep: Map<string, AfterStepHook>;
  readonly reported: unknown[];
  readonly spine: IAgentSpineService;
  readonly ctx: TestAgentContext;
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
  const ctx = testAgent(agentService(IAgentLoopService, fakeLoop), ...overrides);
  return { beforeStep, afterStep, reported, spine: ctx.get(IAgentSpineService), ctx };
}

/**
 * Tool-call pairing invariant over a folded history: every tool result must
 * appear after the assistant message carrying its call. Returns the ids of
 * orphan results — the fold-boundary defect's signature.
 */
function toolPairingGaps(messages: readonly ContextMessage[]): string[] {
  const gaps: string[] = [];
  const openCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls) openCallIds.add(call.id);
    } else if (
      message.role === 'tool' &&
      message.toolCallId !== undefined &&
      !openCallIds.has(message.toolCallId)
    ) {
      gaps.push(message.toolCallId);
    }
  }
  return gaps;
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
