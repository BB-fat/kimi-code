import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { estimateTokensForMessages } from '#/_base/utils/tokens';
import { IEventBus } from '#/app/event/eventBus';
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
});
