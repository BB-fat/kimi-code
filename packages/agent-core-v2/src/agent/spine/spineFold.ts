/**
 * `spine` domain (L4) — the projection fold that turns the append-only
 * `contextMemory` history into the view sent to the model.
 *
 * `foldSpine` is a pure transform: it drops everything before the current root
 * epoch (keeping the epoch summary), replaces each outermost closed node's raw
 * message span with a single `<spine_memory>` user message (nested closed nodes
 * ride inside their nearest closed ancestor's span, so nothing is folded twice),
 * numbers surviving real user requests with `[U#]` anchors, and appends a
 * synthetic `<spine_status>` orientation line. The stored history is never
 * mutated; token numbers for the status line are precomputed by the `spine`
 * service and passed in. Consumed by `spineService.fold`.
 *
 * Span-firing invariants: a span closed entirely before the current root
 * epoch is owned by the epoch summary and is skipped silently — left queued,
 * it would pin the span scan and keep every post-epoch span raw forever.
 * `spine.next` siblings share one boundary index (the closing node's
 * `closedAt` is the new sibling's `openedAt`), so a span fires once the scan
 * has reached or passed its `openedAt`; otherwise every sibling after the
 * first in a next-chain would stay raw and its memory never injected. A span
 * fully behind the scan is late-drained: its memory is emitted, but the
 * current message still goes through normal handling instead of being
 * skipped.
 *
 * `countUserAnchors` counts the real user requests in a (projected) message
 * list — i.e. the highest `[U#]` anchor a model looking at that view can
 * legitimately cite, since the fold numbers surviving user requests
 * `[U1]..[Un]` in order.
 */

import type { ContextMessage } from '#/agent/contextMemory/types';
import type { ContentPart } from '#/app/llmProtocol/message';

import type { SpineNode, SpineState } from './spineOps';
import { parentNodeId } from './spineTree';

export interface SpineFoldStatus {
  readonly cursorId: string;
  readonly summary: string;
  readonly parentId: string | null;
  readonly cursorContext: number;
  readonly contextLeft: number | undefined;
  /** Per-message estimate of the whole stored history (pre-fold, messages only). */
  readonly rawContext: number;
  /**
   * Whole-context size the remaining-window clamp sees (measured request
   * totals + estimated tail), i.e. what the projected view costs overall.
   */
  readonly projectedContext: number;
  /** Whether `projectedContext` is anchored on an LLM-reported usage record. */
  readonly projectedMeasured: boolean;
}

export interface SpineFoldInput {
  readonly state: SpineState;
  readonly epochSummaryMessage?: ContextMessage;
  readonly status?: SpineFoldStatus;
}

interface ClosedSpan {
  readonly node: SpineNode;
  readonly openedAt: number;
  readonly closedAt: number;
}

export function foldSpine(
  messages: readonly ContextMessage[],
  input: SpineFoldInput,
): ContextMessage[] {
  const spans = outermostClosedSpans(input.state);
  let spanIndex = 0;
  let userAnchor = 0;
  const out: ContextMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message === undefined) continue;

    if (i < input.state.epochStartAt) {
      if (
        input.epochSummaryMessage !== undefined &&
        input.state.epochMemoryAt !== undefined &&
        i === input.state.epochMemoryAt
      ) {
        out.push(input.epochSummaryMessage);
      }
      continue;
    }

    let span = spans[spanIndex];
    while (span !== undefined && span.closedAt < input.state.epochStartAt) {
      spanIndex += 1;
      span = spans[spanIndex];
    }
    if (span !== undefined && span.openedAt <= i) {
      const memoryMessage = spineMemoryMessage(span.node);
      if (memoryMessage !== undefined) out.push(memoryMessage);
      spanIndex += 1;
      if (span.closedAt >= i) {
        i = span.closedAt;
        continue;
      }
    }

    if (isUserRequest(message)) {
      userAnchor += 1;
      out.push(annotateUserRequest(message, userAnchor));
    } else {
      out.push(message);
    }
  }

  if (input.status !== undefined) {
    out.push(statusMessage(input.status));
  }

  return out;
}

function outermostClosedSpans(state: SpineState): readonly ClosedSpan[] {
  const closed = new Map<string, SpineNode>();
  for (const node of Object.values(state.nodes)) {
    if (node.closedAt !== undefined && node.openedAt >= 0 && node.memory !== undefined) {
      closed.set(node.id, node);
    }
  }

  const spans: ClosedSpan[] = [];
  for (const node of closed.values()) {
    if (!hasClosedAncestor(node, state, closed)) {
      spans.push({ node, openedAt: node.openedAt, closedAt: node.closedAt ?? node.openedAt });
    }
  }
  spans.sort((a, b) => a.openedAt - b.openedAt);
  return spans;
}

function hasClosedAncestor(
  node: SpineNode,
  state: SpineState,
  closed: ReadonlyMap<string, SpineNode>,
): boolean {
  let ancestorId = parentNodeId(node.id);
  while (ancestorId !== null) {
    if (closed.has(ancestorId)) return true;
    const ancestor = state.nodes[ancestorId];
    ancestorId = ancestor === undefined ? null : parentNodeId(ancestor.id);
  }
  return false;
}

function spineMemoryMessage(node: SpineNode): ContextMessage | undefined {
  const memory = node.memory;
  if (memory === undefined) return undefined;
  return {
    role: 'user',
    content: [{ type: 'text', text: `<spine_memory>\n${memory}\n</spine_memory>` }],
    toolCalls: [],
    origin: { kind: 'injection', variant: 'spine_memory' },
  };
}

export function isUserRequest(message: ContextMessage): boolean {
  return message.role === 'user' && message.origin?.kind === 'user';
}

export function countUserAnchors(messages: readonly ContextMessage[]): number {
  return messages.filter(isUserRequest).length;
}

function annotateUserRequest(message: ContextMessage, anchorNumber: number): ContextMessage {
  const anchor = `[U${String(anchorNumber)}] `;
  const content = prefixFirstText(message.content, anchor);
  if (content === message.content) return message;
  return { ...message, content };
}

function prefixFirstText(content: readonly ContentPart[], anchor: string): ContentPart[] {
  const index = content.findIndex((part) => part.type === 'text');
  if (index < 0) {
    return [{ type: 'text', text: anchor.trimEnd() }, ...content];
  }
  return content.map((part, position) =>
    position === index && part.type === 'text' ? { type: 'text', text: anchor + part.text } : part,
  );
}

function statusMessage(status: SpineFoldStatus): ContextMessage {
  const parent = status.parentId === null ? '' : ` parent="${status.parentId}"`;
  const cursorContext = ` cursor_context="~${formatTokens(status.cursorContext)}"`;
  const contextLeft =
    status.contextLeft === undefined ? '' : ` context_left="~${formatTokens(status.contextLeft)}"`;
  const rawContext = ` raw_context="~${formatTokens(status.rawContext)}"`;
  const projectedPrefix = status.projectedMeasured ? '' : '~';
  const projectedContext = ` projected_context="${projectedPrefix}${formatTokens(
    status.projectedContext,
  )}"`;
  const text = `<spine_status cursor="${status.cursorId}" summary="${escapeAttr(status.summary)}"${parent}${cursorContext}${contextLeft}${rawContext}${projectedContext} />`;
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin: { kind: 'injection', variant: 'spine_status' },
  };
}

function formatTokens(tokens: number): string {
  const safe = Math.max(0, tokens);
  if (safe >= 1000) return `${(safe / 1000).toFixed(safe >= 10000 ? 0 : 1)}K`;
  return String(safe);
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}
