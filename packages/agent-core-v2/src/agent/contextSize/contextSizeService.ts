/**
 * `contextSize` domain (L4) — `IAgentContextSizeService` implementation.
 *
 * Owns the measured context token counts in the wire `ContextSizeModel`:
 * reads it through `wire.getModel`, writes it through
 * `wire.dispatch(contextSizeMeasured(...))` (called by `llmRequester` after
 * each measured exchange), and emits the `contextTokens` slice of
 * `agent.status.updated` live through `wire.signal` when the measured value
 * changes. `get(start?, end?)` returns `{ size, measured, estimated }` for the
 * context-message range `[start, end)`, resolved like `Array.prototype.slice`
 * (defaulting to the whole context; negative indices count back from the end;
 * an inverted range is empty). `measured` resolves as follows: the full
 * measured-prefix aggregate is exact; a measured-prefix SUB-range diffs the
 * nearest snapshot at or before each endpoint (plus a narrow estimate strip
 * past each anchor) when both endpoints anchor, and otherwise falls back to a
 * per-message estimate; `estimated` is the live token estimate of the
 * not-yet-measured portion, and `size = measured + estimated`. Snapshot-chain
 * bookkeeping lives in `contextSizeOps` (notably: cascade estimate records
 * restart the chain, since their new prefix describes replaced message text).
 * Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { estimateTokensForMessages } from '#/_base/utils/tokens';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { Message } from '#/app/llmProtocol/message';
import type { TokenUsage } from '#/app/llmProtocol/usage';
import { IAgentWireService } from '#/wire/tokens';
import type { IWireService } from '#/wire/wireService';

import { IAgentContextSizeService, type ContextSize, type ContextSizeMeasurement } from './contextSize';
import { ContextSizeModel, type ContextSizeSnapshot, contextSizeMeasured } from './contextSizeOps';

export class AgentContextSizeService extends Disposable implements IAgentContextSizeService {
  declare readonly _serviceBrand: undefined;

  private lastEmittedTokens = 0;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentWireService private readonly wire: IWireService,
  ) {
    super();
  }

  get(start?: number, end?: number): ContextSize {
    const context = this.context.get();
    const model = this.wire.getModel(ContextSizeModel);
    // Mirrors `Array.prototype.slice`: defaults to the whole context, negative
    // indices count back from the end, and an inverted range is empty.
    const from = normalizeSliceIndex(start ?? 0, context.length);
    const to = normalizeSliceIndex(end ?? context.length, context.length);
    const measuredEnd = Math.min(to, model.length);
    const estimatedStart = Math.max(from, model.length);
    // The measured-prefix total is the only deterministic measured value; use
    // it when the range covers the whole prefix.
    const measured =
      from === 0 && measuredEnd === model.length
        ? model.tokens
        : measuredSubRange(context, model.snapshots, from, measuredEnd);
    const estimated = estimateTokensForMessages(context.slice(estimatedStart, to));
    return { size: measured + estimated, measured, estimated };
  }

  measured(input: readonly Message[], output: readonly Message[], usage: TokenUsage): void {
    // Only adopt the measurement when `input` still matches the live context.
    // This rejects stale readings (e.g. the context was spliced, or the request
    // used overridden messages) so a mismatched measurement cannot poison state.
    if (!matchesContext(input, this.context.get())) return;
    const length = input.length + output.length;
    const tokens = tokenUsageTotal(usage);
    this.wire.dispatch(contextSizeMeasured({ length, tokens }));
    this.emitIfChanged();
  }

  latestMeasurement(): ContextSizeMeasurement | undefined {
    const snapshots = this.wire.getModel(ContextSizeModel).snapshots;
    const latest = snapshots.at(-1);
    if (latest === undefined) return undefined;
    return { length: latest.storageLength, tokens: latest.tokens, kind: latest.kind };
  }

  private emitIfChanged(): void {
    const tokens = this.wire.getModel(ContextSizeModel).tokens;
    if (tokens === this.lastEmittedTokens) return;
    this.lastEmittedTokens = tokens;
  }
}

/**
 * Measured size of the stored range `[from, to)`. Diffs snapshot anchors when
 * both endpoints resolve one; a range that can't anchor (no snapshot reaches
 * the endpoint, or the diff came out negative because anchors straddle a
 * mutation) falls back to the per-message estimate.
 */
function measuredSubRange(
  context: readonly ContextMessage[],
  snapshots: readonly ContextSizeSnapshot[],
  from: number,
  to: number,
): number {
  const prefixFrom = prefixTokens(context, snapshots, from);
  const prefixTo = prefixTokens(context, snapshots, to);
  if (prefixFrom === undefined || prefixTo === undefined || prefixTo < prefixFrom) {
    return estimateTokensForMessages(context.slice(from, to));
  }
  return prefixTo - prefixFrom;
}

/**
 * Tokens of the storage prefix `[0, end)`: the newest snapshot at or before
 * `end`, plus a narrow per-message estimate of the strip past it. `undefined`
 * when no snapshot reaches `end`.
 */
function prefixTokens(
  context: readonly ContextMessage[],
  snapshots: readonly ContextSizeSnapshot[],
  end: number,
): number | undefined {
  let anchor: ContextSizeSnapshot | undefined;
  for (const snapshot of snapshots) {
    if (snapshot.storageLength <= end) anchor = snapshot;
  }
  if (anchor === undefined) return undefined;
  return anchor.tokens + estimateTokensForMessages(context.slice(anchor.storageLength, end));
}

function matchesContext(input: readonly Message[], context: readonly ContextMessage[]): boolean {
  if (input.length !== context.length) return false;
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] !== context[index]) return false;
  }
  return true;
}

function tokenUsageTotal(usage: TokenUsage): number {
  return usage.inputCacheRead + usage.inputCacheCreation + usage.inputOther + usage.output;
}

function normalizeSliceIndex(index: number, length: number): number {
  if (index < 0) return Math.max(length + index, 0);
  return Math.min(index, length);
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentContextSizeService,
  AgentContextSizeService,
  InstantiationType.Delayed,
  'contextSize',
);
