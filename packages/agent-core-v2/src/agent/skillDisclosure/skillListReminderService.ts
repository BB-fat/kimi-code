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
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';

import { IAgentSkillDisclosureService } from './skillDisclosure';
import { IAgentSkillListReminderService } from './skillListReminder';

const SKILL_LIST_INJECTION_VARIANT = 'skill_list';

export class AgentSkillListReminderService extends Disposable implements IAgentSkillListReminderService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentContextInjectorService contextInjector: IAgentContextInjectorService,
    @IAgentSkillDisclosureService private readonly disclosure: IAgentSkillDisclosureService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
  ) {
    super();
    this._register(
      contextInjector.register(SKILL_LIST_INJECTION_VARIANT, () => this.reminder()),
    );
  }

  private async reminder(): Promise<string | undefined> {
    try {
      if (!this.toolPolicy.isToolActive('Skill')) return undefined;
      const current = await this.disclosure.resolve(true);
      const disclosed = this.disclosure.disclosedNames();
      const baseline =
        disclosed ?? this.disclosure.legacyNames(this.profile.getSystemPrompt());
      if (baseline === undefined) {
        this.disclosure.markDisclosed(current.names);
        return undefined;
      }
      if (!current.names.some((name) => !baseline.includes(name))) {
        if (disclosed === undefined) this.disclosure.markDisclosed(current.names);
        return undefined;
      }
      this.disclosure.markDisclosed(current.names);
      return buildSkillListReminder(current.listing);
    } catch {
      return undefined;
    }
  }
}

function buildSkillListReminder(listing: string): string {
  return `The skill list has changed since your system prompt was rendered; new skills are available. The listing below is the current source of truth.\n\n${listing}\n\nDO NOT mention this to the user explicitly.`;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentSkillListReminderService,
  AgentSkillListReminderService,
  ScopeActivation.OnScopeCreated,
  'skillDisclosure',
);
