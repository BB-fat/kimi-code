/**
 * `agentPlugin` domain (L4) — `IAgentPluginService` implementation.
 *
 * Renders session-start skills from `plugin` and `sessionSkillCatalog`, injects
 * them through `contextInjector` and `systemReminder`, and uses `contextMemory`
 * to neutralize stale guidance. Main-agent-only (v1 parity): the service
 * self-gates on `agentId === 'main'`; Agent scope creation instantiates it for
 * every agent, so other agents construct it as a no-op. Resolves
 * session prompt context through `sessionContext` and reports missing skills
 * through `log`. Persists the last rendered fingerprint through `wire`. Bound
 * at Agent scope.
 */

import { createHash } from 'node:crypto';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { escapeXmlAttr } from '#/_base/utils/xml-escape';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IPluginService } from '#/app/plugin/plugin';
import type { EnabledPluginSessionStart } from '#/app/plugin/types';
import type { SkillCatalog, SkillDefinition } from '#/app/skillCatalog/types';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { PLUGIN_SKILL_SOURCE_ID } from '#/session/sessionSkillCatalog/pluginSkillSource';
import { IWireService } from '#/wire/wire';

import { IAgentPluginService } from './agentPlugin';
import {
  AgentPluginModel,
  setPluginSessionStartBaseline,
} from './agentPluginOps';

const SESSION_START_INJECTION_VARIANT = 'plugin_session_start';

// The main agent's id, kept as a local literal: `MAIN_AGENT_ID` lives in the
// L6 `agentLifecycle` domain and this L4 domain must not import it.
const MAIN_AGENT_ID = 'main';

export class AgentPluginService extends Disposable implements IAgentPluginService {
  declare readonly _serviceBrand: undefined;

  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IPluginService private readonly plugins: IPluginService,
    @ISessionSkillCatalog private readonly skillCatalog: ISessionSkillCatalog,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IWireService private readonly wire: IWireService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    // Plugin session-start guidance is main-agent-only (v1 parity:
    // `pluginSessionStarts: type === 'main' ? … : undefined`). Agent scope
    // creation instantiates this service for every agent; non-main agents
    // no-op.
    if (scopeContext.agentId !== MAIN_AGENT_ID) return;
    this._register(
      injector.register(
        SESSION_START_INJECTION_VARIANT,
        async ({ injectedPositions }) => {
          if (injectedPositions.length > 0) return undefined;
          return this.enqueue(async () => {
            const reminder = await this.renderSessionStartReminder();
            if (hasPluginSessionStartReminder(this.context.get())) return undefined;
            if (reminder !== undefined) this.markSessionStartBaseline(reminder);
            return reminder;
          });
        },
      ),
    );
    this._register(
      this.skillCatalog.onDidChange((sourceId) => {
        if (sourceId === PLUGIN_SKILL_SOURCE_ID) {
          void this.appendFreshSessionStartReminder();
        }
      }),
    );
  }

  private async renderSessionStartReminder(): Promise<string | undefined> {
    const sessionStarts = await this.plugins.enabledSessionStarts();
    if (sessionStarts.length === 0) return undefined;
    await this.skillCatalog.ready;
    return renderPluginSessionStartReminder({
      sessionStarts,
      catalog: this.skillCatalog.catalog,
      log: this.log,
      sessionId: this.sessionContext.sessionId,
    });
  }

  async appendFreshSessionStartReminder(): Promise<void> {
    return this.enqueue(() => this.refreshSessionStartReminder());
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationTail.then(operation);
    this.operationTail = next.then(
      () => undefined,
      (error: unknown) => {
        this.log.warn('failed to refresh plugin sessionStart reminder', error);
      },
    );
    return next;
  }

  private async refreshSessionStartReminder(): Promise<void> {
    const reminder = await this.renderSessionStartReminder();
    const baseline = this.wire.getModel(AgentPluginModel);
    const fingerprint = pluginSessionStartFingerprint(reminder);
    const active = reminder !== undefined;
    if (
      baseline.sessionStartFingerprint === fingerprint &&
      baseline.sessionStartActive === active
    ) {
      return;
    }
    if (reminder !== undefined) {
      this.reminders.appendSystemReminder(
        `${reminder}\n\nThis supersedes any earlier plugin_session_start reminder in this session.`,
        { kind: 'injection', variant: SESSION_START_INJECTION_VARIANT },
      );
    } else if (
      baseline.sessionStartActive ||
      (baseline.sessionStartFingerprint === undefined &&
        shouldNeutralizePluginSessionStart(this.context.get()))
    ) {
      this.reminders.appendSystemReminder(
        'There are currently no active plugin session starts. ' +
          'This supersedes any earlier plugin_session_start reminder in this session.',
        { kind: 'injection', variant: SESSION_START_INJECTION_VARIANT },
      );
    }
    this.markSessionStartBaseline(reminder);
  }

  private markSessionStartBaseline(reminder: string | undefined): void {
    const fingerprint = pluginSessionStartFingerprint(reminder);
    const active = reminder !== undefined;
    const baseline = this.wire.getModel(AgentPluginModel);
    if (
      baseline.sessionStartFingerprint === fingerprint &&
      baseline.sessionStartActive === active
    ) {
      return;
    }
    this.wire.dispatch(setPluginSessionStartBaseline({ fingerprint, active }));
  }
}

