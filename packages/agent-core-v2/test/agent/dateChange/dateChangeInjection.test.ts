/**
 * Scenario: `date_change` context injection announces calendar-date changes.
 *
 * Exercises the real provider through the harness injector: baselines come
 * from typed reminder metadata, then the persisted rendered-date snapshot,
 * then a runtime seed recorded on first observation for prompts that never
 * disclose a date. Run: `pnpm --filter
 * @moonshot-ai/agent-core-v2 exec vitest run
 * test/agent/dateChange/dateChangeInjection.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentProfileService } from '#/agent/profile/profile';
import type { EnvironmentDisclosureSnapshot } from '#/app/agentProfileCatalog/agentProfileCatalog';

import {
  createTestAgent,
  InMemoryWireRecordPersistence,
  type TestAgentContext,
} from '../../harness';

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

describe('AgentDateChangeService', () => {
  let ctx: TestAgentContext;
  let context: IAgentContextMemoryService;
  let injector: IAgentContextInjectorService;
  let profile: IAgentProfileService;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 6, 29, 12));
    ctx = createTestAgent();
    context = ctx.get(IAgentContextMemoryService);
    injector = ctx.get(IAgentContextInjectorService);
    profile = ctx.get(IAgentProfileService);
  });

function systemPromptWithDate(iso: string): string {
  return [
    'You are a deterministic test agent.',
    '',
    `The current date and time in ISO format is \`${iso}\`. This was captured when the session started and does not update.`,
  ].join('\n');
}

function updateSystemPromptWithDate(
  profile: IAgentProfileService,
  iso: string,
  renderGeneration?: number,
): void {
  const date = new Date(iso);
  const environment: EnvironmentDisclosureSnapshot = {
    cwd: profile.data().cwd,
    date: {
      disclosed: true,
      value: {
        localDate: localDateKey(date),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      },
    },
  };
  profile.update({
    systemPrompt: systemPromptWithDate(iso),
    environmentDisclosure: environment,
    renderGeneration,
  });
}

function updateSystemPromptWithoutDate(profile: IAgentProfileService): void {
  const environment: EnvironmentDisclosureSnapshot = {
    cwd: profile.data().cwd,
    date: { disclosed: false },
  };
  profile.update({
    systemPrompt: 'You are a deterministic test agent.',
    environmentDisclosure: environment,
  });
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
    updateSystemPromptWithDate(profile, new Date().toISOString());

    await injector.inject();

    expect(dateReminders(context)).toHaveLength(0);
  });

  it('injects once when the rendered date is stale, then stays quiet', async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    updateSystemPromptWithDate(profile, yesterday.toISOString());

    await injector.inject();

    const reminders = dateReminders(context);
    expect(reminders).toHaveLength(1);
    const first = reminders[0];
    expect(first).toBeDefined();
    const text = messageText(first as ContextMessage);
    expect(text).toContain(`Today's date is now ${localDateKey(new Date())}`);
    expect(text).toContain('stale');
    expect(text).toContain('DO NOT mention this to the user explicitly');
    expect(first?.origin).toMatchObject({
      kind: 'injection',
      variant: 'date_change',
      disclosure: {
        kind: 'date',
        renderGeneration: 2,
        localDate: localDateKey(new Date()),
      },
    });

    await injector.inject();
    expect(dateReminders(context)).toHaveLength(1);
  });

  it('announces each date crossed by a long-lived session', async () => {
    updateSystemPromptWithDate(profile, new Date().toISOString());
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
    expect(reminders[1]?.origin).toMatchObject({
      disclosure: {
        kind: 'date',
        renderGeneration: 2,
        localDate: '2026-07-31',
      },
    });
  });

  it('injects on the first step when a persisted prompt crosses midnight before resume', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    await ctx.dispose();
    ctx = createTestAgent({ persistence });
    profile = ctx.get(IAgentProfileService);
    updateSystemPromptWithDate(profile, new Date().toISOString());
    await ctx.wire.flush();
    await ctx.dispose();

    vi.setSystemTime(new Date(2026, 6, 30, 12));
    ctx = createTestAgent({ autoConfigure: false, persistence });
    context = ctx.get(IAgentContextMemoryService);
    injector = ctx.get(IAgentContextInjectorService);
    await ctx.restorePersisted();

    await injector.inject();

    const reminders = dateReminders(context);
    expect(reminders).toHaveLength(1);
    expect(messageText(reminders[0] as ContextMessage)).toContain(
      "Today's date is now 2026-07-30",
    );
  });

  it('uses the newer persisted render snapshot over older reminder metadata', async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    updateSystemPromptWithDate(profile, yesterday.toISOString(), 2);
    context.append({
      role: 'user',
      content: [{ type: 'text', text: 'older date reminder' }],
      toolCalls: [],
      origin: {
        kind: 'injection',
        variant: 'date_change',
        disclosure: {
          kind: 'date',
          renderGeneration: 1,
          localDate: localDateKey(new Date()),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        },
      },
    });

    await injector.inject();

    const reminders = dateReminders(context);
    expect(reminders).toHaveLength(2);
    expect(reminders.at(-1)?.origin).toMatchObject({
      disclosure: {
        kind: 'date',
        renderGeneration: 2,
        localDate: localDateKey(new Date()),
      },
    });
  });

  it('re-injects after undo removes the structured reminder metadata', async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    updateSystemPromptWithDate(profile, yesterday.toISOString());
    context.append({
      role: 'user',
      content: [{ type: 'text', text: 'first turn' }],
      toolCalls: [],
      origin: { kind: 'user' },
    });
    await injector.inject();
    expect(dateReminders(context)).toHaveLength(1);

    expect(context.undo(1)).toMatchObject({ removedCount: 1 });
    expect(dateReminders(context)).toHaveLength(0);
    context.append({
      role: 'user',
      content: [{ type: 'text', text: 'replacement turn' }],
      toolCalls: [],
      origin: { kind: 'user' },
    });

    await injector.inject();

    expect(dateReminders(context)).toHaveLength(1);
  });

  it('adopts today silently when the system prompt carries no date line', async () => {
    updateSystemPromptWithoutDate(profile);

    await injector.inject();

    expect(dateReminders(context)).toHaveLength(0);
    expect(context.get()).toHaveLength(0);
  });

  it('announces a crossed midnight after the silent seed', async () => {
    updateSystemPromptWithoutDate(profile);
    await injector.inject();
    expect(dateReminders(context)).toHaveLength(0);

    vi.setSystemTime(new Date(2026, 6, 30, 12));
    await injector.inject();

    const reminders = dateReminders(context);
    expect(reminders).toHaveLength(1);
    expect(messageText(reminders[0] as ContextMessage)).toContain(
      "Today's date is now 2026-07-30",
    );

    await injector.inject();
    expect(dateReminders(context)).toHaveLength(1);
  });
});
