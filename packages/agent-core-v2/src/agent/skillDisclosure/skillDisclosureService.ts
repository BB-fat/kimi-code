/**
 * `skillDisclosure` domain (L4) — `IAgentSkillDisclosureService` implementation.
 *
 * Reads structured model-facing skills from `sessionSkillCatalog`, normalizes
 * their identities, and persists the disclosed-name baseline through `wire`.
 * Bound at Agent scope.
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { normalizeSkillName } from '#/app/skillCatalog/types';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { IWireService } from '#/wire/wire';

import {
  IAgentSkillDisclosureService,
  type SkillDisclosureSnapshot,
} from './skillDisclosure';
import { setDisclosedSkills, SkillDisclosureModel } from './skillDisclosureOps';

export class AgentSkillDisclosureService implements IAgentSkillDisclosureService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionSkillCatalog private readonly skillCatalog: ISessionSkillCatalog,
    @IWireService private readonly wire: IWireService,
  ) {}

  async resolve(skillActive: boolean): Promise<SkillDisclosureSnapshot> {
    if (!skillActive) return { names: [], listing: '' };
    try {
      await this.skillCatalog.ready;
      const disclosure = this.skillCatalog.catalog.getModelSkillDisclosure();
      return {
        names: normalizeNames(disclosure.names),
        listing: disclosure.listing,
      };
    } catch {
      return { names: [], listing: '' };
    }
  }

  disclosedNames(): readonly string[] | undefined {
    return this.wire.getModel(SkillDisclosureModel).names;
  }

  legacyNames(systemPrompt: string): readonly string[] | undefined {
    if (!systemPrompt.includes('## Available skills')) return undefined;
    return this.listedNames(systemPrompt);
  }

  listedNames(listing: string): readonly string[] {
    const lines = listing.split(/\r?\n/);
    const names = this.skillCatalog.catalog
      .getModelSkillDisclosure()
      .names.filter((name) => lines.some((line) => line.startsWith(`- ${name}: `)));
    return normalizeNames(names);
  }

  markDisclosed(names: readonly string[]): void {
    const normalized = normalizeNames(names);
    const current = this.disclosedNames();
    if (current !== undefined && sameNames(current, normalized)) return;
    this.wire.dispatch(setDisclosedSkills({ names: normalized }));
  }
}

function normalizeNames(names: readonly string[]): readonly string[] {
  return [...new Set(names.map(normalizeSkillName))].toSorted();
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentSkillDisclosureService,
  AgentSkillDisclosureService,
  ScopeActivation.OnScopeCreated,
  'skillDisclosure',
);
