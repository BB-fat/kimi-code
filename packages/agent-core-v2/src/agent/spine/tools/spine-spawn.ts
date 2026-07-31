/**
 * `spine` domain (L4) — `spine_spawn` control tool.
 *
 * Receipt-only, but NOT a transition in the ordinary sense: the accepted
 * structured receipt landing in history IS the join, from which the projection
 * synthesizes N closed child nodes. The service owns capacity admission and
 * per-step mutual exclusion with the other spine control tools. Self-registers
 * via `registerTool` gated on BOTH the `KIMI_CODE_SPINE` and
 * `KIMI_CODE_SPINE_SPAWN` flags and `agentId === 'main'` (main-agent-only,
 * like the other spine tools), and only when the configured capacity admits at
 * least two concurrent child agents. Bound at Agent scope.
 */

import { z } from 'zod';

import { toInputJsonSchema } from '#/tool/input-schema';
import type { BuiltinTool, ToolExecution } from '#/tool/toolContract';
import { registerTool } from '#/agent/toolRegistry/toolContribution';

import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { SPINE_FLAG_ID, SPINE_SPAWN_FLAG_ID } from '#/agent/spine/flag';
import { IAgentSpineService, SPINE_TOOL_SPAWN } from '#/agent/spine/spine';
import {
  maxSpawnBranchCount,
  resolveMaxThreads,
  SPINE_SPAWN_MAX_THREADS_ENV,
} from '#/agent/spine/spineSpawn';
import { IFlagService } from '#/app/flag/flag';
import { toSpawnResult } from './controlResult';
import {
  SPINE_SPAWN_DESCRIPTION,
  SPINE_SPAWN_PROMPT_DESCRIPTION,
  SPINE_SPAWN_SUMMARY_DESCRIPTION,
  SPINE_SPAWN_TASKS_DESCRIPTION,
} from './descriptions';

const SpineSpawnInputSchema = z.object({
  tasks: z
    .array(
      z.object({
        summary: z.string().min(1).describe(SPINE_SPAWN_SUMMARY_DESCRIPTION),
        prompt: z.string().min(1).describe(SPINE_SPAWN_PROMPT_DESCRIPTION),
      }),
    )
    .min(2)
    .describe(SPINE_SPAWN_TASKS_DESCRIPTION),
});

export type SpineSpawnInput = z.infer<typeof SpineSpawnInputSchema>;

export class SpineSpawnTool implements BuiltinTool<SpineSpawnInput> {
  readonly name = SPINE_TOOL_SPAWN;
  readonly description = SPINE_SPAWN_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SpineSpawnInputSchema);

  constructor(@IAgentSpineService private readonly spine: IAgentSpineService) {}

  resolveExecution(input: SpineSpawnInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Spawn parallel Spine branches',
      execute: async (ctx) => toSpawnResult(await this.spine.executeSpawn(input.tasks, ctx.signal)),
    };
  }
}

function spawnCapacityAtLeastTwo(): boolean {
  const maxThreads = resolveMaxThreads(process.env[SPINE_SPAWN_MAX_THREADS_ENV]);
  return maxSpawnBranchCount(maxThreads) >= 2;
}

registerTool(SpineSpawnTool, {
  when: (accessor) =>
    accessor.get(IFlagService).enabled(SPINE_FLAG_ID) &&
    accessor.get(IFlagService).enabled(SPINE_SPAWN_FLAG_ID) &&
    accessor.get(IAgentScopeContext).agentId === 'main' &&
    spawnCapacityAtLeastTwo(),
});