function pluginSessionStartFingerprint(reminder: string | undefined): string {
  return createHash('sha256').update(reminder ?? '').digest('hex');
}

interface RenderPluginSessionStartReminderInput {
  readonly sessionStarts: readonly EnabledPluginSessionStart[];
  readonly catalog: SkillCatalog | undefined;
  readonly log?: { warn(message: string, payload?: unknown): void };
  readonly sessionId?: string;
}

function renderPluginSessionStartReminder(
  input: RenderPluginSessionStartReminderInput,
): string | undefined {
  const { sessionStarts, catalog, log, sessionId } = input;
  if (sessionStarts.length === 0) return undefined;
  if (catalog === undefined) return undefined;
  const blocks: string[] = [];
  for (const sessionStart of sessionStarts) {
    const skill = catalog.getPluginSkill(sessionStart.pluginId, sessionStart.skillName);
    if (skill === undefined) {
      log?.warn('plugin sessionStart skill not found', {
        pluginId: sessionStart.pluginId,
        skillName: sessionStart.skillName,
      });
      continue;
    }
    blocks.push(
      renderSessionStartBlock(sessionStart, skill, catalog.renderSkillPrompt(skill, '', { sessionId })),
    );
  }
  return blocks.length > 0 ? blocks.join('\n') : undefined;
}

function shouldNeutralizePluginSessionStart(
  history: readonly { readonly origin?: { readonly kind: string; readonly variant?: string } }[],
): boolean {
  return history.some(
    (message) =>
      isPluginSessionStartReminder(message) || message.origin?.kind === 'compaction_summary',
  );
}

function hasPluginSessionStartReminder(
  history: readonly { readonly origin?: { readonly kind: string; readonly variant?: string } }[],
): boolean {
  return history.some((message) => isPluginSessionStartReminder(message));
}

function isPluginSessionStartReminder(message: {
  readonly origin?: { readonly kind: string; readonly variant?: string };
}): boolean {
  return (
    message.origin?.kind === 'injection' &&
    message.origin.variant === SESSION_START_INJECTION_VARIANT
  );
}

function renderSessionStartBlock(
  sessionStart: EnabledPluginSessionStart,
  skill: SkillDefinition,
  skillContent: string,
): string {
  return (
    `<plugin_session_start plugin="${escapeXmlAttr(sessionStart.pluginId)}" ` +
    `skill="${escapeXmlAttr(skill.name)}">\n${skillContent}\n</plugin_session_start>`
  );
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPluginService,
  AgentPluginService,
  ScopeActivation.OnScopeCreated,
  'agentPlugin',
);
