/**
 * `spine` domain (L4) — verbatim tool / parameter descriptions for the four
 * Spine control tools, transcribed from the upstream protocol so the model sees
 * an identical contract. Pure string constants; consumed by the tool classes.
 */

export const SPINE_OPEN_DESCRIPTION =
  'Start a focused child node for one small concrete goal under the current Spine cursor.';

export const SPINE_CLOSE_DESCRIPTION =
  'Finish the current Spine node and return compact continuation memory to the parent.';

export const SPINE_NEXT_DESCRIPTION =
  'Finish the current Spine node, return continuation memory for it, and start a new sibling for the next clear, bounded, completable goal under the resumed parent.';

export const SPINE_TREE_DESCRIPTION =
  'Inspect the current Spine tree, cursor, and context status.';

export const SPINE_OPEN_SUMMARY_DESCRIPTION =
  'Concise summary of one small concrete goal for the child node being opened.';

export const SPINE_NEXT_SUMMARY_DESCRIPTION =
  'Concise goal summary for the next sibling node being opened. Name only the next bounded, actionable, completable goal; closure state for the current node belongs in memory.';

export const SPINE_NODE_MEMORY_DESCRIPTION =
  'Continuation memory for the node being closed. Optimize for compact recoverability: preserve the smallest sufficient state that lets future work continue correctly without replaying this node. Treat inherited context and assembled child memory as already available; write only compact deltas and current state needed for continuation. Include objective/status, decisions, artifacts/evidence, validation, constraints or risks, next action when work remains, and [U#] request status. Use precise paths, ids, commit hashes, and test names when they matter.';

export const SPINE_TRIM_DESCRIPTION =
  'Conservatively trim one tagged tool-result projection without changing the Spine tree or creating memory. A TRIM_ID is valid only for the immediately preceding tool-result batch and expires after the next assistant tool request; after a miss, do not retry it. Use slice to retain needed evidence, use snip only after useful facts are preserved, and otherwise leave the result unchanged.';

export const SPINE_TRIM_ID_DESCRIPTION =
  'Trim id attached to a tool response in the immediately previous tool-result batch; it expires after your next assistant tool request.';

export const SPINE_TRIM_OP_DESCRIPTION =
  'Use snip only when useful facts are preserved elsewhere; use slice to keep the needed head, tail, or anchor window.';

export const SPINE_TRIM_HEAD_DESCRIPTION =
  'For op="slice", keep this many characters from the start of the current visible body. Mutually exclusive with tail and anchor.';

export const SPINE_TRIM_TAIL_DESCRIPTION =
  'For op="slice", keep this many characters from the end of the current visible body. Mutually exclusive with head and anchor.';

export const SPINE_TRIM_ANCHOR_DESCRIPTION =
  'For op="slice", locate this non-empty text in the current visible body and keep an anchor window. Mutually exclusive with head and tail.';

export const SPINE_TRIM_PRECEDING_DESCRIPTION =
  'For anchor slice, keep this many complete lines before the anchor line.';

export const SPINE_TRIM_FOLLOWING_DESCRIPTION =
  'For anchor slice, keep this many complete lines after the anchor line.';

export const SPINE_SPAWN_DESCRIPTION =
  'Fission the current continuation into parallel, independent branches. Each branch runs in its own child agent with no supervisory model active; the original continuation is suspended until all branches complete. The branches complete their assignments in parallel, and the host atomically records their outcomes in input order as a structured receipt. Use only when the branches are genuinely independent and can proceed without coordination; do not use spine_spawn for work that requires cross-branch synchronization or a shared plan.';

export const SPINE_SPAWN_TASKS_DESCRIPTION =
  'Array of branch assignments. Must contain at least 2 entries and no more than the current capacity.';

export const SPINE_SPAWN_SUMMARY_DESCRIPTION =
  'Concise branch label, distinct within this spawn call, and its independently owned outcome.';

export const SPINE_SPAWN_PROMPT_DESCRIPTION =
  'Complete branch assignment, including the task, any constraints, and coordination conventions the branch should follow. The branch will be run in isolation with only this prompt and the inherited context.';
