/**
 * `spine` domain (L4) — `IAgentSpineService` implementation.
 *
 * The task tree is DERIVED, not stored: `deriveSpineState` replays the
 * `contextMemory` message stream and rebuilds the `SpineState` from the spine
 * control-tool calls and their accepted receipts, so the persisted history is
 * the single source of truth — a receipt that survived IS the transition, and
 * a truncation (undo / clear) truncates the tree by construction, with no
 * commit dance, no repair op, and no lost-commit audit. The read-only /
 * receipt-only control tools hand validated intent here (`acceptOpen` /
 * `acceptClose` / `acceptNext`); acceptance checks the derived cursor position,
 * enforces the single-transition-per-step rule, and records the node's
 * provider-token baseline / closing high-water mark via `contextSize` —
 * surfaced as per-node cost in `spine_tree` and as the projected-growth
 * `cursor_context` delta in `<spine_status>`. A closing span ends before the
 * assistant message carrying the transition call, so the carrier, its receipt,
 * and any slower tool results batched in the same response stay visible and
 * paired in the parent context; `spine.next` hands the carrier to the new
 * sibling, whose span opens right after the closing one. At close the span's
 * real user requests are compiled into the memory body as `## User Message
 * [U#]` sections (with the fold's stable ordinals) by the derivation, so
 * `[U#]` citations stay resolvable after the span folds away — and an undo
 * that removes a request removes it from the memory too, since the body is
 * re-assembled from the surviving history on every read. Side effects ride
 * the derivation delta: the `loop.afterStep` hook archives each newly closed
 * node's trajectory under the bootstrap-issued per-agent session homedir
 * (`<sessionDir>/agents/<id>/spine/`), and — for root compactions — the
 * full-compaction flow archives the history the new epoch boundary folds away
 * (`archiveEpochRoot`). Archive paths are deterministic (`f(homedir, nodeId)`),
 * so a restore re-derives them and the first post-restore sweep rewrites any
 * archive a crash lost. Persistence failures are never swallowed: a failed
 * archive write is reported through `onUnexpectedError`, and the node's memory
 * carries the failure note in the projection from then on. Renders the
 * read-only `spine_tree` view across every root epoch (current first by
 * numeric order), so a superseded epoch's closed-node archives stay
 * discoverable after a root compaction. Registers its history fold into
 * `contextProjector` and its `<spine_view>` prompt block into `llmRequester`
 * (spine → projector / llmRequester, never the reverse); the prompt
 * contribution self-gates per request, so only turn requests whose tool list
 * can act on the protocol (i.e. that offer `spine_open`) carry it — sub-agents
 * and operations such as compaction never see it. Self-checks the
 * `KIMI_CODE_SPINE` gate at construction, so a disabled spine never observes
 * history. Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { estimateTokensForMessages } from '#/_base/utils/tokens';
import { COMPACTION_SUMMARY_PREFIX } from '#/agent/contextMemory/compactionHandoff';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentContextProjectorService } from '#/agent/contextProjector/contextProjector';
import { IAgentContextSizeService } from '#/agent/contextSize/contextSize';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventBus } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IWireService } from '#/wire/wire';

import { SPINE_FLAG_ID } from './flag';
import { appendSpineView, loadSpineViewOverride } from './instructions';
import {
  IAgentSpineService,
  SPINE_TOOL_OPEN,
  type SpineTransitionResult,
} from './spine';
import {
  buildArchiveContent,
  buildEpochArchiveContent,
  spineArchivePath,
  writeNodeArchive,
  type SpineEpochArchiveInput,
} from './spineArchive';
import { deriveSpineState } from './spineDerive';
import { foldSpine, type SpineFoldStatus } from './spineFold';
import { type SpineNode, type SpineState } from './spineOps';
import {
  childNodeId,
  isRootEpoch,
  nextChildIndex,
  parentNodeId,
  renderTree,
  type SpineTreeNodeView,
} from './spineTree';

const REJECT_DISABLED: SpineTransitionResult = {
  accepted: false,
  reason: 'Spine is disabled. Set KIMI_CODE_SPINE=1 to enable it.',
};

const REJECT_CONFLICT: SpineTransitionResult = {
  accepted: false,
  reason:
    'A single assistant response may include at most one Spine transition (open, close, or next).',
};

const REJECT_ROOT_EPOCH: SpineTransitionResult = {
  accepted: false,
  reason:
    'Root-epoch nodes cannot be closed. Use open to start a child node under the current scope.',
};

const ARCHIVE_FAILURE_NOTE =
  '[spine: the trajectory archive for this node could not be written; its detailed history was not persisted.]';

export class AgentSpineService extends Disposable implements IAgentSpineService {
  declare readonly _serviceBrand: undefined;

  /** Single-transition-per-step gate; set by an accept, cleared at step bounds. */
  private transitionThisStep = false;
  private cachedMessages: readonly ContextMessage[] | undefined;
  private cachedState: SpineState | undefined;
  /**
   * Ephemeral per-node token gauges, recorded at accept time. Token baselines
   * are not in the message stream, so pure derivation cannot recover them —
   * and `context_size.measured` is live-only (`persist: false`, v1-compat), so
   * the measurement history is gone on restore too. Within a session these
   * maps are complete and request-caliber (better coverage than the FIFO-64
   * snapshot chain); on restore they reset, so pre-restore nodes lose
   * `tokenCost` and the cursor's `cursor_context` reads as the full size. That
   * overstatement fails SAFE for a compaction-trigger gauge (premature close,
   * never overflow). Persisting measurements would fix it but is
   * contextSize-domain v1 work, out of spine's scope.
   */
  private readonly baselines = new Map<string, number>();
  private readonly finals = new Map<string, number>();
  /** Closed nodes whose trajectory archive is on disk (or rewritten already). */
  private readonly archivedIds = new Set<string>();
  /**
   * Nodes (or epochs) whose archive write failed. For a work node the failure
   * note is patched into its memory; an epoch node carries no memory, so its id
   * only suppresses the published archive path — the tree never points at a
   * missing file, and the failure is reported through `onUnexpectedError`
   * either way.
   */
  private readonly failedArchiveIds = new Set<string>();
  private spineViewOverride: string | undefined;
  private spineViewReady: Promise<void> = Promise.resolve();

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentContextSizeService private readonly contextSize: IAgentContextSizeService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @IHostEnvironment private readonly hostEnv: IHostEnvironment,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IFlagService private readonly flags: IFlagService,
    @ISessionContext private readonly sessionCtx: ISessionContext,
    @IAgentScopeContext private readonly agentScope: IAgentScopeContext,
    @IWireService private readonly wire: IWireService,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentLoopService loop: IAgentLoopService,
    @IAgentContextProjectorService projector: IAgentContextProjectorService,
    @IAgentLLMRequesterService llmRequester: IAgentLLMRequesterService,
  ) {
    super();
    if (this.enabled) {
      // Awaited in the will-begin-step hook before the first request assembles
      // its system prompt, so every request of this agent carries the same
      // `<spine_view>` — a mid-session swap from the default to the override
      // would invalidate the prompt prefix cache from position 0.
      this.spineViewReady = loadSpineViewOverride(this.hostFs, this.hostEnv.homeDir).then(
        (override) => {
          this.spineViewOverride = override;
        },
      );
      // Fold registration is the only thing the projector ever learns about
      // spine; gated on the flag so a disabled spine never touches the
      // projection. Construction is Eager, so this lands before the first send.
      this._register(projector.registerContextFold('spine', (messages) => this.fold(messages)));
    }
    this._register(
      llmRequester.registerSystemPromptContribution('spine', (prompt, context) => {
        if (!this.enabled) return prompt;
        if (context.source?.type !== 'turn') return prompt;
        if (!context.tools.some((tool) => tool.name === SPINE_TOOL_OPEN)) return prompt;
        return appendSpineView(prompt, this.spineViewOverride);
      }),
    );
    this._register(
      loop.hooks.onWillBeginStep.register('spine', async (ctx, next) => {
        await this.spineViewReady;
        // A step that ended without its did-finish hook (an abort) may have
        // left the gate set; every step starts with a clean transition budget.
        this.transitionThisStep = false;
        await next();
      }),
    );
    this._register(
      loop.hooks.onDidFinishStep.register('spine', async (_ctx, next) => {
        this.transitionThisStep = false;
        await this.archiveNewlyClosed();
        await next();
      }),
    );
    this._register(
      this.wire.hooks.onDidRestore.register('spine', async (_ctx, next) => {
        // The restored history re-derives the tree on first read; the ephemeral
        // gauges and archive ledger belong to the pre-restore session. Clearing
        // the archive ledger makes the first post-restore sweep rewrite every
        // closed node's archive — deterministic content, so a crash between a
        // close and its sweep self-heals.
        this.cachedMessages = undefined;
        this.cachedState = undefined;
        this.baselines.clear();
        this.finals.clear();
        this.archivedIds.clear();
        this.failedArchiveIds.clear();
        await next();
      }),
    );
    this._register(
      this.eventBus.subscribe('context.spliced', (event) => {
        if (!this.enabled) return;
        if (event.deleteCount === 0) return;
        // A truncation (undo / clear) can make the derivation reuse a node id
        // for a DIFFERENT span: a cleared tree restarts numbering at 1.1.1, and
        // an undo that removes a close lets the same node close again with a new
        // span. The archive ledger is keyed by id, so left alone it would skip
        // the reused id and keep publishing the OLD node's archive path. Clear
        // it so the next sweep rewrites surviving archives (deterministic
        // content — a harmless no-op for unaffected nodes) and archives reused
        // ids fresh.
        this.archivedIds.clear();
        this.failedArchiveIds.clear();
      }),
    );
  }

  get enabled(): boolean {
    return this.flags.enabled(SPINE_FLAG_ID);
  }

  acceptOpen(summary: string): SpineTransitionResult {
    const guard = this.guard();
    if (guard !== null) return guard;
    const trimmed = summary.trim();
    if (trimmed.length === 0) return reject('open summary must not be empty.');
    const state = this.derivedState();
    const parentId = topOf(state);
    const parent = state.nodes[parentId];
    if (parent !== undefined) {
      this.baselines.set(
        childNodeId(parentId, nextChildIndex(parent.children)),
        this.contextSize.get().size,
      );
    }
    this.transitionThisStep = true;
    return { accepted: true };
  }

  acceptClose(memory: string): SpineTransitionResult {
    const guard = this.guard();
    if (guard !== null) return guard;
    const trimmed = memory.trim();
    if (trimmed.length === 0) return reject('close memory must not be empty.');
    const cursorId = this.cursorId();
    if (isRootEpoch(cursorId)) return REJECT_ROOT_EPOCH;
    this.finals.set(cursorId, this.contextSize.get().size);
    this.transitionThisStep = true;
    return { accepted: true };
  }

  acceptNext(summary: string, memory: string): SpineTransitionResult {
    const guard = this.guard();
    if (guard !== null) return guard;
    const trimmedSummary = summary.trim();
    const trimmedMemory = memory.trim();
    if (trimmedSummary.length === 0) return reject('next summary must not be empty.');
    if (trimmedMemory.length === 0) return reject('next memory must not be empty.');
    const cursorId = this.cursorId();
    if (isRootEpoch(cursorId)) return REJECT_ROOT_EPOCH;
    const state = this.derivedState();
    const parentId = parentNodeId(cursorId);
    const parent = parentId === null ? undefined : state.nodes[parentId];
    const sizeNow = this.contextSize.get().size;
    this.finals.set(cursorId, sizeNow);
    if (parentId !== null && parent !== undefined) {
      this.baselines.set(childNodeId(parentId, nextChildIndex(parent.children)), sizeNow);
    }
    this.transitionThisStep = true;
    return { accepted: true };
  }

  renderTree(): string {
    const state = this.state();
    const used = this.contextSize.get().size;
    return renderTree({
      cursorId: this.cursorId(),
      rootIds: epochRootIds(state),
      resolve: (id) => this.nodeView(state, id, used),
    });
  }

  fold(messages: readonly ContextMessage[]): readonly ContextMessage[] {
    if (!this.enabled) return messages;
    const state = this.state();
    const epochSummaryMessage =
      state.epochMemoryAt === undefined ? undefined : messages[state.epochMemoryAt];
    return foldSpine(messages, { state, status: this.buildStatus(), epochSummaryMessage });
  }

  currentState(): SpineState {
    return this.state();
  }

  private buildStatus(): SpineFoldStatus {
    const state = this.state();
    const cursorId = topOf(state);
    const summary = state.nodes[cursorId]?.summary ?? '';
    const parentId = parentNodeId(cursorId);
    const parentSummary = parentId === null ? null : (state.nodes[parentId]?.summary ?? null);
    const maxContextTokens = this.profile.getEffectiveMaxContextTokens();
    const used = this.contextSize.get().size;
    const contextLeft =
      maxContextTokens !== undefined && maxContextTokens > 0
        ? Math.max(0, maxContextTokens - used)
        : undefined;
    return {
      cursorId,
      summary,
      parentId,
      parentSummary,
      // Projected-growth caliber: the live gauge minus the node's open
      // baseline. The stored-range reading this replaces counted folded-away
      // child/sibling spans the model no longer sees, drifting the budget
      // signal apart from the compaction trigger's caliber; a node whose
      // folds reclaimed more than it added reads as zero.
      cursorContext: Math.max(0, used - (this.baselines.get(cursorId) ?? 0)),
      contextLeft,
      rawContext: estimateTokensForMessages(this.context.get()),
      projectedContext: used,
      projectedMeasured: this.contextSize.latestMeasurement()?.kind === 'measured',
    };
  }

  private guard(): SpineTransitionResult | null {
    if (!this.enabled) return REJECT_DISABLED;
    if (this.transitionThisStep) return REJECT_CONFLICT;
    return null;
  }

  /**
   * The projection-facing state: the derivation plus the archive-failure note
   * patched into the affected nodes' memory, so the model learns from the next
   * projection on that the detailed trajectory was not persisted.
   */
  private state(): SpineState {
    const derived = this.derivedState();
    if (this.failedArchiveIds.size === 0) return derived;
    let nodes: Record<string, SpineNode> | undefined;
    for (const id of this.failedArchiveIds) {
      const node = derived.nodes[id];
      if (node?.memory === undefined) continue;
      nodes ??= { ...derived.nodes };
      nodes[id] = { ...node, memory: `${node.memory}\n\n${ARCHIVE_FAILURE_NOTE}` };
    }
    return nodes === undefined ? derived : { ...derived, nodes };
  }

  private derivedState(): SpineState {
    const messages = this.context.get();
    // The wire hands back the same array reference until an op mutates it, so
    // a reference hit means the derivation is still valid.
    if (this.cachedState !== undefined && this.cachedMessages === messages) {
      return this.cachedState;
    }
    const state = deriveSpineState(messages);
    this.cachedMessages = messages;
    this.cachedState = state;
    return state;
  }

  private cursorId(): string {
    return topOf(this.derivedState());
  }

  private nodeView(state: SpineState, id: string, used: number): SpineTreeNodeView | undefined {
    const node = state.nodes[id];
    if (node === undefined) return undefined;
    const epoch = isRootEpoch(id);
    const supersededEpoch = epoch && id !== String(state.rootEpoch);
    const closed = node.closedAt !== undefined || supersededEpoch;
    return {
      id: node.id,
      summary: node.summary,
      closed,
      archivePath: this.nodeArchivePath(id, epoch, closed),
      tokenCost: nodeTokenCost(node, used, this.baselines, this.finals),
      children: node.children
        .map((childId) => this.nodeView(state, childId, used))
        .filter((child): child is SpineTreeNodeView => child !== undefined),
    };
  }

  // Archive paths are deterministic, so the tree publishes them without
  // persisting anything; a write that failed (this session) suppresses the
  // path instead of pointing at a missing file. The epoch archive written
  // when epoch N began (holding the prior epochs' folded history) is named
  // for N, so epoch 1 predates all archiving and shows none.
  private nodeArchivePath(id: string, epoch: boolean, closed: boolean): string | undefined {
    if (this.failedArchiveIds.has(id)) return undefined;
    if (epoch) return Number(id) > 1 ? this.archivePath(id) : undefined;
    return closed ? this.archivePath(id) : undefined;
  }

  /**
   * Projection-delta archiving: every closed node the derivation reports and
   * the ledger has not archived yet gets its trajectory written. Runs at step
   * end (and effectively on the first step end after a restore, since the
   * ledger starts empty), so a close and its archive are at most one step
   * apart and a lost write self-heals on the next session.
   */
  private async archiveNewlyClosed(): Promise<void> {
    if (!this.enabled) return;
    const state = this.derivedState();
    const messages = this.context.get();
    for (const node of Object.values(state.nodes)) {
      if (node.closedAt === undefined || node.openedAt < 0) continue;
      if (this.archivedIds.has(node.id) || this.failedArchiveIds.has(node.id)) continue;
      const path = this.archivePath(node.id);
      const span = messages.slice(Math.max(0, node.openedAt), node.closedAt + 1);
      const content = buildArchiveContent({ node, messages: span });
      try {
        await writeNodeArchive(this.hostFs, path, content);
        this.archivedIds.add(node.id);
      } catch (error) {
        onUnexpectedError(error);
        this.failedArchiveIds.add(node.id);
      }
    }
    await this.archiveCurrentEpochBoundary(state, messages);
  }

  /**
   * The current epoch's boundary archive is written by the full-compaction
   * flow when the epoch begins, but that write is a side effect the ledger
   * does not retry: a transient failure (or a crash mid-write) leaves the file
   * missing, and a later restore clears the failure ledger so the tree
   * publishes the path again — pointing at a file that was never written.
   * Reconstruct it here from the derived boundary (the summary message and the
   * pre-boundary history are both in the surviving stream) so the published
   * path always names a real file. Only the CURRENT epoch is reconstructible —
   * the derived state carries its boundary, not older epochs', whose archives
   * their own compactions already wrote.
   */
  private async archiveCurrentEpochBoundary(
    state: SpineState,
    messages: readonly ContextMessage[],
  ): Promise<void> {
    const epoch = state.rootEpoch;
    if (epoch <= 1) return;
    const id = String(epoch);
    if (this.archivedIds.has(id) || this.failedArchiveIds.has(id)) return;
    const memoryAt = state.epochMemoryAt;
    if (memoryAt === undefined) return;
    const summaryMessage = messages[memoryAt];
    if (summaryMessage === undefined) return;
    const content = buildEpochArchiveContent({
      epoch,
      epochStartAt: state.epochStartAt,
      epochMemoryAt: memoryAt,
      summary: stripCompactionSummaryPrefix(messageText(summaryMessage)),
      messages: messages.slice(0, memoryAt),
    });
    try {
      await writeNodeArchive(this.hostFs, this.archivePath(id), content);
      this.archivedIds.add(id);
    } catch (error) {
      onUnexpectedError(error);
      this.failedArchiveIds.add(id);
    }
  }

  async archiveEpochRoot(input: SpineEpochArchiveInput): Promise<string | undefined> {
    if (!this.enabled) return undefined;
    const path = this.archivePath(String(input.epoch));
    const content = buildEpochArchiveContent(input);
    try {
      await writeNodeArchive(this.hostFs, path, content);
      this.archivedIds.add(String(input.epoch));
      return path;
    } catch (error) {
      onUnexpectedError(error);
      this.failedArchiveIds.add(String(input.epoch));
      return undefined;
    }
  }

  // `<sessionDir>/agents/<id>` is assembled by bootstrap alone (business code
  // never builds it); spine only appends its `spine/` suffix underneath.
  private archivePath(nodeId: string): string {
    return spineArchivePath(
      this.bootstrap.agentHomedir(
        this.sessionCtx.workspaceId,
        this.sessionCtx.sessionId,
        this.agentScope.agentId,
      ),
      nodeId,
    );
  }
}

