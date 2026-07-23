import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { estimateTokensForMessages } from '#/kosong/contract/tokens';
import { IAgentContextSizeService } from '#/agent/contextSize/contextSize';
import { ContextSizeModel, contextSizeMeasured } from '#/agent/contextSize/contextSizeOps';
import { IEventBus } from '#/app/event/eventBus';
import type { Message } from '#/kosong/contract/message';
import type { TokenUsage } from '#/kosong/contract/usage';
import { IAgentUsageService } from '#/agent/usage/usage';
import { IWireService } from '#/wire/wire';
import {
  IAgentContextMemoryService,
  IAgentContextProjectorService,
  IAgentProfileService,
} from '#/index';

import { createTestAgent, type TestAgentContext } from '../../harness';

function totalOf(usage: TokenUsage | undefined): number {
  if (usage === undefined) return 0;
  return usage.inputOther + usage.output + usage.inputCacheRead + usage.inputCacheCreation;
}

describe('Agent context size', () => {
  let ctx: TestAgentContext;
  let context: IAgentContextMemoryService;
  let contextSize: IAgentContextSizeService;
  let projector: IAgentContextProjectorService;
  let eventBus: IEventBus;
  let profile: IAgentProfileService;
  let usage: IAgentUsageService;
  let wire: IWireService;
  let raws: number[];

  /** The unfolded-request cost the status line should show, computed independently. */
  const expectedRaw = (): number => {
    const history = context.get();
    const rawMessages = estimateTokensForMessages(history);
    const projectedMessages = estimateTokensForMessages(projector.project(history));
    return contextSize.get().size + Math.max(0, rawMessages - projectedMessages);
  };

  beforeEach(() => {
    ctx = createTestAgent();
    context = ctx.get(IAgentContextMemoryService);
    contextSize = ctx.get(IAgentContextSizeService);
    projector = ctx.get(IAgentContextProjectorService);
    eventBus = ctx.get(IEventBus);
    profile = ctx.get(IAgentProfileService);
    usage = ctx.get(IAgentUsageService);
    wire = ctx.get(IWireService);
    raws = [];
    eventBus.subscribe((event) => {
      const e = event as { type?: string; rawContextTokens?: number };
      if (e.type === 'agent.status.updated' && e.rawContextTokens !== undefined) {
        raws.push(e.rawContextTokens);
      }
    });
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('publishes the raw (unfolded) cost on every context mutation', () => {
    ctx.appendUserMessage([{ type: 'text', text: 'hello world '.repeat(50) }]);
    expect(raws.at(-1)).toBe(expectedRaw());

    // A streamed step folds content into the open assistant AFTER its request
    // returned; the raw gauge must follow the context, not the measured cadence.
    context.append({
      role: 'assistant',
      content: [{ type: 'text', text: 'working on it '.repeat(40) }],
      toolCalls: [],
    });
    expect(raws.at(-1)).toBe(expectedRaw());
    expect(raws.at(-1)).toBeGreaterThan(raws.at(-2) as number);
  });

  it('keeps raw >= projected size and consistent with rawSize()', () => {
    ctx.appendUserMessage([{ type: 'text', text: 'something' }]);
    for (const raw of raws) {
      expect(raw).toBeGreaterThanOrEqual(contextSize.get().size);
    }
    expect(contextSize.rawSize()).toBe(raws.at(-1));
  });

  it('tracks shrinking histories (clear)', () => {
    ctx.appendUserMessage([{ type: 'text', text: 'something' }]);
    expect(raws.at(-1)).toBeGreaterThan(0);

    context.clear();
    expect(raws.at(-1)).toBe(0);
    expect(contextSize.rawSize()).toBe(0);
  });

  it('keeps the measured prefix aligned with settled storage across a streamed step', () => {
    // The loop opens a partial assistant at `step.begin` and settles it with
    // the response content after the request returns, so the live input array
    // already includes the folded output when `measured()` runs. Counting the
    // folded output again would park the measured prefix one past the stored
    // context: the whole-context read would fall off the exact measured
    // aggregate onto a per-message estimate until the next append caught the
    // length up, and the footer gauge would swing between estimate and
    // request caliber at every turn boundary.
    ctx.appendUserMessage([{ type: 'text', text: 'hello world '.repeat(20) }]);
    context.appendLoopEvent({ type: 'step.begin', uuid: 'step-1' });

    const tokenUsage: TokenUsage = {
      inputCacheRead: 0,
      inputCacheCreation: 0,
      inputOther: 20_000,
      output: 500,
    };
    const response: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'answer '.repeat(40) }],
      toolCalls: [],
    };
    // Mirrors the llmRequester call site: `input` is the live request array
    // (already holding the fold-opened assistant), `output` is informational.
    contextSize.measured(context.get(), [response], tokenUsage);
    context.appendLoopEvent({
      type: 'content.part',
      stepUuid: 'step-1',
      part: { type: 'text', text: 'answer '.repeat(40) },
    });
    context.appendLoopEvent({ type: 'step.end', uuid: 'step-1' });

    // Settled storage = user + assistant, exactly covered by the measured
    // prefix: the whole-context read is the LLM-reported total with no
    // estimate tail.
    expect(context.get()).toHaveLength(2);
    expect(contextSize.get()).toEqual({ size: 20_500, measured: 20_500, estimated: 0 });

    // The next user message lands on the measured aggregate as a small tail
    // estimate instead of re-deriving the whole context from estimates.
    ctx.appendUserMessage([{ type: 'text', text: 'next question' }]);
    const after = contextSize.get();
    expect(after.measured).toBe(20_500);
    expect(after.estimated).toBeGreaterThan(0);
    expect(after.size).toBe(after.measured + after.estimated);
  });

  it('adopts the exchange totals as the measured context size after a turn', async () => {
    profile.update({ activeToolNames: [] });

    ctx.mockNextResponse({ type: 'text', text: 'Hi there!' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hi' }] });
    await ctx.untilTurnEnd();

    const exchangeTotal = totalOf(usage.status().total);
    expect(exchangeTotal).toBeGreaterThan(0);
    expect(context.get()).toHaveLength(2);

    // The assistant message is folded into the context before the exchange
    // finishes, so the measured prefix must match the live history — an
    // inflated length silently knocks `get()` off the measured path onto the
    // per-message estimate branch (found as `tokenCount` reading ~50 while
    // the provider reported ~29k for a system-prompt-heavy "hi").
    expect(wire.getModel(ContextSizeModel)).toMatchObject({
      length: context.get().length,
      tokens: exchangeTotal,
    });

    const size = contextSize.get();
    expect(size.measured).toBe(exchangeTotal);
    expect(size.estimated).toBe(0);
    expect(size.size).toBe(exchangeTotal);
    expect((await ctx.rpc.getContext({})).tokenCount).toBe(exchangeTotal);
  });

  it('repoints the measured size at the last exchange across turns', async () => {
    profile.update({ activeToolNames: [] });

    ctx.mockNextResponse({ type: 'text', text: 'first' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hi' }] });
    await ctx.untilTurnEnd();

    ctx.mockNextResponse({ type: 'text', text: 'second reply, a longer one' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'again' }] });
    await ctx.untilTurnEnd();

    const lastExchangeTotal = totalOf(usage.status().currentTurn);
    expect(lastExchangeTotal).toBeGreaterThan(0);
    expect(context.get()).toHaveLength(4);

    expect(wire.getModel(ContextSizeModel)).toMatchObject({
      length: context.get().length,
      tokens: lastExchangeTotal,
    });
    expect(contextSize.get().measured).toBe(lastExchangeTotal);
    expect((await ctx.rpc.getContext({})).tokenCount).toBe(lastExchangeTotal);
  });

  it('estimates the not-yet-measured tail instead of dropping it', () => {
    ctx.appendUserMessage([{ type: 'text', text: 'hello world, not measured yet' }]);

    const size = contextSize.get();
    expect(size.measured).toBe(0);
    expect(size.estimated).toBeGreaterThan(0);
    expect(size.size).toBe(size.estimated);
  });

  it('tolerates a stored measured prefix longer than the live context', () => {
    ctx.appendUserMessage([{ type: 'text', text: 'only one message' }]);

    // A corrupt/overshooting record must not push reads onto the estimate
    // branch; the measured total is clamped to the live context instead.
    wire.dispatch(contextSizeMeasured({ length: 5, tokens: 1234 }));
    expect(contextSize.get().measured).toBe(1234);
  });
});
