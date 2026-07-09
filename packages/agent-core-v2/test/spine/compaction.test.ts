import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MASTER_ENV } from '#/app/flag/flagService';
import { IAgentWireService, SpineModel } from '#/index';

import { testAgent, type TestAgentContext } from '../harness';

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
});

function readSpine(ctx: TestAgentContext) {
  return ctx.get(IAgentWireService).getModel(SpineModel);
}

function textOf(message: { content?: readonly { type: string; text?: string }[] } | undefined): string {
  return (
    message?.content
      ?.map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
      .join('') ?? ''
  );
}
