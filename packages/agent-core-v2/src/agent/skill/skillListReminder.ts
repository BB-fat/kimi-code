/**
 * `skill` domain (L3) — `IAgentSkillListReminderService` contract.
 *
 * Defines the Agent-scope marker service that announces skill-list additions
 * through a `skill_list` context-injection reminder when the session catalog
 * gains skills the system prompt's listing does not know about.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentSkillListReminderService {
  readonly _serviceBrand: undefined;
}

export const IAgentSkillListReminderService: ServiceIdentifier<IAgentSkillListReminderService> =
  createDecorator<IAgentSkillListReminderService>('agentSkillListReminderService');
