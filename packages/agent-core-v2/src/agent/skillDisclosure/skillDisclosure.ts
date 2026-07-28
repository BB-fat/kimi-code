/**
 * `skillDisclosure` domain (L4) — effective model-visible skill projection.
 *
 * Defines the Agent-scoped service that resolves a structured skill names plus
 * listing snapshot and records the names already disclosed to the model.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface SkillDisclosureSnapshot {
  readonly names: readonly string[];
  readonly listing: string;
}

export interface IAgentSkillDisclosureService {
  readonly _serviceBrand: undefined;

  resolve(skillActive: boolean): Promise<SkillDisclosureSnapshot>;
  disclosedNames(): readonly string[] | undefined;
  legacyNames(systemPrompt: string): readonly string[] | undefined;
  listedNames(listing: string): readonly string[];
  markDisclosed(names: readonly string[]): void;
}

export const IAgentSkillDisclosureService: ServiceIdentifier<IAgentSkillDisclosureService> =
  createDecorator<IAgentSkillDisclosureService>('agentSkillDisclosureService');
