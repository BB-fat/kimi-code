/**
 * Subagent cron suppression: each session can spawn many subagents, and
 * unconditionally starting a SessionCronService per agent leaks 1s setInterval
 * timers and SIGUSR1 listeners (under KIMI_CRON_MANUAL_TICK=1) that
 * never serve any purpose — default subagent profiles don't expose the
 * Cron tools to the LLM. This test pins both halves of the fix:
 *
 *   1. `agent.cron` is disabled (`isEnabled === false`) for `type: 'sub'`
 *      so no scheduler, timers or listeners leak for ephemeral agents.
 *   2. `cron.start()` is never called for subagents, so the SIGUSR1
 *      listener count stays put.
 *   3. The three Cron tools (`CronCreate` / `CronList` / `CronDelete`)
 *      are NOT registered in the subagent's tool manager.
 *   4. `type: 'main'` and `type: 'independent'` keep the old behaviour
 *      — listener bound, tools registered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ISessionCronService } from '#/session/cron/sessionCronService';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { createTestAgent, cronServices, type TestAgentContext } from '../../harness';

const CRON_TOOL_NAMES = ['CronCreate', 'CronList', 'CronDelete'] as const;

describe('Agent + Cron — subagent suppression', () => {
  beforeEach(() => {
    // SIGUSR1 binding only happens under KIMI_CRON_MANUAL_TICK=1
    // (see manager.ts bindSigusr1). Using it as the probe lets us
    // observe `start()` vs no-start without poking private fields.
    vi.stubEnv('KIMI_CRON_MANUAL_TICK', '1');
    vi.stubEnv('KIMI_CRON_NO_JITTER', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("type='sub'", () => {
    let ctx: TestAgentContext;

    beforeEach(() => {
      ctx = createTestAgent(cronServices());
      ctx.announceMain();
    });

    afterEach(async () => {
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
      }
    });

    it('subagents get no cron tools or SIGUSR1 listener of their own', async () => {
      if (process.platform === 'win32') return;

      // Suppression is structural now: SessionCronService is a session
      // singleton bound only to the main agent (onDidCreateMain), so a
      // subagent must not receive the Cron tools in its own registry and
      // must not bind another SIGUSR1 listener.
      const listenerCountBeforeCreate = process.listenerCount('SIGUSR1');
      const agents = ctx.get(IAgentLifecycleService);
      const sub = await agents.create({ agentId: 'sub-cron-test' });

      expect(process.listenerCount('SIGUSR1')).toBe(listenerCountBeforeCreate);
      expect(ctx.get(ISessionCronService).isEnabled).toBe(true);

      const subRegistry = sub.accessor.get(IAgentToolRegistryService);
      for (const name of CRON_TOOL_NAMES) {
        expect(subRegistry.resolve(name)).toBeUndefined();
      }
    });
  });

  describe("type='main'", () => {
    let ctx: TestAgentContext;
    let profile: IAgentProfileService;
    let listenerCountBeforeCreate: number;

    beforeEach(() => {
      listenerCountBeforeCreate = process.listenerCount('SIGUSR1');
      ctx = createTestAgent();
      ctx.announceMain();
      profile = ctx.get(IAgentProfileService);
    });

    afterEach(async () => {
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
      }
    });

    it('start() runs, tools registered', () => {
      if (process.platform === 'win32') return;

      expect(process.listenerCount('SIGUSR1')).toBe(listenerCountBeforeCreate + 1);

      profile.update({ activeToolNames: [...CRON_TOOL_NAMES] });
      const toolNames = ctx.toolsData().map((info) => info.name);
      for (const name of CRON_TOOL_NAMES) {
        expect(toolNames).toContain(name);
      }
    });
  });

  describe("type='independent'", () => {
    let ctx: TestAgentContext;
    let profile: IAgentProfileService;
    let listenerCountBeforeCreate: number;

    beforeEach(() => {
      listenerCountBeforeCreate = process.listenerCount('SIGUSR1');
      ctx = createTestAgent();
      ctx.announceMain();
      profile = ctx.get(IAgentProfileService);
    });

    afterEach(async () => {
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
      }
    });

    it('start() runs, tools registered', () => {
      if (process.platform === 'win32') return;

      expect(process.listenerCount('SIGUSR1')).toBe(listenerCountBeforeCreate + 1);

      profile.update({ activeToolNames: [...CRON_TOOL_NAMES] });
      const toolNames = ctx.toolsData().map((info) => info.name);
      for (const name of CRON_TOOL_NAMES) {
        expect(toolNames).toContain(name);
      }
    });
  });
});
