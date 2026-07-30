/**
 * Scenario: `agents_md` context injection announces AGENTS.md content changes.
 *
 * Exercises the real provider through the harness injector against a fake
 * host fs whose AGENTS.md files the test edits and deletes: the provider
 * re-reads the candidate chain on every injection, so a filesystem edit
 * lands on the next `inject()` call. Baselines come from typed reminder
 * metadata, the persisted rendered snapshot, and a runtime seed recorded on
 * first observation for prompts that never disclose AGENTS.md. Edits,
 * creations, and removals all announce. Run: `pnpm --filter
 * @moonshot-ai/agent-core-v2 exec vitest run
 * test/agent/profile/agentsMdReminder.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { loadAgentsMd } from '#/agent/profile/context';
import { IAgentProfileService } from '#/agent/profile/profile';
import {
  fingerprintDisclosureContent,
  agentsMdStatus,
} from '#/app/agentProfileCatalog/profile-shared';
import type { EnvironmentDisclosureSnapshot } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { HostFileStat, IHostFileSystem } from '#/os/interface/hostFileSystem';

import { createFakeHostFs } from '../../tools/fixtures/fake-exec';
import { createTestAgent, execEnvServices, type TestAgentContext } from '../../harness';

const TEST_HOME_DIR = '/home/test';
const BRAND_HOME_DIR = '/tmp/kimi-code-agent-app-v2-test';

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

function updateSystemPromptWithAgentsMd(
  profile: IAgentProfileService,
  content: string,
): void {
  const environment: EnvironmentDisclosureSnapshot = {
    cwd: profile.data().cwd,
    date: { disclosed: false },
    agentsMd: {
      disclosed: true,
      value: {
        fingerprint: fingerprintDisclosureContent(content),
        status: agentsMdStatus(content),
      },
    },
  };
  profile.update({
    systemPrompt: systemPromptWithAgentsMd(content),
    environmentDisclosure: environment,
  });
}

function updateSystemPromptWithoutAgentsMd(profile: IAgentProfileService): void {
  const environment: EnvironmentDisclosureSnapshot = {
    cwd: profile.data().cwd,
    date: { disclosed: false },
    agentsMd: { disclosed: false },
  };
  profile.update({
    systemPrompt: 'You are a deterministic test agent.',
    environmentDisclosure: environment,
  });
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

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('AgentAgentsMdReminderService', () => {
  let cwd: string;
  let agentsMdPath: string;
  let files: Map<string, string>;
  let dirs: Set<string>;
  let hostFs: IHostFileSystem;
  let ctx: TestAgentContext;
  let context: IAgentContextMemoryService;
  let injector: IAgentContextInjectorService;
  let profile: IAgentProfileService;
  let readTextOverride: ((path: string) => Promise<string>) | undefined;

  function fileStat(path: string): HostFileStat {
    return { isFile: true, isDirectory: false, size: files.get(path)?.length ?? 0 };
  }

  async function currentAgentsMd(): Promise<string> {
    return loadAgentsMd({ fs: hostFs, homeDir: TEST_HOME_DIR }, cwd, BRAND_HOME_DIR);
  }

  beforeEach(() => {
    cwd = process.cwd();
    agentsMdPath = `${cwd}/AGENTS.md`;
    files = new Map();
    dirs = new Set([cwd, `${cwd}/.git`]);
    readTextOverride = undefined;
    hostFs = createFakeHostFs({
      stat: async (path: string) => {
        if (files.has(path)) return fileStat(path);
        if (dirs.has(path)) return { isFile: false, isDirectory: true, size: 0 };
        throw new Error(`ENOENT: ${path}`);
      },
      lstat: async (path: string) => {
        if (files.has(path)) return fileStat(path);
        if (dirs.has(path)) return { isFile: false, isDirectory: true, size: 0 };
        throw new Error(`ENOENT: ${path}`);
      },
      readText: async (path: string) => {
        if (readTextOverride !== undefined) return readTextOverride(path);
        const content = files.get(path);
        if (content === undefined) throw new Error(`ENOENT: ${path}`);
        return content;
      },
      readdir: async () => [],
      realpath: async (path: string) => path,
    });
    ctx = createTestAgent(execEnvServices({ hostFs }));
    context = ctx.get(IAgentContextMemoryService);
    injector = ctx.get(IAgentContextInjectorService);
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
    updateSystemPromptWithoutAgentsMd(profile);

    await injector.inject();

    expect(agentsMdReminders(context)).toHaveLength(0);
    expect(context.get()).toHaveLength(0);
  });

  it('announces a file created after the silent seed', async () => {
    updateSystemPromptWithoutAgentsMd(profile);
    await injector.inject();
    expect(agentsMdReminders(context)).toHaveLength(0);

    files.set(agentsMdPath, 'fresh rule');
    await injector.inject();

    const reminders = agentsMdReminders(context);
    expect(reminders).toHaveLength(1);
    expect(messageText(reminders[0] as ContextMessage)).toContain('fresh rule');

    await injector.inject();
    expect(agentsMdReminders(context)).toHaveLength(1);
  });

  it('stays quiet when the file content matches the system prompt block', async () => {
    files.set(agentsMdPath, 'rule one');
    updateSystemPromptWithAgentsMd(profile, await currentAgentsMd());

    await injector.inject();

    expect(agentsMdReminders(context)).toHaveLength(0);
  });

  it('injects the fresh content after an edit, then stays quiet', async () => {
    files.set(agentsMdPath, 'rule one');
    updateSystemPromptWithAgentsMd(profile, await currentAgentsMd());
    await injector.inject();

    files.set(agentsMdPath, 'rule two');
    await injector.inject();

    const reminders = agentsMdReminders(context);
    expect(reminders).toHaveLength(1);
    const first = reminders[0];
    expect(first).toBeDefined();
    const text = messageText(first as ContextMessage);
    expect(text).toContain('rule two');
    expect(text).toContain('supersedes');
    expect(text).toContain('DO NOT mention this to the user explicitly');
    expect(first?.origin).toMatchObject({
      kind: 'injection',
      variant: 'agents_md',
      disclosure: {
        kind: 'agents_md',
        fingerprint: fingerprintDisclosureContent(await currentAgentsMd()),
        status: 'present',
      },
    });

    await injector.inject();
    expect(agentsMdReminders(context)).toHaveLength(1);
  });

  it('announces an edit that lands while fresh content is being read', async () => {
    files.set(agentsMdPath, 'rule one');
    updateSystemPromptWithAgentsMd(profile, await currentAgentsMd());
    await injector.inject();

    files.set(agentsMdPath, 'rule two');

    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    let pauseRead = true;
    readTextOverride = async (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      if (path === agentsMdPath && pauseRead) {
        pauseRead = false;
        readStarted.resolve(undefined);
        await releaseRead.promise;
      }
      return content;
    };

    const firstInjection = injector.inject();
    await readStarted.promise;
    files.set(agentsMdPath, 'rule three');
    releaseRead.resolve(undefined);
    await firstInjection;

    await injector.inject();

    const reminders = agentsMdReminders(context);
    expect(reminders).toHaveLength(2);
    expect(messageText(reminders[0] as ContextMessage)).toContain('rule two');
    expect(messageText(reminders[1] as ContextMessage)).toContain('rule three');
  });

  it('announces removal when the last AGENTS.md file disappears', async () => {
    files.set(agentsMdPath, 'rule one');
    updateSystemPromptWithAgentsMd(profile, await currentAgentsMd());
    await injector.inject();

    files.clear();
    await injector.inject();

    const reminders = agentsMdReminders(context);
    expect(reminders).toHaveLength(1);
    const first = reminders[0];
    expect(first).toBeDefined();
    expect(messageText(first as ContextMessage)).toContain('removed');
    expect(first?.origin).toMatchObject({
      disclosure: {
        kind: 'agents_md',
        fingerprint:
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        status: 'missing',
      },
    });
  });

  it('announces a file created after an empty baseline', async () => {
    updateSystemPromptWithAgentsMd(profile, '');
    await injector.inject();

    files.set(agentsMdPath, 'fresh rule');

    await injector.inject();

    const reminders = agentsMdReminders(context);
    expect(reminders).toHaveLength(1);
    const first = reminders[0];
    expect(first).toBeDefined();
    expect(messageText(first as ContextMessage)).toContain('fresh rule');
  });
});
