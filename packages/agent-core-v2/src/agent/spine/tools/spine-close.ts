/**
 * `spine` domain (L4) — `spine_close` control tool.
 *
 * Receipt-only: validates the continuation memory and registers the single
 * per-step pending transition through `spine`; the real close (memory assembly
 * and tree move) is committed by the `spine` service after the step once the
 * matching tool result lands in `contextMemory`. Self-registers via
 * `registerTool` gated on the `KIMI_CODE_SPINE` flag; the Eager
 * `AgentBuiltinToolsRegistrar` instantiates one per agent. Bound at Agent
 * scope.
 */

import { z } from 'zod';

import { toInputJsonSchema } from '#/_base/tools/support/input-schema';
import type { BuiltinTool, ToolExecution } from '#/agent/tool/toolContract';
import { registerTool } from '#/agent/toolRegistry/toolContribution';

import { isSpineEnabled } from '#/agent/spine/flag';
import { IAgentSpineService, SPINE_TOOL_CLOSE } from '#/agent/spine/spine';
import { toControlResult } from './controlResult';
import { SPINE_CLOSE_DESCRIPTION, SPINE_NODE_MEMORY_DESCRIPTION } from './descriptions';

export interface SpineCloseInput {
  readonly memory: string;
}

const SpineCloseInputSchema: z.ZodType<SpineCloseInput> = z.object({
  memory: z.string().min(1).describe(SPINE_NODE_MEMORY_DESCRIPTION),
});

export class SpineCloseTool implements BuiltinTool<SpineCloseInput> {
  readonly name = SPINE_TOOL_CLOSE;
  readonly description = SPINE_CLOSE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SpineCloseInputSchema);

  constructor(@IAgentSpineService private readonly spine: IAgentSpineService) {}

  resolveExecution(input: SpineCloseInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Close the current Spine node',
      execute: async (ctx) => toControlResult(this.spine.acceptClose(input.memory, ctx.toolCallId)),
    };
  }
}

registerTool(SpineCloseTool, { when: () => isSpineEnabled() });
