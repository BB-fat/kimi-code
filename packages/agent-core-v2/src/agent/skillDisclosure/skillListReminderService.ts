/**
 * `skillDisclosure` domain (L4) — skill-list reminder provider.
 *
 * Registers through `contextInjector`, applies the active `toolPolicy`, and
 * compares structured snapshots from `skillDisclosure`; additions emit the
 * full superseding listing and advance the persistent baseline. Bound at
 * Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import {
  IAgentContextInjectorService,
  type ContextInjectionContext,
} from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';

import { IAgentSkillDisclosureService } from './skillDisclosure';
import { IAgentSkillListReminderService } from './skillListReminder';

const SKILL_LIST_INJECTION_VARIANT = 'skill_list';

export class AgentSkillListReminderService extends Disposable implements IAgentSkillListReminderService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentContextInjectorService contextInjector: IAgentContextInjectorService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentSkillDisclosureService private readonly disclosure: IAgentSkillDisclosureService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
  ) {
    super();
    this._register(
      contextInjector.register(SKILL_LIST_INJECTION_VARIANT, (ctx) => this.reminder(ctx)),
    );
  }

  private async reminder({ lastInjectedAt }: ContextInjectionContext): Promise<string | undefined> {
    try {
      if (!this.toolPolicy.isToolActive('Skill')) return undefined;
      const current = await this.disclosure.resolve(true);
      const disclosed = this.disclosure.disclosedNames();
      const promptBaseline = this.disclosure.legacyNames(this.profile.getSystemPrompt());
      const baseline =
        this.namesFromHistory(lastInjectedAt) ?? disclosed ?? promptBaseline;
      if (baseline === undefined) {
        this.disclosure.markDisclosed(current.names);
        return undefined;
      }
      if (disclosed === undefined && promptBaseline !== undefined) {
        this.disclosure.markDisclosed(promptBaseline);
      }
      if (!current.names.some((name) => !baseline.includes(name))) {
        return undefined;
      }
      return buildSkillListReminder(current.listing);
    } catch {
      return undefined;
    }
  }

  private namesFromHistory(lastInjectedAt: number | null): readonly string[] | undefined {
    if (lastInjectedAt === null) return undefined;
    const message: ContextMessage | undefined = this.context.get()[lastInjectedAt];
    return message === undefined ? undefined : this.disclosure.listedNames(messageText(message));
  }
}

function buildSkillListReminder(listing: string): string {
  return `The skill list has changed since your system prompt was rendered; new skills are available. The listing below is the current source of truth.\n\n${listing}\n\nDO NOT mention this to the user explicitly.`;
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
  'skillDisclosure',
);
