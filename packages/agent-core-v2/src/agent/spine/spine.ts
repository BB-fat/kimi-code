/**
 * `spine` domain (L4) — Agent-scoped spine service contract and the tool-name
 * constants shared by the four control tools.
 *
 * `IAgentSpineService` is the boundary between the read-only / receipt-only
 * control tools and the tree state machine: the tools hand validated intent to
 * the service (which registers a per-step pending transition) and read the
 * rendered tree back; the service commits those transitions after each step
 * once the matching tool result has landed in `contextMemory`. Bound at Agent
 * scope.
 */

import { createDecorator } from '#/_base/di/instantiation';
import type { ContextMessage } from '#/agent/contextMemory/types';

export const SPINE_TOOL_OPEN = 'spine_open';
export const SPINE_TOOL_CLOSE = 'spine_close';
export const SPINE_TOOL_NEXT = 'spine_next';
export const SPINE_TOOL_TREE = 'spine_tree';

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

  acceptOpen(summary: string, toolCallId: string): SpineTransitionResult;
  acceptClose(memory: string, toolCallId: string): SpineTransitionResult;
  acceptNext(summary: string, memory: string, toolCallId: string): SpineTransitionResult;

  renderTree(): string;

  fold(messages: readonly ContextMessage[]): readonly ContextMessage[];
}

export const IAgentSpineService = createDecorator<IAgentSpineService>('agentSpineService');
