import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MASTER_ENV } from '#/app/flag/flagService';
import { IAgentProfileCatalogService } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IAgentWireService, SpineModel, spineClose, spineNext, spineOpen } from '#/index';

import { execEnvServices, testAgent, type TestAgentContext } from '../harness';

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

function textOf(message: { content?: readonly { type: string; text?: string }[] } | undefined): string {
  return (
    message?.content?.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('') ?? ''
  );
}
