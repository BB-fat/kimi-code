/**
 * `profile` domain (L4) — `IAgentAgentsMdReminderService` contract.
 *
 * Defines the Agent-scope marker service that announces AGENTS.md content
 * changes (edits, creations, removals) through an `agents_md`
 * context-injection reminder when the files drift from what the system prompt
 * was rendered with.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentAgentsMdReminderService {
  readonly _serviceBrand: undefined;
}

export const IAgentAgentsMdReminderService: ServiceIdentifier<IAgentAgentsMdReminderService> =
  createDecorator<IAgentAgentsMdReminderService>('agentAgentsMdReminderService');
