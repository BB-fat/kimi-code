/**
 * Scenario: `skill_list` context injection announces skill-list additions.
 *
 * Exercises the real provider through the harness injector against a mutable
 * in-memory catalog: baselines come from the last reminder in history, then
 * the system prompt's `## Available skills` section, then a silent adoption
 * for sectionless prompts. Only additions announce — removals and text-only
 * changes stay quiet. Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec
 * vitest run test/agent/skill/skillListReminder.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InMemorySkillCatalog } from '#/app/skillCatalog/registry';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentProfileService } from '#/agent/profile/profile';

import { stubSkill } from '../../app/skillCatalog/stubs';
import { createTestAgent, skillServices, type TestAgentContext } from '../../harness';

type InjectableDynamicInjector = {
  inject(): Promise<void>;
};

function systemPromptWithSkills(listing: string): string {
  return [
    'You are a deterministic test agent.',
    '',
    '# Skills',
    '',
    'Skills are reusable, composable capabilities.',
    '',
    '## Available skills',
    '',
    'Skills are grouped by scope.',
    '',
    listing,
    '',
    '# Ultimate Reminders',
    '',
    '- Always, keep it stupidly simple.',
  ].join('\n');
}

function skillListReminders(context: IAgentContextMemoryService): readonly ContextMessage[] {
  return context.get().filter((message) => {
    return message.origin?.kind === 'injection' && message.origin.variant === 'skill_list';
  });
}

function messageText(message: ContextMessage): string {
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}

describe('AgentSkillListReminderService', () => {
  let catalog: InMemorySkillCatalog;
  let ctx: TestAgentContext;
  let context: IAgentContextMemoryService;
  let injector: InjectableDynamicInjector;
  let profile: IAgentProfileService;

  beforeEach(() => {
    catalog = new InMemorySkillCatalog();
    ctx = createTestAgent(skillServices(catalog));
    context = ctx.get(IAgentContextMemoryService);
    injector = ctx.get(IAgentContextInjectorService) as unknown as InjectableDynamicInjector;
    profile = ctx.get(IAgentProfileService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('does not inject when the catalog matches the system prompt listing', async () => {
    catalog.registerBuiltinSkill(stubSkill('skill-a', { source: 'builtin' }));
    profile.update({ systemPrompt: systemPromptWithSkills(catalog.getModelSkillListing()) });

    await injector.inject();

    expect(skillListReminders(context)).toHaveLength(0);
  });

  it('announces an added skill with the full fresh listing, then stays quiet', async () => {
    catalog.registerBuiltinSkill(stubSkill('skill-a', { source: 'builtin' }));
    profile.update({ systemPrompt: systemPromptWithSkills(catalog.getModelSkillListing()) });

    catalog.registerBuiltinSkill(stubSkill('skill-b', { source: 'builtin' }));
    await injector.inject();

    const reminders = skillListReminders(context);
    expect(reminders).toHaveLength(1);
    const first = reminders[0];
    expect(first).toBeDefined();
    const text = messageText(first as ContextMessage);
    expect(text).toContain('DISREGARD any earlier skill listings');
    expect(text).toContain('- skill-a:');
    expect(text).toContain('- skill-b:');
    expect(text).toContain('DO NOT mention this to the user explicitly');

    await injector.inject();
    expect(skillListReminders(context)).toHaveLength(1);
  });

  it('ignores removals and text-only changes', async () => {
    const announced = new InMemorySkillCatalog();
    announced.registerBuiltinSkill(stubSkill('skill-a', { source: 'builtin' }));
    announced.registerBuiltinSkill(stubSkill('skill-b', { source: 'builtin' }));
    profile.update({ systemPrompt: systemPromptWithSkills(announced.getModelSkillListing()) });

    // The live catalog lost skill-b and reworded skill-a: no addition, no reminder.
    catalog.registerBuiltinSkill(
      stubSkill('skill-a', { source: 'builtin', description: 'reworded description' }),
    );
    await injector.inject();

    expect(skillListReminders(context)).toHaveLength(0);
  });

  it('adopts the live list silently when the system prompt has no skills section', async () => {
    // The harness default system prompt has no skills section.
    catalog.registerBuiltinSkill(stubSkill('skill-a', { source: 'builtin' }));
    await injector.inject();
    expect(skillListReminders(context)).toHaveLength(0);

    catalog.registerBuiltinSkill(stubSkill('skill-b', { source: 'builtin' }));
    await injector.inject();

    const reminders = skillListReminders(context);
    expect(reminders).toHaveLength(1);
    const first = reminders[0];
    expect(first).toBeDefined();
    expect(messageText(first as ContextMessage)).toContain('- skill-b:');
  });
});
