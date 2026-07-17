/**
 * `spine` domain (L4) — Agent-scoped spine service contract and the tool-name
 * constants shared by the four control tools.
 *
 * `IAgentSpineService` is the boundary between the read-only / receipt-only
 * control tools and the tree state machine: the tools hand validated intent to
 * the service (which registers a per-step pending transition) and read the
 * rendered tree back; the service commits those transitions after each step
 * once the matching tool result has landed in `contextMemory`. It also owns
 * archive publication: node archives on close / next, and the epoch archive
 * the full-compaction flow publishes before dispatching `spine.root_compact`.
 * Bound at Agent scope.
 */

import { createDecorator } from '#/_base/di/instantiation';
import type { ContextMessage } from '#/agent/contextMemory/types';

import type { SpineEpochArchiveInput } from './spineArchive';
import type { SpineState } from './spineOps';

export const SPINE_TOOL_OPEN = 'spine_open';
export const SPINE_TOOL_CLOSE = 'spine_close';
export const SPINE_TOOL_NEXT = 'spine_next';
export const SPINE_TOOL_TREE = 'spine_tree';

/**
 * All four spine control tool names. Profiles whitelist these so the main
 * agent's active-tool filter lets the registered tools through; surfaces that
 * merely display a profile's tool list (e.g. the `Agent` tool description)
 * filter them out instead, since the tools register only for the main agent.
 */
export const SPINE_TOOL_NAMES = [
  SPINE_TOOL_OPEN,
  SPINE_TOOL_CLOSE,
  SPINE_TOOL_NEXT,
  SPINE_TOOL_TREE,
] as const;

export type SpineControlToolName =
  | typeof SPINE_TOOL_OPEN
  | typeof SPINE_TOOL_CLOSE
  | typeof SPINE_TOOL_NEXT;

export interface SpineTransitionAccepted {
  readonly accepted: true;
}

export interface SpineTransitionRejected {
  readonly accepted: false;
  readonly reason: string;
}

export type SpineTransitionResult = SpineTransitionAccepted | SpineTransitionRejected;

export interface IAgentSpineService {
  readonly _serviceBrand: undefined;

  readonly enabled: boolean;

  acceptOpen(summary: string): SpineTransitionResult;
  acceptClose(memory: string): SpineTransitionResult;
  acceptNext(summary: string, memory: string): SpineTransitionResult;

  archiveEpochRoot(input: SpineEpochArchiveInput): Promise<string | undefined>;

  renderTree(): string;

  fold(messages: readonly ContextMessage[]): readonly ContextMessage[];

  /** The current tree state, derived from the message stream on read. */
  currentState(): SpineState;
}

export const IAgentSpineService = createDecorator<IAgentSpineService>('agentSpineService');
