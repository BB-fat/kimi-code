/**
 * `agentPlugin` domain (L4) — persistent plugin session-start baseline.
 *
 * Defines the Agent wire model used by `agentPlugin` to restore the last
 * model-facing session-start fingerprint across replay and resume.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';

export interface AgentPluginModelState {
  readonly sessionStartFingerprint?: string;
  readonly sessionStartActive: boolean;
}

export const AgentPluginModel = defineModel<AgentPluginModelState>(
  'agentPlugin',
  () => ({ sessionStartActive: false }),
);

export const setPluginSessionStartBaseline = AgentPluginModel.defineOp(
  'plugin.session_start.set_baseline',
  {
    schema: z.object({
      fingerprint: z.string(),
      active: z.boolean(),
    }),
    apply: (state, payload) =>
      state.sessionStartFingerprint === payload.fingerprint &&
      state.sessionStartActive === payload.active
        ? state
        : {
            sessionStartFingerprint: payload.fingerprint,
            sessionStartActive: payload.active,
          },
  },
);

declare module '#/wire/types' {
  interface PersistedOpMap {
    'plugin.session_start.set_baseline': typeof setPluginSessionStartBaseline;
  }
}
