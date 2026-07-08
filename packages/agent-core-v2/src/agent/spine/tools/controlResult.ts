/**
 * `spine` domain (L4) — maps a spine transition verdict to an executable tool
 * result: an accepted transition yields the literal `accepted` receipt the
 * upstream protocol uses (the real tree move happens later, on observed
 * evidence), while a rejected transition surfaces its reason as an error so the
 * model can self-correct on the next step. Pure mapping; consumed by the
 * `open` / `close` / `next` control tools.
 */

import type { ExecutableToolResult } from '#/agent/tool/toolContract';

import type { SpineTransitionResult } from '#/agent/spine/spine';

const ACCEPTED_OUTPUT = 'accepted';

export function toControlResult(result: SpineTransitionResult): ExecutableToolResult {
  if (result.accepted) return { isError: false, output: ACCEPTED_OUTPUT };
  return { isError: true, output: result.reason };
}
