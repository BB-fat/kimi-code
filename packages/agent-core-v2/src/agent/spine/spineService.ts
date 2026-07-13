/**
 * `spine` domain (L4) — `IAgentSpineService` implementation.
 *
 * Owns the model-driven task tree in the wire `SpineModel`: the read-only /
 * receipt-only control tools hand validated intent here (`acceptOpen` /
 * `acceptClose` / `acceptNext`), which registers the single per-step pending
 * transition; the `loop.afterStep` hook then commits it (`spine.open` /
 * `spine.close` / `spine.next`) once the matching assistant tool-call and tool
 * result have both landed in `contextMemory`, so the tree moves only on
 * observed evidence. Acceptance validates non-empty bodies, the cursor
 * position, and — as the minimal provenance check — that every `[U#]`
 * citation in a close / next memory resolves to a real user request in the
 * current projected view, so a fabricated or folded-away anchor can never
 * enter the tree. Reads the cursor and node layout through
 * `wire.getModel(SpineModel)`, writes through `wire.dispatch(spineOpen(...))`
 * etc., records each node's provider-token baseline via `contextSize`,
 * assembles continuation memory with `spineTree.assembleMemoryBody`, archives
 * each closed node's trajectory under the bootstrap-issued per-agent session
 * homedir (`<sessionDir>/agents/<id>/spine/`), and — for root compactions —
 * archives the history the new epoch boundary folds away (`archiveEpochRoot`),
 * with the path published back onto the new epoch node so the folded context
 * stays one `Read` away. Persistence failures are never swallowed: a failed
 * commit dispatch or archive write is reported through `onUnexpectedError`,
 * and a node whose archive could not be written still closes, with the failure
 * marked in its memory. On restore it audits the rebuilt transcript against
 * the committed `spine.*` records read through `wireRecord` — every accepted
 * control-tool receipt must have its op — and reports lost transitions
 * (detection only, no repair): ops without receipts (receipts a compaction
 * folded away) are the benign direction and stay silent, and the legacy bare
 * `accepted` receipt left by older sessions still counts, so resuming them
 * raises no false alarm. A pending transition dropped without commit evidence
 * is reported the same way, unless the owning step aborted (a routine
 * interrupt). Renders the read-only `spine_tree` view across every
 * root epoch (current first by numeric order), so a superseded epoch's
 * closed-node archives stay discoverable after a root compaction. Registers
 * its history fold into `contextProjector` and its `<spine_view>` prompt block
 * into `llmRequester` (spine → projector / llmRequester, never the reverse);
 * the prompt contribution self-gates per request, so only turn requests whose
 * tool list can act on the protocol (i.e. that offer `spine_open`) carry it —
 * sub-agents and operations such as compaction never see it. Self-checks the
 * `KIMI_CODE_SPINE` gate at construction, so a disabled spine never observes
 * history. Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { estimateTokensForMessages } from '#/_base/utils/tokens';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentContextProjectorService } from '#/agent/contextProjector/contextProjector';
import { IAgentContextSizeService } from '#/agent/contextSize/contextSize';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import {
  IAgentWireRecordService,
  type PersistedWireRecord,
} from '#/agent/wireRecord/wireRecord';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAgentWireService } from '#/wire/tokens';
import type { IWireService } from '#/wire/wireService';

import { SPINE_FLAG_ID } from './flag';
import { appendSpineView, loadSpineViewOverride } from './instructions';
import {
  IAgentSpineService,
  SPINE_TOOL_CLOSE,
  SPINE_TOOL_NEXT,
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
import { countUserAnchors, foldSpine, type SpineFoldStatus } from './spineFold';
import {
  SpineModel,
  spineClose,
  spineNext,
  spineOpen,
  type SpineNode,
  type SpineState,
} from './spineOps';
import {
  assembleMemoryBody,
  childNodeId,
  isRootEpoch,
  nextChildIndex,
  parentNodeId,
  renderTree,
  type SpineTreeNodeView,
} from './spineTree';
import { ACCEPTED_OUTPUT } from './tools/controlResult';

type SpinePending = {
  readonly toolCallId: string;
  readonly stepSignal: AbortSignal | undefined;
} & (
  | { readonly kind: 'open'; readonly summary: string }
  | { readonly kind: 'close'; readonly memory: string }
  | { readonly kind: 'next'; readonly summary: string; readonly memory: string }
);

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

export class AgentSpineService extends Disposable implements IAgentSpineService {
  declare readonly _serviceBrand: undefined;

  private pending: SpinePending | null = null;
  private lastObservedIndex = 0;
  private stepSignal: AbortSignal | undefined;

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
    @IAgentWireService private readonly wire: IWireService,
    @IAgentWireRecordService private readonly wireRecord: IAgentWireRecordService,
    @IAgentLoopService loop: IAgentLoopService,
    @IAgentContextProjectorService projector: IAgentContextProjectorService,
    @IAgentLLMRequesterService llmRequester: IAgentLLMRequesterService,
  ) {
    super();
    if (this.enabled) {
      void loadSpineViewOverride(this.hostFs, this.hostEnv.homeDir);
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
        return appendSpineView(prompt);
      }),
    );
    this._register(
      loop.hooks.onWillBeginStep.register('spine', async (ctx, next) => {
        if (this.pending !== null) {
          this.dropPending(
            this.pending,
            'the previous step ended before its tool result was observed',
          );
        }
        this.stepSignal = ctx.signal;
        await next();
      }),
    );
    this._register(
      loop.hooks.onDidFinishStep.register('spine', async (_ctx, next) => {
        await this.commitPending();
        await next();
      }),
    );
    this._register(
      this.wire.onRestored(() => {
        this.lastObservedIndex = this.context.get().length;
        this.pending = null;
        if (this.enabled) this.reportLostCommits();
      }),
    );
  }

  get enabled(): boolean {
    return this.flags.enabled(SPINE_FLAG_ID);
  }

  acceptOpen(summary: string, toolCallId: string): SpineTransitionResult {
    const guard = this.guard();
    if (guard !== null) return guard;
    const trimmed = summary.trim();
    if (trimmed.length === 0) return reject('open summary must not be empty.');
    this.pending = { kind: 'open', toolCallId, summary: trimmed, stepSignal: this.stepSignal };
    return { accepted: true };
  }

  acceptClose(memory: string, toolCallId: string): SpineTransitionResult {
    const guard = this.guard();
    if (guard !== null) return guard;
    const trimmed = memory.trim();
    if (trimmed.length === 0) return reject('close memory must not be empty.');
    if (isRootEpoch(this.cursorId())) return REJECT_ROOT_EPOCH;
    const anchorGuard = this.anchorReferenceGuard('close', trimmed);
    if (anchorGuard !== null) return anchorGuard;
    this.pending = { kind: 'close', toolCallId, memory: trimmed, stepSignal: this.stepSignal };
    return { accepted: true };
  }

  acceptNext(summary: string, memory: string, toolCallId: string): SpineTransitionResult {
    const guard = this.guard();
    if (guard !== null) return guard;
    const trimmedSummary = summary.trim();
    const trimmedMemory = memory.trim();
    if (trimmedSummary.length === 0) return reject('next summary must not be empty.');
    if (trimmedMemory.length === 0) return reject('next memory must not be empty.');
    if (isRootEpoch(this.cursorId())) return REJECT_ROOT_EPOCH;
    const anchorGuard = this.anchorReferenceGuard('next', trimmedMemory);
    if (anchorGuard !== null) return anchorGuard;
    this.pending = {
      kind: 'next',
      toolCallId,
      summary: trimmedSummary,
      memory: trimmedMemory,
      stepSignal: this.stepSignal,
    };
    return { accepted: true };
  }

  renderTree(): string {
    const state = this.state();
    return renderTree({
      cursorId: this.cursorId(),
      rootIds: epochRootIds(state),
      resolve: (id) => this.nodeView(state, id),
    });
  }

  fold(messages: readonly ContextMessage[]): readonly ContextMessage[] {
    if (!this.enabled) return messages;
    const state = this.state();
    const epochSummaryMessage =
      state.epochMemoryAt === undefined ? undefined : messages[state.epochMemoryAt];
    return foldSpine(messages, { state, status: this.buildStatus(), epochSummaryMessage });
  }

  private buildStatus(): SpineFoldStatus {
    const state = this.state();
    const cursorId = topOf(state);
    const cursor = state.nodes[cursorId];
    const summary = cursor?.summary ?? '';
    const openedAt = cursor === undefined ? 0 : Math.max(0, cursor.openedAt);
    const maxContextTokens = this.profile.getModelCapabilities().max_context_tokens;
    const used = this.contextSize.get().size;
    const contextLeft =
      maxContextTokens !== undefined && maxContextTokens > 0
        ? Math.max(0, maxContextTokens - used)
        : undefined;
    return {
      cursorId,
      summary,
      parentId: parentNodeId(cursorId),
      cursorContext: this.contextSize.get(openedAt).size,
      contextLeft,
      rawContext: estimateTokensForMessages(this.context.get()),
      projectedContext: used,
      projectedMeasured: this.contextSize.latestMeasurement()?.kind === 'measured',
    };
  }

  private reportLostCommits(): void {
    const receipts = countAcceptedReceipts(this.context.get());
    const committed = countCommittedOps(this.wireRecord.getRecords());
    const lost: string[] = [];
    for (const kind of SPINE_TRANSITION_KINDS) {
      if (committed[kind] < receipts[kind]) {
        lost.push(
          `${SPINE_TOOL_NAME[kind]}: ${String(receipts[kind])} accepted receipt(s) vs ${String(committed[kind])} ${SPINE_OP_TYPE[kind]} op(s)`,
        );
      }
    }
    if (lost.length === 0) return;
    onUnexpectedError(
      new Error(
        `Spine: lost transition(s) detected on restore — ${lost.join('; ')}. ` +
          'A receipt was persisted but the matching tree op was not; the tree may be missing nodes. No automatic repair is attempted.',
      ),
    );
  }

  private guard(): SpineTransitionResult | null {
    if (!this.enabled) return REJECT_DISABLED;
    if (this.pending !== null) return REJECT_CONFLICT;
    return null;
  }

  /**
   * Provenance check for `[U#]` citations in a continuation memory: the fold
   * numbers surviving real user requests in the projected view, so a citation
   * is only resolvable (for the model now and for whatever reads the memory
   * later) if it points at an anchor that exists in the current projection.
   * Counting happens over the folded view, not the raw history — user requests
   * already folded into a `<spine_memory>` or a previous epoch carry no anchor.
   */
  private anchorReferenceGuard(kind: 'close' | 'next', memory: string): SpineTransitionResult | null {
    const maxAnchor = countUserAnchors(this.fold(this.context.get()));
    const invalid = invalidAnchorReferences(memory, maxAnchor);
    if (invalid.length === 0) return null;
    const refs = invalid.map((n) => `[U${String(n)}]`).join(', ');
    const available =
      maxAnchor === 0
        ? 'no numbered user requests'
        : `only [U1] through [U${String(maxAnchor)}]`;
    return reject(
      `${kind} memory references ${refs}, but the current view contains ${available}. ` +
        `[U#] references must point at user requests visible in the current projection; ` +
        `describe folded-away context by content or via the node's archive path instead.`,
    );
  }

  private state(): SpineState {
    return this.wire.getModel(SpineModel);
  }

  private cursorId(): string {
    const stack = this.state().openStack;
    const top = stack.at(-1);
    if (top === undefined) {
      throw new Error('Spine openStack is empty; the tree must always contain a root epoch.');
    }
    return top;
  }

  private nodeView(state: SpineState, id: string): SpineTreeNodeView | undefined {
    const node = state.nodes[id];
    if (node === undefined) return undefined;
    const supersededEpoch = isRootEpoch(id) && id !== String(state.rootEpoch);
    return {
      id: node.id,
      summary: node.summary,
      closed: node.closedAt !== undefined || supersededEpoch,
      archivePath: node.archivePath,
      tokenCost: undefined,
      children: node.children
        .map((childId) => this.nodeView(state, childId))
        .filter((child): child is SpineTreeNodeView => child !== undefined),
    };
  }

  private async commitPending(): Promise<void> {
    if (!this.enabled) return;
    const pending = this.pending;
    if (pending === null) return;

    const history = this.context.get();
    const evidence = findEvidence(history, this.lastObservedIndex, pending.toolCallId);
    this.lastObservedIndex = history.length;
    if (evidence === null) {
      this.dropPending(pending, 'the step ended without tool-result evidence');
      return;
    }

    try {
      switch (pending.kind) {
        case 'open':
          this.commitOpen(pending.summary, evidence.assistantIndex);
          break;
        case 'close':
          await this.commitClose(pending.memory, evidence.toolResultIndex);
          break;
        case 'next':
          await this.commitNext(pending.summary, pending.memory, evidence.toolResultIndex);
          break;
      }
    } catch (error) {
      onUnexpectedError(
        new Error(
          `Spine: failed to commit ${pending.kind} transition (toolCallId ${pending.toolCallId}); dropping the transition.`,
          { cause: error },
        ),
      );
    } finally {
      this.pending = null;
    }
  }

  private dropPending(pending: SpinePending, why: string): void {
    this.pending = null;
    if (pending.stepSignal?.aborted === true) return;
    onUnexpectedError(
      new Error(
        `Spine: dropping ${pending.kind} transition (toolCallId ${pending.toolCallId}) — ${why}. The accepted receipt stays in the transcript.`,
      ),
    );
  }

  private commitOpen(summary: string, openedAt: number): void {
    const state = this.state();
    const parentId = topOf(state);
    const parent = state.nodes[parentId];
    if (parent === undefined) return;
    const id = childNodeId(parentId, nextChildIndex(parent.children));
    this.wire.dispatch(
      spineOpen({
        id,
        summary,
        parentId,
        openedAt,
        baselineTokens: this.contextSize.get().size,
      }),
    );
  }

  private async commitClose(memory: string, closedAt: number): Promise<void> {
    const state = this.state();
    const id = topOf(state);
    const node = state.nodes[id];
    if (node === undefined || isRootEpoch(id)) return;
    const assembled = assembleMemoryBody({
      childMemories: closedChildMemories(state, node),
      nodeMemory: memory,
    });
    const closing: SpineNode = { ...node, closedAt, memory: assembled };
    const archivePath = await this.archiveNode(closing);
    this.wire.dispatch(
      spineClose({ id, closedAt, memory: markArchiveFailure(assembled, archivePath), archivePath }),
    );
  }

  private async commitNext(summary: string, memory: string, closedAt: number): Promise<void> {
    const state = this.state();
    const closedId = topOf(state);
    const closing = state.nodes[closedId];
    if (closing === undefined || isRootEpoch(closedId)) return;
    const parentId = parentNodeId(closedId);
    if (parentId === null) return;
    const parent = state.nodes[parentId];
    if (parent === undefined) return;
    const openedId = childNodeId(parentId, nextChildIndex(parent.children));
    const assembled = assembleMemoryBody({
      childMemories: closedChildMemories(state, closing),
      nodeMemory: memory,
    });
    const closed: SpineNode = { ...closing, closedAt, memory: assembled };
    const archivePath = await this.archiveNode(closed);
    this.wire.dispatch(
      spineNext({
        closedId,
        closedAt,
        memory: markArchiveFailure(assembled, archivePath),
        archivePath,
        openedId,
        summary,
        baselineTokens: this.contextSize.get().size,
      }),
    );
  }

  async archiveEpochRoot(input: SpineEpochArchiveInput): Promise<string | undefined> {
    if (!this.enabled) return undefined;
    const path = this.archivePath(String(input.epoch));
    const content = buildEpochArchiveContent(input);
    try {
      await writeNodeArchive(this.hostFs, path, content);
      return path;
    } catch (error) {
      onUnexpectedError(error);
      return undefined;
    }
  }

  private async archiveNode(node: SpineNode): Promise<string | undefined> {
    const path = this.archivePath(node.id);
    const openedAt = Math.max(0, node.openedAt);
    const closedAt = node.closedAt ?? node.openedAt;
    const messages = this.context.get().slice(openedAt, closedAt + 1);
    const content = buildArchiveContent({ node, messages });
    try {
      await writeNodeArchive(this.hostFs, path, content);
      return path;
    } catch (error) {
      onUnexpectedError(error);
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
    .sort((a, b) => Number(a) - Number(b));
}

function topOf(state: SpineState): string {
  const top = state.openStack.at(-1);
  if (top === undefined) {
    throw new Error('Spine openStack is empty; the tree must always contain a root epoch.');
  }
  return top;
}

function closedChildMemories(state: SpineState, node: SpineNode): readonly string[] {
  const bodies: string[] = [];
  for (const childId of node.children) {
    const child = state.nodes[childId];
    if (child !== undefined && child.closedAt !== undefined && child.memory !== undefined) {
      bodies.push(child.memory);
    }
  }
  return bodies;
}

interface SpineEvidence {
  readonly assistantIndex: number;
  readonly toolResultIndex: number;
}

function findEvidence(
  history: readonly ContextMessage[],
  from: number,
  toolCallId: string,
): SpineEvidence | null {
  let assistantIndex = -1;
  for (let i = from; i < history.length; i++) {
    const message = history[i];
    if (message === undefined) continue;
    if (
      assistantIndex < 0 &&
      message.role === 'assistant' &&
      message.toolCalls.some((call) => call.id === toolCallId)
    ) {
      assistantIndex = i;
    }
    if (message.role === 'tool' && message.toolCallId === toolCallId) {
      return assistantIndex < 0 ? null : { assistantIndex, toolResultIndex: i };
    }
  }
  return null;
}

type SpineTransitionKind = 'open' | 'close' | 'next';

const SPINE_TRANSITION_KINDS: readonly SpineTransitionKind[] = ['open', 'close', 'next'];

const SPINE_TOOL_NAME: Record<SpineTransitionKind, string> = {
  open: SPINE_TOOL_OPEN,
  close: SPINE_TOOL_CLOSE,
  next: SPINE_TOOL_NEXT,
};

const SPINE_OP_TYPE: Record<SpineTransitionKind, string> = {
  open: 'spine.open',
  close: 'spine.close',
  next: 'spine.next',
};

const LEGACY_ACCEPTED_RECEIPT = 'accepted';

const ARCHIVE_FAILURE_NOTE =
  '[spine: the trajectory archive for this node could not be written; its detailed history was not persisted.]';

function markArchiveFailure(memory: string, archivePath: string | undefined): string {
  return archivePath === undefined ? `${memory}\n\n${ARCHIVE_FAILURE_NOTE}` : memory;
}

function countAcceptedReceipts(
  messages: readonly ContextMessage[],
): Record<SpineTransitionKind, number> {
  const counts: Record<SpineTransitionKind, number> = { open: 0, close: 0, next: 0 };
  const kindsByCallId = new Map<string, SpineTransitionKind>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls) {
      const kind = kindOfToolName(call.name);
      if (kind !== undefined) kindsByCallId.set(call.id, kind);
    }
  }
  for (const message of messages) {
    if (message.role !== 'tool' || message.toolCallId === undefined || message.isError === true) {
      continue;
    }
    const kind = kindsByCallId.get(message.toolCallId);
    if (kind === undefined) continue;
    const text = toolMessageText(message);
    if (text !== ACCEPTED_OUTPUT && text !== LEGACY_ACCEPTED_RECEIPT) continue;
    counts[kind]++;
  }
  return counts;
}

function countCommittedOps(
  records: readonly PersistedWireRecord[],
): Record<SpineTransitionKind, number> {
  const counts: Record<SpineTransitionKind, number> = { open: 0, close: 0, next: 0 };
  for (const record of records) {
    switch (record.type) {
      case 'spine.open':
        counts.open++;
        break;
      case 'spine.close':
        counts.close++;
        break;
      case 'spine.next':
        counts.next++;
        break;
    }
  }
  return counts;
}

function kindOfToolName(name: string): SpineTransitionKind | undefined {
  switch (name) {
    case SPINE_TOOL_OPEN:
      return 'open';
    case SPINE_TOOL_CLOSE:
      return 'close';
    case SPINE_TOOL_NEXT:
      return 'next';
    default:
      return undefined;
  }
}

function toolMessageText(message: ContextMessage): string {
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

function invalidAnchorReferences(memory: string, maxAnchor: number): readonly number[] {
  const invalid = new Set<number>();
  for (const match of memory.matchAll(/\[U(\d+)\]/g)) {
    const n = Number.parseInt(match[1] ?? '', 10);
    if (!Number.isFinite(n) || n < 1 || n > maxAnchor) invalid.add(n);
  }
  return [...invalid].sort((a, b) => a - b);
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
