/**
 * `spine` domain (L4) — `spine_tree` control tool.
 *
 * Read-only: renders the current Spine tree, cursor and per-node status through
 * `spine.renderTree()` so the model can re-orient; it never registers a
 * transition. Self-registers via `registerTool` gated on the `KIMI_CODE_SPINE`
 * flag and `agentId === 'main'` (main-agent-only, like the goal tools); the
 * Eager `AgentBuiltinToolsRegistrar` registers it into the main agent's tool
 * registry only, never a sub-agent's. Bound at Agent scope.
 */

import { z } from 'zod';

import { toInputJsonSchema } from '#/tool/input-schema';
import type { BuiltinTool, ToolExecution } from '#/tool/toolContract';
import { registerTool } from '#/agent/toolRegistry/toolContribution';

import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { SPINE_FLAG_ID } from '#/agent/spine/flag';
import { IAgentSpineService, SPINE_TOOL_TREE } from '#/agent/spine/spine';
import { IFlagService } from '#/app/flag/flag';
import { SPINE_TREE_DESCRIPTION } from './descriptions';

const SpineTreeInputSchema = z.object({});

export class SpineTreeTool implements BuiltinTool<Record<string, never>> {
  readonly name = SPINE_TOOL_TREE;
  readonly description = SPINE_TREE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SpineTreeInputSchema);

  constructor(@IAgentSpineService private readonly spine: IAgentSpineService) {}

  resolveExecution(): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Inspect the Spine tree',
      execute: async () => ({ isError: false, output: this.spine.renderTree() }),
    };
  }
}

registerTool(SpineTreeTool, {
  when: (accessor) =>
    accessor.get(IFlagService).enabled(SPINE_FLAG_ID) &&
    accessor.get(IAgentScopeContext).agentId === 'main',
});
