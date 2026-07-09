/**
 * `spine` domain (L4) — `IAgentSpineService` implementation.
 *
 * Owns the model-driven task tree in the wire `SpineModel`: the read-only /
 * receipt-only control tools hand validated intent here (`acceptOpen` /
 * `acceptClose` / `acceptNext`), which registers the single per-step pending
 * transition; the `loop.afterStep` hook then commits it (`spine.open` /
 * `spine.close` / `spine.next`) once the matching assistant tool-call and tool
 * result have both landed in `contextMemory`, so the tree moves only on
 * observed evidence. Reads the cursor and node layout through
 * `wire.getModel(SpineModel)`, writes through `wire.dispatch(spineOpen(...))`
 * etc., records each node's provider-token baseline via `contextSize`,
 * assembles continuation memory with `spineTree.assembleMemoryBody`, and
 * renders the read-only `spine_tree` view. Hooks self-check the `KIMI_CODE_SPINE`
 * gate so a disabled spine never observes history. Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { estimateTokensForMessages } from '#/_base/utils/tokens';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentContextSizeService } from '#/agent/contextSize/contextSize';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IAgentWireService } from '#/wire/tokens';
import type { IWireService } from '#/wire/wireService';

import { isSpineEnabled } from './flag';
import { loadSpineViewOverride } from './instructions';
import {
  IAgentSpineService,
  type SpineTransitionResult,
} from './spine';
import { buildArchiveContent, spineArchivePath, writeNodeArchive } from './spineArchive';
import { foldSpine, type SpineFoldStatus } from './spineFold';
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

type SpinePending =
  | { readonly kind: 'open'; readonly toolCallId: string; readonly summary: string }
  | { readonly kind: 'close'; readonly toolCallId: string; readonly memory: string }
  | {
      readonly kind: 'next';
      readonly toolCallId: string;
      readonly summary: string;
      readonly memory: string;
    };

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

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentContextSizeService private readonly contextSize: IAgentContextSizeService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @IHostEnvironment private readonly hostEnv: IHostEnvironment,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IAgentScopeContext private readonly agentScope: IAgentScopeContext,
    @IAgentWireService private readonly wire: IWireService,
    @IAgentLoopService loop: IAgentLoopService,
  ) {
    super();
    if (this.enabled) {
      void loadSpineViewOverride(this.hostFs, this.hostEnv.homeDir);
    }
    this._register(
      loop.hooks.beforeStep.register('spine', async (_ctx, next) => {
        this.pending = null;
        await next();
      }),
    );
    this._register(
      loop.hooks.afterStep.register('spine', async (_ctx, next) => {
        await this.commitPending();
        await next();
      }),
    );
    this._register(
      this.wire.onRestored(() => {
        this.lastObservedIndex = this.context.get().length;
        this.pending = null;
      }),
    );
  }

  get enabled(): boolean {
    return isSpineEnabled();
  }

  acceptOpen(summary: string, toolCallId: string): SpineTransitionResult {
    const guard = this.guard();
    if (guard !== null) return guard;
    const trimmed = summary.trim();
    if (trimmed.length === 0) return reject('open summary must not be empty.');
    this.pending = { kind: 'open', toolCallId, summary: trimmed };
    return { accepted: true };
  }

  acceptClose(memory: string, toolCallId: string): SpineTransitionResult {
    const guard = this.guard();
    if (guard !== null) return guard;
    const trimmed = memory.trim();
    if (trimmed.length === 0) return reject('close memory must not be empty.');
    if (isRootEpoch(this.cursorId())) return REJECT_ROOT_EPOCH;
    this.pending = { kind: 'close', toolCallId, memory: trimmed };
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
    this.pending = { kind: 'next', toolCallId, summary: trimmedSummary, memory: trimmedMemory };
    return { accepted: true };
  }

  renderTree(): string {
    const state = this.state();
    const rootId = String(state.rootEpoch);
    return renderTree({
      cursorId: this.cursorId(),
      rootIds: state.nodes[rootId] === undefined ? [] : [rootId],
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

  private guard(): SpineTransitionResult | null {
    if (!this.enabled) return REJECT_DISABLED;
    if (this.pending !== null) return REJECT_CONFLICT;
    return null;
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
    return {
      id: node.id,
      summary: node.summary,
      closed: node.closedAt !== undefined,
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
    if (evidence === null) return;

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
    this.pending = null;
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
    this.wire.dispatch(spineClose({ id, closedAt, memory: assembled, archivePath }));
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
        memory: assembled,
        archivePath,
        openedId,
        summary,
        baselineTokens: this.contextSize.get().size,
      }),
    );
  }

  private async archiveNode(node: SpineNode): Promise<string | undefined> {
    const path = spineArchivePath(this.workspace.workDir, this.agentScope.agentId, node.id);
    const openedAt = Math.max(0, node.openedAt);
    const closedAt = node.closedAt ?? node.openedAt;
    const messages = this.context.get().slice(openedAt, closedAt + 1);
    const content = buildArchiveContent({ node, messages });
    try {
      await writeNodeArchive(this.hostFs, path, content);
      return path;
    } catch {
      return undefined;
    }
  }
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
