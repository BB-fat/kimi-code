import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { estimateTokensForMessages } from '#/_base/utils/tokens';
import { IEventBus } from '#/app/event/eventBus';
import type { Message } from '#/app/llmProtocol/message';
import type { TokenUsage } from '#/app/llmProtocol/usage';
import {
  IAgentContextMemoryService,
  IAgentContextProjectorService,
  IAgentContextSizeService,
} from '#/index';

import { createTestAgent, type TestAgentContext } from '../../harness';

describe('Agent context size', () => {
  let ctx: TestAgentContext;
  let context: IAgentContextMemoryService;
  let contextSize: IAgentContextSizeService;
  let projector: IAgentContextProjectorService;
  let eventBus: IEventBus;
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
    raws = [];
    eventBus.subscribe((event) => {
      const e = event as { type?: string; rawContextTokens?: number };
      if (e.type === 'agent.status.updated' && e.rawContextTokens !== undefined) {
        raws.push(e.rawContextTokens);
      }
    });
  });

  afterEach(async () => {
    await ctx.dispose();
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
    // the response content after the request returns, so the trailing partial
    // in the measured input and the output message are the same stored
    // message. Counting it twice would park the measured prefix one past the
    // stored context: the whole-context read would fall off the exact
    // measured aggregate onto a per-message estimate until the next append
    // caught the length up, and the footer gauge would swing between estimate
    // and request caliber at every turn boundary.
    ctx.appendUserMessage([{ type: 'text', text: 'hello world '.repeat(20) }]);
    context.appendLoopEvent({ type: 'step.begin', uuid: 'step-1' });

    const usage: TokenUsage = {
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
    contextSize.measured(context.get(), [response], usage);
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
});
