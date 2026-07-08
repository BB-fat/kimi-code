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