function epochRootIds(state: SpineState): readonly string[] {
  return Object.keys(state.nodes)
    .filter((id) => isRootEpoch(id))
    .toSorted((a, b) => Number(a) - Number(b));
}

function topOf(state: SpineState): string {
  const top = state.openStack.at(-1);
  if (top === undefined) {
    throw new Error('Spine openStack is empty; the tree must always contain a root epoch.');
  }
  return top;
}

// Net projected-context growth attributable to the node: the gauge delta
// between its open baseline and its closing high-water mark (or the live
// gauge while still open). Folds committed inside the node can make the net
// negative — the tree view only needs the "no lasting cost" signal there, so
// it clamps at zero. Nodes without a recorded baseline (root epochs, startup
// nodes, sessions restored before the gauges were recorded) render no cost.
function nodeTokenCost(
  node: SpineNode,
  currentUsed: number,
  baselines: ReadonlyMap<string, number>,
  finals: ReadonlyMap<string, number>,
): number | undefined {
  const baseline = baselines.get(node.id);
  if (baseline === undefined) return undefined;
  const end = node.closedAt === undefined ? currentUsed : finals.get(node.id);
  if (end === undefined) return undefined;
  return Math.max(0, end - baseline);
}

function messageText(message: ContextMessage): string {
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

// The boundary archive stores the raw summary; the summary message carries it
// under the compaction prefix, so strip the carrier (and its separating
// newline) when reconstructing the archive from the stream.
function stripCompactionSummaryPrefix(text: string): string {
  if (!text.startsWith(COMPACTION_SUMMARY_PREFIX)) return text;
  return text.slice(COMPACTION_SUMMARY_PREFIX.length).replace(/^\n+/, '');
}

function reject(reason: string): SpineTransitionResult {
  return { accepted: false, reason };
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentSpineService,
  AgentSpineService,
  InstantiationType.Eager,
  'spine',
);
