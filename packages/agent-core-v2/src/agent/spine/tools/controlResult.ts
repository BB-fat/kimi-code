/**
 * `spine` domain (L4) — maps a spine transition verdict to an executable tool
 * result: an accepted transition yields the `ACCEPTED_OUTPUT` receipt, which
 * tells the model the tree move has NOT happened yet (it commits once the
 * step's tool result lands in history) — the receipt wording is part of the
 * model-facing contract and `AgentSpineService`'s restore audit matches it
 * verbatim, so auditors import this constant instead of re-spelling it —
 * while a rejected transition surfaces its reason as an error so the model
 * can self-correct on the next step. Pure mapping; consumed by the `open` /
 * `close` / `next` control tools.
 */

import type { ExecutableToolResult } from '#/tool/toolContract';

import type { SpineTransitionResult } from '#/agent/spine/spine';

export const ACCEPTED_OUTPUT = 'accepted — commits after this step completes';

export function toControlResult(result: SpineTransitionResult): ExecutableToolResult {
  if (result.accepted) return { isError: false, output: ACCEPTED_OUTPUT };
  return { isError: true, output: result.reason };
}

/**
 * Receipt of an accepted `spine_trim` call. Unlike a transition receipt the
 * trim takes effect immediately — the receipt landing in history IS the trim
 * — and the trim derivation matches this text verbatim.
 */
export const TRIM_ACCEPTED_OUTPUT = 'trim accepted';

export function toTrimResult(result: SpineTransitionResult): ExecutableToolResult {
  if (result.accepted) return { isError: false, output: TRIM_ACCEPTED_OUTPUT };
  return { isError: true, output: result.reason };
}

/**
 * Maps the result of `IAgentSpineService.executeSpawn` to an executable tool
 * result: accepted fissions return the structured JSON receipt verbatim so it
 * can be matched by `deriveSpineState`; rejected fissions surface the reason as
 * an error so the model can self-correct.
 */
export function toSpawnResult(
  result: SpineTransitionResult & { readonly receipt?: string },
): ExecutableToolResult {
  if (result.accepted) {
    return { isError: false, output: result.receipt ?? '' };
  }
  return { isError: true, output: result.reason };
}
