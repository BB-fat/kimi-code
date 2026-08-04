/**
 * CoworkTeardownTool — end the cowork session: remove mission worktrees
 * (dirty ones are kept unless force), exit cowork mode, and report what
 * happened. The comms directory stays on disk as the audit trail.
 */

import type { Agent } from '#/agent';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { newStore, runCoworkTool } from './support';

export const CoworkTeardownToolInputSchema = z
  .object({
    force: z
      .boolean()
      .optional()
      .describe('Remove worktrees even when they contain uncommitted changes'),
  })
  .strict();

export type CoworkTeardownToolInput = z.infer<typeof CoworkTeardownToolInputSchema>;

export class CoworkTeardownTool implements BuiltinTool<CoworkTeardownToolInput> {
  readonly name = 'CoworkTeardown' as const;
  readonly description: string = `Tear down the cowork workspace after all missions are merged (or abandoned).

Removes the mission worktrees — worktrees with uncommitted changes are kept and listed unless force is set. Exits cowork mode. The .cowork/comms/ directory (state, inbox, findings, reviews, activity log) is always kept as the audit trail.`;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(CoworkTeardownToolInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: CoworkTeardownToolInput): ToolExecution {
    return {
      description: `Tearing down cowork workspace${args.force === true ? ' (force)' : ''}`,
      approvalRule: this.name,
      execute: () =>
        runCoworkTool(async () => {
          const store = newStore(this.agent);
          const report = await store.teardown({ force: args.force });
          this.agent.coworkMode.exit();
          return {
            output: [
              'cowork teardown:',
              ...report.map((line) => `- ${line}`),
              '',
              'Cowork mode exited. .cowork/comms/ (state, inbox, findings, reviews, activity log) is kept as the audit trail — remove it by hand only if you are sure.',
            ].join('\n'),
          };
        }),
    };
  }
}
