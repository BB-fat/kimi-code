/**
 * `skillDisclosure` domain (L4) — persistent disclosed-skill names model.
 *
 * Defines the Agent wire model and whole-set replacement operation used to
 * restore the system-prompt skill baseline across replay and forks. Alongside
 * the names, the model records the render generation of the disclosure that
 * wrote them (renders, binding snapshots, and runtime seeds), so reminder
 * baselines can order the floor against in-context reminder disclosures; the
 * stored generation only advances together with the name set, so re-renders
 * with unchanged skills produce no record. Records replayed from before the
 * field existed read as generation 0.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';

export interface SkillDisclosureModelState {
  readonly names?: readonly string[];
  readonly renderGeneration?: number;
}

export const SkillDisclosureModel = defineModel<SkillDisclosureModelState>(
  'skillDisclosure',
  () => ({}),
);

export const setDisclosedSkills = SkillDisclosureModel.defineOp('skill.disclosure.set', {
  schema: z.object({
    names: z.array(z.string()).readonly(),
    renderGeneration: z.number().optional(),
  }),
  apply: (state, payload) =>
    stringArrayEqual(state.names, payload.names)
      ? state
      : { names: payload.names, renderGeneration: payload.renderGeneration ?? 0 },
});

function stringArrayEqual(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

declare module '#/wire/types' {
  interface PersistedOpMap {
    'skill.disclosure.set': typeof setDisclosedSkills;
  }
}
