/**
 * `skill` domain (L3) — `IAgentSkillListReminderService` implementation.
 *
 * Owns the `skill_list` context-injection provider. The system prompt's skill
 * listing is only re-rendered at profile (re)bind and after compaction, so a
 * skill added mid-session is invisible to the model; this provider announces
 * additions with the full fresh listing (which is supersede-worded) at the
 * next step boundary. Only additions trigger a reminder — removals and text
 * changes are ignored, since a removed skill fails naturally on invocation.
 * The baseline is history-derived: the last `skill_list` reminder in context,
 * else the `## Available skills` section of the current system prompt, else
 * the volatile `seededNames` adopted at first evaluation (profiles without a
 * skills section). The plain-data state (`seededNames`) is registered into
 * `agentState` (`IAgentStateService`) and read/written through it. Bound at
 * Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';
import {
  IAgentContextInjectorService,
  type ContextInjectionContext,
} from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentStateService } from '#/agent/state/agentState';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';

import { IAgentSkillListReminderService } from './skillListReminder';

const SKILL_LIST_INJECTION_VARIANT = 'skill_list';

const SKILLS_SECTION_HEADING = '## Available skills';
const NEXT_HEADING_PATTERN = /\n#{1,2} /;
const LISTING_NAME_PATTERN = /^- ([^:\n]+?): /gm;

export const skillListSeededNamesKey = defineState<ReadonlySet<string> | undefined>(
  'skillList.seededNames',
  () => undefined,
);

export class AgentSkillListReminderService extends Disposable implements IAgentSkillListReminderService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentContextInjectorService dynamicInjector: IAgentContextInjectorService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @ISessionSkillCatalog private readonly skillCatalog: ISessionSkillCatalog,
    @IAgentStateService private readonly states: IAgentStateService,
  ) {
    super();
    this.states.register(skillListSeededNamesKey);
    this._register(
      dynamicInjector.register(SKILL_LIST_INJECTION_VARIANT, (ctx) => this.reminder(ctx)),
    );
  }

  private get seededNames(): ReadonlySet<string> | undefined {
    return this.states.get(skillListSeededNamesKey);
  }

  private set seededNames(value: ReadonlySet<string> | undefined) {
    this.states.set(skillListSeededNamesKey, value);
  }

  private async reminder({ lastInjectedAt }: ContextInjectionContext): Promise<string | undefined> {
    try {
      await this.skillCatalog.ready;
      const listing = this.skillCatalog.catalog.getModelSkillListing();
      const currentNames = extractSkillNames(listing);
      if (currentNames.size === 0) return undefined;
      const baseline = this.baseline(lastInjectedAt) ?? this.adopt(currentNames);
      for (const name of currentNames) {
        if (!baseline.has(name)) return buildSkillListReminder(listing);
      }
      return undefined;
    } catch {
      // A broken catalog must never break the step loop.
      return undefined;
    }
  }

  private baseline(lastInjectedAt: number | null): ReadonlySet<string> | undefined {
    return this.namesFromHistory(lastInjectedAt) ?? this.namesFromSystemPrompt() ?? this.seededNames;
  }

  private adopt(currentNames: ReadonlySet<string>): ReadonlySet<string> {
    this.seededNames = currentNames;
    return currentNames;
  }

  private namesFromHistory(lastInjectedAt: number | null): ReadonlySet<string> | undefined {
    if (lastInjectedAt === null) return undefined;
    const message: ContextMessage | undefined = this.context.get()[lastInjectedAt];
    if (message === undefined) return undefined;
    const names = extractSkillNames(messageText(message));
    return names.size > 0 ? names : undefined;
  }

  private namesFromSystemPrompt(): ReadonlySet<string> | undefined {
    const prompt = this.profile.getSystemPrompt();
    const start = prompt.indexOf(SKILLS_SECTION_HEADING);
    if (start < 0) return undefined;
    const rest = prompt.slice(start + SKILLS_SECTION_HEADING.length);
    const end = rest.search(NEXT_HEADING_PATTERN);
    return extractSkillNames(end < 0 ? rest : rest.slice(0, end));
  }
}

function buildSkillListReminder(listing: string): string {
  return `The skill list has changed since your system prompt was rendered; new skills are available. The listing below is the current source of truth.\n\n${listing}\n\nDO NOT mention this to the user explicitly.`;
}

function extractSkillNames(text: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(LISTING_NAME_PATTERN)) {
    if (match[1] !== undefined) names.add(match[1].toLowerCase());
  }
  return names;
}

function messageText(message: ContextMessage): string {
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentSkillListReminderService,
  AgentSkillListReminderService,
  ScopeActivation.OnScopeCreated,
  'skill',
);
