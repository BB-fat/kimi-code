/**
 * Scenario: `date_change` context injection announces calendar-date changes.
 *
 * Exercises the real provider through the harness injector: baselines come
 * from the last reminder in history, then the system prompt's rendered date,
 * then a silent adoption for dateless prompts. Run: `pnpm --filter
 * @moonshot-ai/agent-core-v2 exec vitest run
 * test/agent/dateChange/dateChangeInjection.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentProfileService } from '#/agent/profile/profile';

import { createTestAgent, type TestAgentContext } from '../../harness';

type InjectableDynamicInjector = {
  inject(): Promise<void>;
};

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function systemPromptWithDate(iso: string): string {
  return [
    'You are a deterministic test agent.',
    '',
    `The current date and time in ISO format is \`${iso}\`. This was captured when the session started and does not update.`,
  ].join('\n');
}

function dateReminders(context: IAgentContextMemoryService): readonly ContextMessage[] {
  return context.get().filter((message) => {
    return message.origin?.kind === 'injection' && message.origin.variant === 'date_change';
  });
}

function messageText(message: ContextMessage): string {
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}

describe('AgentDateChangeService', () => {
  let ctx: TestAgentContext;
  let context: IAgentContextMemoryService;
  let injector: InjectableDynamicInjector;
  let profile: IAgentProfileService;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 6, 29, 12));
    ctx = createTestAgent();
    context = ctx.get(IAgentContextMemoryService);
    injector = ctx.get(IAgentContextInjectorService) as unknown as InjectableDynamicInjector;
    profile = ctx.get(IAgentProfileService);
  });

  afterEach(async () => {
    try {
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not inject when the system prompt date is today', async () => {
    profile.update({ systemPrompt: systemPromptWithDate(new Date().toISOString()) });

    await injector.inject();

    expect(dateReminders(context)).toHaveLength(0);
  });

  it('injects once when the rendered date is stale, then stays quiet', async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    profile.update({ systemPrompt: systemPromptWithDate(yesterday.toISOString()) });

    await injector.inject();

    const reminders = dateReminders(context);
    expect(reminders).toHaveLength(1);
    const first = reminders[0];
    expect(first).toBeDefined();
    const text = messageText(first as ContextMessage);
    expect(text).toContain(`Today's date is now ${localDateKey(new Date())}`);
    expect(text).toContain('stale');
    expect(text).toContain('DO NOT mention this to the user explicitly');

    await injector.inject();
    expect(dateReminders(context)).toHaveLength(1);
  });

  it('announces each date crossed by a long-lived session', async () => {
    profile.update({ systemPrompt: systemPromptWithDate(new Date().toISOString()) });
    await injector.inject();

    vi.setSystemTime(new Date(2026, 6, 30, 12));
    await injector.inject();

    let reminders = dateReminders(context);
    expect(reminders).toHaveLength(1);
    expect(messageText(reminders[0] as ContextMessage)).toContain(
      "Today's date is now 2026-07-30",
    );

    vi.setSystemTime(new Date(2026, 6, 31, 12));
    await injector.inject();

    reminders = dateReminders(context);
    expect(reminders).toHaveLength(2);
    expect(messageText(reminders[1] as ContextMessage)).toContain(
      "Today's date is now 2026-07-31",
    );
  });

  it('adopts today silently when the system prompt carries no date line', async () => {
    // The harness default system prompt has no date line.
    await injector.inject();

    expect(dateReminders(context)).toHaveLength(0);
    expect(context.get()).toHaveLength(0);
  });
});
