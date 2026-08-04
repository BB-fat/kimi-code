/**
 * CoworkInitTool — create the `.cowork/` workspace, enter cowork mode, and
 * activate the rest of the cowork tool set. Idempotent: re-running against an
 * existing workspace reports `created: false`, keeps all state, and simply
 * re-enters mode and re-enables the tools (e.g. after a session resume).
 */

import type { Agent } from '#/agent';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { newStore, runCoworkTool } from './support';

export const CoworkInitToolInputSchema = z.object({}).strict();

export type CoworkInitToolInput = z.infer<typeof CoworkInitToolInputSchema>;

/** Tools CoworkInit adds to the active set: the tower tools plus the shared comms tools. */
const COWORK_TOOL_NAMES = [
  'CoworkPlan',
  'CoworkSpawn',
  'CoworkMerge',
  'CoworkTeardown',
  'CoworkSend',
  'CoworkInbox',
  'CoworkFinding',
  'CoworkReview',
  'CoworkMission',
  'CoworkStatus',
] as const;

export class CoworkInitTool implements BuiltinTool<CoworkInitToolInput> {
  readonly name = 'CoworkInit' as const;
  readonly description: string = `Initialize a cowork multi-agent workspace in the current repository.

Creates the .cowork/ directory (comms state, inbox, findings, reviews, missions, activity log, worktree slots), enters cowork mode, and activates the full cowork tool set (CoworkPlan/CoworkSpawn/CoworkMerge/CoworkTeardown plus the shared CoworkSend/CoworkInbox/CoworkFinding/CoworkReview/CoworkMission/CoworkStatus).

Use this when a task is large enough to split across multiple parallel agents with isolated git worktrees and a review-gated merge protocol. Safe to call again — an existing workspace is reported, never reset.`;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(CoworkInitToolInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(_args: CoworkInitToolInput): ToolExecution {
    return {
      description: 'Initializing cowork workspace',
      approvalRule: this.name,
      execute: () =>
        runCoworkTool(async () => {
          const store = newStore(this.agent);
          const result = await store.init();
          this.agent.coworkMode.enter();
          this.agent.tools.setActiveTools([
            ...this.agent.tools.getActiveToolNames(),
            ...COWORK_TOOL_NAMES,
          ]);
          return {
            output: [
              result.created
                ? 'cowork workspace initialized'
                : 'cowork workspace already initialized — existing state preserved',
              `base branch: ${result.base}`,
              'workspace: .cowork/ (comms under .cowork/comms/, worktrees under .cowork/worktrees/)',
              '',
              'Cowork mode is active and the cowork tool set is enabled.',
              'Next: split the work with CoworkPlan (one mission per disjoint file scope), then CoworkSpawn a worker per mission. Assign reviewers for their branches, and merge with CoworkMerge only after a clean review.',
            ].join('\n'),
          };
        }),
    };
  }
}
