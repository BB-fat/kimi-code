/**
 * Scenario: `agents_md` context injection announces AGENTS.md content changes.
 *
 * Exercises the real provider through the harness injector against a fake
 * host fs whose AGENTS.md files the test edits and deletes, with a stub
 * `IHostFsWatchService` driving change events: baselines come from the last
 * reminder in history, then the fenced AGENTS.md block of the system prompt,
 * then a silent adoption for blockless prompts. Edits, creations, and
 * removals all announce. Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec
 * vitest run test/agent/profile/agentsMdReminder.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { loadAgentsMd } from '#/agent/profile/context';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import type { HostFileStat, IHostFileSystem } from '#/os/interface/hostFileSystem';

import { stubHostFsWatch, type StubHostFsWatch } from '../../os/stubs';
import { createFakeHostFs } from '../../tools/fixtures/fake-exec';
import { appService, createTestAgent, execEnvServices, type TestAgentContext } from '../../harness';

type InjectableDynamicInjector = {
  inject(): Promise<void>;
};

const TEST_HOME_DIR = '/home/test';
const BRAND_HOME_DIR = '/tmp/kimi-code-agent-app-v2-test';
const WATCH_DEBOUNCE_MS = 300;

function systemPromptWithAgentsMd(content: string): string {
  return [
    'You are a deterministic test agent.',
    '',
    'The applicable `AGENTS.md` instructions are:',
    '',
    '```````',
    content,
    '```````',
  ].join('\n');
}

function agentsMdReminders(context: IAgentContextMemoryService): readonly ContextMessage[] {
  return context.get().filter((message) => {
    return message.origin?.kind === 'injection' && message.origin.variant === 'agents_md';
  });
}

function messageText(message: ContextMessage): string {
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}

describe('AgentAgentsMdReminderService', () => {
  let cwd: string;
  let agentsMdPath: string;
  let files: Map<string, string>;
  let dirs: Set<string>;
  let hostFs: IHostFileSystem;
  let watch: StubHostFsWatch;
  let ctx: TestAgentContext;
  let context: IAgentContextMemoryService;
  let injector: InjectableDynamicInjector;
  let profile: IAgentProfileService;

  function fileStat(path: string): HostFileStat {
    return { isFile: true, isDirectory: false, size: files.get(path)?.length ?? 0 };
  }

  async function currentAgentsMd(): Promise<string> {
    return loadAgentsMd({ fs: hostFs, homeDir: TEST_HOME_DIR }, cwd, BRAND_HOME_DIR);
  }

  async function settleWatchDebounce(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, WATCH_DEBOUNCE_MS + 150));
  }

  beforeEach(() => {
    cwd = process.cwd();
    agentsMdPath = `${cwd}/AGENTS.md`;
    files = new Map();
    dirs = new Set([cwd, `${cwd}/.git`]);
    hostFs = createFakeHostFs({
      stat: async (path: string) => {
        if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
        return fileStat(path);
      },
      lstat: async (path: string) => {
        if (files.has(path)) return fileStat(path);
        if (dirs.has(path)) return { isFile: false, isDirectory: true, size: 0 };
        throw new Error(`ENOENT: ${path}`);
      },
      readText: async (path: string) => {
        const content = files.get(path);
        if (content === undefined) throw new Error(`ENOENT: ${path}`);
        return content;
      },
      readdir: async () => [],
    });
    watch = stubHostFsWatch();
    ctx = createTestAgent(
      execEnvServices({ hostFs }),
      appService(IHostFsWatchService, watch),
    );
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

  it('stays quiet when no AGENTS.md exists and the prompt has no fenced block', async () => {
    await injector.inject();

    expect(agentsMdReminders(context)).toHaveLength(0);
    expect(context.get()).toHaveLength(0);
  });

  it('stays quiet when the file content matches the system prompt block', async () => {
    files.set(agentsMdPath, 'rule one');
    profile.update({ systemPrompt: systemPromptWithAgentsMd(await currentAgentsMd()) });

    await injector.inject();

    expect(agentsMdReminders(context)).toHaveLength(0);
  });

  it('injects the fresh content after an edit, then stays quiet', async () => {
    files.set(agentsMdPath, 'rule one');
    profile.update({ systemPrompt: systemPromptWithAgentsMd(await currentAgentsMd()) });
    await injector.inject();

    files.set(agentsMdPath, 'rule two');
    watch.fire(agentsMdPath, { action: 'modified' });
    await settleWatchDebounce();
    await injector.inject();

    const reminders = agentsMdReminders(context);
    expect(reminders).toHaveLength(1);
    const first = reminders[0];
    expect(first).toBeDefined();
    const text = messageText(first as ContextMessage);
    expect(text).toContain('rule two');
    expect(text).toContain('supersedes');
    expect(text).toContain('DO NOT mention this to the user explicitly');

    await injector.inject();
    expect(agentsMdReminders(context)).toHaveLength(1);
  });

  it('announces removal when the last AGENTS.md file disappears', async () => {
    files.set(agentsMdPath, 'rule one');
    profile.update({ systemPrompt: systemPromptWithAgentsMd(await currentAgentsMd()) });
    await injector.inject();

    files.clear();
    watch.fire(agentsMdPath, { action: 'deleted' });
    await settleWatchDebounce();
    await injector.inject();

    const reminders = agentsMdReminders(context);
    expect(reminders).toHaveLength(1);
    const first = reminders[0];
    expect(first).toBeDefined();
    expect(messageText(first as ContextMessage)).toContain('removed');
  });

  it('announces a file created while the prompt shows an empty block', async () => {
    profile.update({ systemPrompt: systemPromptWithAgentsMd('') });
    files.set(agentsMdPath, 'fresh rule');

    await injector.inject();

    const reminders = agentsMdReminders(context);
    expect(reminders).toHaveLength(1);
    const first = reminders[0];
    expect(first).toBeDefined();
    expect(messageText(first as ContextMessage)).toContain('fresh rule');
  });
});
