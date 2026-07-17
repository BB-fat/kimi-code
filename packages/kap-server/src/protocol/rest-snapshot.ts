/**
 * `GET /v1/sessions/{session_id}/snapshot` — IM-style "initial sync".
 *
 * Returns an atomic-at-a-watermark view of everything a client needs to
 * rebuild a session's UI state, so the standard multi-device rebuild flow is:
 *
 *   1. `GET /sessions/{sid}/snapshot`            → state + `as_of_seq` + `epoch`
 *   2. WS `subscribe` with `cursors[sid] = { seq: as_of_seq, epoch }`
 *   3. apply live durable events (`seq > as_of_seq`) on top
 *
 * `in_flight_turn` carries the accumulated state of a currently-running turn
 * (volatile deltas are not replayable; this is how a reconnecting client
 * recovers mid-turn assistant/thinking text and running tool calls).
 */

import { z } from 'zod';

import { messageSchema } from '@moonshot-ai/agent-core-v2/agent/contextMemory/protocolMessage';

import { approvalRequestSchema } from './approval';
import { questionRequestSchema } from './question';
import { sessionSchema } from './session';
import { taskSchema } from './task';

export const inFlightToolCallSchema = z.object({
  tool_call_id: z.string().min(1),
  name: z.string().min(1),
  args: z.unknown().optional(),
  description: z.string().optional(),
  /** Display payload from `tool.call.started` (ToolInputDisplay). */
  display: z.unknown().optional(),
  /** Most recent `tool.progress` update, if any. */
  last_progress: z
    .object({
      kind: z.enum(['stdout', 'stderr', 'progress', 'status', 'custom']),
      text: z.string().optional(),
      percent: z.number().optional(),
    })
    .optional(),
});
export type InFlightToolCall = z.infer<typeof inFlightToolCallSchema>;

export const inFlightTurnSchema = z.object({
  turn_id: z.number().int().nonnegative(),
  /** Assistant text accumulated from `assistant.delta` in the current step (reset on `turn.step.started`; earlier steps are in `messages`). */
  assistant_text: z.string(),
  /** Thinking text accumulated from `thinking.delta` in the current step (reset on `turn.step.started`). */
  thinking_text: z.string(),
  /** Tool calls started but without a `tool.result` yet. */
  running_tools: z.array(inFlightToolCallSchema),
  /** Daemon prompt_id of the active prompt, if the turn was started by IPromptService. */
  current_prompt_id: z.string().optional(),
});
export type InFlightTurn = z.infer<typeof inFlightTurnSchema>;

/**
 * A live subagent task as of the snapshot watermark. Extends the base task
 * wire shape with the swarm identity metadata that otherwise only rides the
 * (non-replayed) `subagent.spawned` WS event.
 */
export const snapshotSubagentSchema = taskSchema.extend({
  subagent_phase: z.enum(['queued', 'working', 'suspended', 'completed', 'failed']).optional(),
  subagent_type: z.string().optional(),
  parent_tool_call_id: z.string().optional(),
  suspended_reason: z.string().optional(),
  swarm_index: z.number().int().nonnegative().optional(),
  run_in_background: z.boolean().optional(),
});
export type SnapshotSubagent = z.infer<typeof snapshotSubagentSchema>;

/**
 * One node of the server-derived spine task tree (agent-core-v2
 * `spineTreeViewFromState`, flattened with snake_case keys).
 */
export const spineTreeNodeSchema = z.object({
  id: z.string().min(1),
  parent_id: z.string().min(1).nullable(),
  title: z.string(),
  memory: z.string(),
  token_cost: z.number(),
  status: z.enum(['active', 'closed', 'canceled']),
  error: z.string().nullable(),
});
export type SpineTreeNode = z.infer<typeof spineTreeNodeSchema>;

/**
 * Seed of the session's FULL spine task tree, derived server-side from the
 * complete (pre-window) transcript via `deriveSpineState` +
 * `spineTreeViewFromState`, so a client rebuilding from the bounded
 * `messages.items` page still sees nodes whose transitions fell outside the
 * window. `covered_through_id` is the wire id of the last message in
 * `messages.items`: the client folds only live messages arriving after it.
 */
export const spineTreeViewSchema = z.object({
  covered_through_id: z.string().min(1).nullable(),
  nodes: z.array(spineTreeNodeSchema),
});
export type SpineTreeView = z.infer<typeof spineTreeViewSchema>;

export const sessionSnapshotResponseSchema = z.object({
  /** Durable event watermark this snapshot is consistent with. */
  as_of_seq: z.number().int().nonnegative(),
  /** Journal epoch — pass back via the WS cursor for invalidation detection. */
  epoch: z.string().min(1),
  session: sessionSchema,
  /** Most recent messages (chronological ascending), bounded page. */
  messages: z.object({
    items: z.array(messageSchema),
    has_more: z.boolean(),
  }),
  in_flight_turn: inFlightTurnSchema.nullable(),
  /**
   * Roster of live subagent tasks at the watermark, so a reconnecting client
   * can rebuild swarm cards before the swarm's tool result lands. Optional
   * for cross-version tolerance: older servers do not send it.
   */
  subagents: z.array(snapshotSubagentSchema).optional(),
  /**
   * Seed of the full spine task tree, derived from the complete transcript
   * (`deriveSpineState` + `spineTreeViewFromState`). Optional for
   * cross-version tolerance: older servers do not send it, and a derivation
   * failure drops the field instead of failing the snapshot.
   */
  spine_tree: spineTreeViewSchema.optional(),
  pending_approvals: z.array(approvalRequestSchema),
  pending_questions: z.array(questionRequestSchema),
});
export type SessionSnapshotResponse = z.infer<typeof sessionSnapshotResponseSchema>;
