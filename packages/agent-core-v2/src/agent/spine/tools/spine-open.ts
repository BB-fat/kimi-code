/**
 * `spine` domain (L4) — `spine_open` control tool.
 *
 * Receipt-only: validates the child goal and registers the single per-step
 * pending transition through `spine`; the real tree move is committed by the
 * `spine` service after the step once the matching tool result lands in
 * `contextMemory`. Self-registers via `registerTool` gated on the
 * `KIMI_CODE_SPINE` flag; the Eager `AgentBuiltinToolsRegistrar` instantiates
 * one per agent (injecting the Agent-scope `spine`) and registers it into that
 * agent's tool registry. Bound at Agent scope.
 */

import { z } from 'zod';

import { toInputJsonSchema } from '#/tool/input-schema';
import type { BuiltinTool, ToolExecution } from '#/tool/toolContract';
import { registerTool } from '#/agent/toolRegistry/toolContribution';

import { SPINE_FLAG_ID } from '#/agent/spine/flag';
import { IAgentSpineService, SPINE_TOOL_OPEN } from '#/agent/spine/spine';
import { IFlagService } from '#/app/flag/flag';
import { toControlResult } from './controlResult';
import { SPINE_OPEN_DESCRIPTION, SPINE_OPEN_SUMMARY_DESCRIPTION } from './descriptions';

export interface SpineOpenInput {
  readonly summary: string;
}

const SpineOpenInputSchema: z.ZodType<SpineOpenInput> = z.object({
  summary: z.string().min(1).describe(SPINE_OPEN_SUMMARY_DESCRIPTION),
});

export class SpineOpenTool implements BuiltinTool<SpineOpenInput> {
  readonly name = SPINE_TOOL_OPEN;
  readonly description = SPINE_OPEN_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SpineOpenInputSchema);

  constructor(@IAgentSpineService private readonly spine: IAgentSpineService) {}

  resolveExecution(input: SpineOpenInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Open a Spine child node',
      execute: async (ctx) => toControlResult(this.spine.acceptOpen(input.summary, ctx.toolCallId)),
    };
  }
}

registerTool(SpineOpenTool, {
  when: (accessor) => accessor.get(IFlagService).enabled(SPINE_FLAG_ID),
});
