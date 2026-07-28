/**
 * `skillDisclosure` domain (L4) — persistent disclosed-skill names model.
 *
 * Defines the Agent wire model and whole-set replacement operation used to
 * restore the system-prompt skill baseline across replay and forks.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';

export interface SkillDisclosureModelState {
  readonly names?: readonly string[];
}

export const SkillDisclosureModel = defineModel<SkillDisclosureModelState>(
  'skillDisclosure',
  () => ({}),
);

export const setDisclosedSkills = SkillDisclosureModel.defineOp('skill.disclosure.set', {
  schema: z.object({ names: z.array(z.string()).readonly() }),
  apply: (state, payload) =>
    stringArrayEqual(state.names, payload.names) ? state : { names: payload.names },
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
