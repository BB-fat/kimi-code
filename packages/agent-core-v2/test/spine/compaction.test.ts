import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MASTER_ENV } from '#/app/flag/flagService';
import {
  IAgentMicroCompactionService,
  IAgentWireService,
  SpineModel,
} from '#/index';

import { testAgent, type TestAgentContext } from '../harness';

const SPINE_ENV = 'KIMI_CODE_SPINE';
const MICRO_ENV = 'KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION';
const MINUTE = 60 * 1000;
const MICRO_MARKER = '[Old tool result content cleared]';

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

  it('suppresses micro-compaction truncation while spine is enabled', () => {
    vi.stubEnv(MICRO_ENV, '1');
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        config: {
          keepRecentMessages: 0,
          minContentTokens: 1,
          cacheMissedThresholdMs: 60 * MINUTE,
          minContextUsageRatio: 0,
        },
      },
    });

    vi.setSystemTime(0);
    ctx.appendExchange(1, 'user one', 'assistant one', 10);
    ctx.appendExchange(2, 'user two', 'assistant two', 10);

    vi.setSystemTime(61 * MINUTE);
    const micro = ctx.get(IAgentMicroCompactionService) as unknown as {
      detect(): void;
      compact(messages: readonly unknown[]): readonly unknown[];
    };
    micro.detect();

    const history = ctx.context.get();
    expect(micro.compact(history)).toBe(history);
    expect(ctx.project().some((m) => textOf(m).includes(MICRO_MARKER))).toBe(false);
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
