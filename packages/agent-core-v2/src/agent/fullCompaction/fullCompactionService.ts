import { Disposable, type IDisposable } from "#/_base/di/lifecycle";
import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from '#/_base/di/instantiation';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { renderPrompt } from "#/_base/utils/render-prompt";
import {
  estimateTokens,
  estimateTokensForMessage,
  estimateTokensForMessages,
  estimateTokensForTools,
} from "#/_base/utils/tokens";
import {
  buildCompactionSummaryText,
  createCompactionSummaryMessage,
  isRealUserInput,
} from '#/agent/contextMemory/compactionHandoff';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentContextSizeService } from '#/agent/contextSize/contextSize';
import { contextSizeMeasured } from '#/agent/contextSize/contextSizeOps';
import { isSpineEnabled } from '#/agent/spine/flag';
import { IAgentSpineService } from '#/agent/spine/spine';
import { SpineModel, spineRootCompact } from '#/agent/spine/spineOps';
import { IAgentLLMRequesterService, type LLMRequestFinish } from '#/agent/llmRequester/llmRequester';
import { retryBackoffDelays, sleepForRetry } from '#/agent/llmRequester/retry';
import { IAgentLoopService, type AfterStepContext, type LoopErrorContext } from '#/agent/loop/loop';
import { isAbortError, isContextOverflowError } from '#/agent/loop/errors';
import {
  IAgentProfileService,
  type ProfileModelContext,
  type WillSetModelContext,
} from '#/agent/profile/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { stripDynamicToolContext } from '#/agent/toolSelect/dynamicTools';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { IAgentTurnService } from '#/agent/turn/turn';
import { IAgentActivityService } from '#/activity/activity';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import { renderTodoList, type TodoItem } from '#/session/todo/todoItem';
import {
  APIContextOverflowError,
  APIEmptyResponseError,
  APIStatusError,
  isRetryableGenerateError,
} from '#/app/llmProtocol/errors';
import { createUserMessage, type Message } from '#/app/llmProtocol/message';
import type { Tool } from '#/app/llmProtocol/tool';
import { type TokenUsage } from '#/app/llmProtocol/usage';
import { IEventBus } from '#/app/event/eventBus';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ErrorCodes, KimiError, isKimiError, toKimiErrorPayload } from "#/errors";
import { IAgentWireService } from '#/wire/tokens';
import type { IWireService } from '#/wire/wireService';
import compactionInstructionTemplate from './compaction-instruction.md?raw';
import {
  IAgentFullCompactionService,
  type FullCompactionInput,
  type FullCompactionTask,
} from './fullCompaction';
import {
  RuntimeCompactionStrategy,
  type CompactionStrategy,
} from './strategy';
import {
  CompactionModel,
  fullCompactionBegin,
  fullCompactionCancel,
  fullCompactionComplete,
  type FullCompactionCompletePayload,
} from './compactionOps';
import {
  type CompactionBeginData,
  type CompactionResult,
} from './types';
import { OrderedHookSlot } from '#/hooks';

// The `full_compaction.*` record shapes stay declared in `WireRecordMap`
// because the records still ride the per-agent `wire.jsonl` log read by
// `wireRecord.restore()` / `getRecords()`. fullCompaction itself no longer
// registers resumers here — its state rebuilds from the same log via
// `wire.replay` into `CompactionModel`.
declare module '#/agent/wireRecord/wireRecord' {
  interface WireRecordMap {
    'full_compaction.begin': CompactionBeginData;
    'full_compaction.cancel': {};
    'full_compaction.complete': FullCompactionCompletePayload;
  }
}

export const MAX_COMPACTION_RETRY_ATTEMPTS = 5;
const DEFAULT_COMPACTION_MAX_COMPLETION_TOKENS = 128 * 1024;
const OVERFLOW_CONTEXT_SAFETY_RATIO = 0.85;
const OVERFLOW_STATUS_RECOVERY_RATIO = 0.5;
const MAX_COMPACTION_OVERFLOW_SHRINK_ATTEMPTS = 3;
const COMPACTION_OVERFLOW_SHRINK_RATIOS = [0.7, 0.5, 0.35] as const;
const EMPTY_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {},
};

type CompactionTelemetryProperties = Record<string, string | number | boolean | undefined>;

/**
 * Why a compaction was cancelled: `'abort'` for user / lane aborts,
 * `'history_changed'` when the context moved under the in-flight summary
 * request (the race guard in `compactionRound`). First writer wins — whichever
 * trigger actually landed first owns the attribution.
 */
type CompactionCancelReason = 'abort' | 'history_changed';

interface ActiveCompaction extends FullCompactionTask {
  blockedByTurn: boolean;
  /** Background-activity registration with the activity kernel (I2 visibility). */
  bgRegistration?: IDisposable;
  cancelReason?: CompactionCancelReason;
}

interface CompactionAttemptResult {
  readonly summary: string;
  readonly usage: TokenUsage | null;
}

class CompactionTruncatedError extends Error {
  constructor() {
    super('Compaction response was truncated before producing a complete summary.');
    this.name = 'CompactionTruncatedError';
  }
}

export class AgentFullCompactionService extends Disposable implements IAgentFullCompactionService {
  declare readonly _serviceBrand: undefined;
  readonly hooks: IAgentFullCompactionService['hooks'] = {
    onWillCompact: new OrderedHookSlot<FullCompactionTask>(),
    onDidFinishCompaction: new OrderedHookSlot<FullCompactionTask>(),
  };

  private readonly strategy: CompactionStrategy;
  private compactionCountInTurn = 0;
  private _compacting: ActiveCompaction | null = null;
  private readonly observedMaxContextTokensByModel = new Map<string, number>();
  // Token count right after the last successful compaction. While nothing new
  // has been appended, the history is already in its minimal compacted form;
  // re-compacting would only summarize the summary again, so
  // checkAutoCompaction skips in that case.
  private lastCompactedTokenCount: number | null = null;
  // Counts provider-overflow recoveries in this turn that have not yet been
  // followed by a successful step. Trips maxOverflowCompactionAttempts to
  // stop an overflow -> compact -> overflow loop when compaction can no
  // longer shrink the request below the model window.
  private consecutiveOverflowCompactions = 0;
  private contextInjectorService: IAgentContextInjectorService | undefined;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentContextSizeService private readonly contextSize: IAgentContextSizeService,
    @IAgentLLMRequesterService private readonly llmRequester: IAgentLLMRequesterService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentSpineService private readonly spine: IAgentSpineService,
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IAgentToolSelectService private readonly toolSelect: IAgentToolSelectService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @ISessionTodoService private readonly todo: ISessionTodoService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentWireService private readonly wire: IWireService,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentTurnService private readonly turn: IAgentTurnService,
    @IAgentActivityService private readonly activity: IAgentActivityService,
    @ILogService private readonly log: ILogService,
    @IAgentLoopService loopService: IAgentLoopService,
  ) {
    super();
    this.strategy = new RuntimeCompactionStrategy(() => this.resolveModelContextWithEffectiveMax());
    this._register(this.wire.onRestored(() => this.normalizeAfterReplay()));
    this._register(
      this.eventBus.subscribe('turn.started', () => this.resetForTurn()),
    );
    this._register(
      this.profile.hooks.onWillSetModel.register('full-compaction', async (ctx, next) => {
        await this.preCompactForModelDownshift(ctx);
        await next();
      }),
    );
    this._register(
      loopService.hooks.beforeStep.register('full-compaction', async (ctx, next) => {
        await this.beforeStep(ctx.signal, ctx.turnId);
        await next();
      }),
    );
    this._register(
      loopService.hooks.afterStep.register('full-compaction', async (ctx, next) => {
        await this.afterStep(ctx);
        await next();
      }),
    );
    this._register(
      loopService.hooks.onError.register('full-compaction', async (ctx, next) => {
        await this.onLoopError(ctx, next);
      }),
    );
  }

  get compacting(): FullCompactionTask | null {
    return this._compacting;
  }

  private getEffectiveMaxContextTokens(): number {
    const configured = this.profile.data().modelCapabilities.max_context_tokens;
    const modelAlias = this.profile.data().modelAlias;
    const observed =
      modelAlias === undefined ? undefined : this.observedMaxContextTokensByModel.get(modelAlias);
    if (observed === undefined) return configured;
    if (configured <= 0) return observed;
    return Math.min(configured, observed);
  }

  private resolveModelContextWithEffectiveMax(): ProfileModelContext {
    const resolved = this.profile.resolveModelContext();
    return {
      ...resolved,
      modelCapabilities: {
        ...resolved.modelCapabilities,
        max_context_tokens: this.getEffectiveMaxContextTokens(),
      },
    };
  }

  private estimateCurrentRequestTokens(): number {
    return this.estimateRequestTokens(this.context.get());
  }

  private estimateRequestTokens(messages: readonly Message[]): number {
    return (
      estimateTokens(this.profile.getSystemPrompt()) +
      estimateTokensForTools(this.defaultTools().filter((tool) => tool.deferred !== true)) +
      estimateTokensForMessages(messages)
    );
  }

  private defaultTools(): readonly Tool[] {
    return this.toolSelect
      .shapeTools(this.toolRegistry.list())
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? EMPTY_TOOL_PARAMETERS,
        deferred: tool.deferred,
      }));
  }

  private shouldRecoverFromContextOverflow(
    error: unknown,
    estimatedRequestTokens = this.estimateCurrentRequestTokens(),
  ): boolean {
    if (isContextOverflowError(error)) return true;
    const statusError = findAPIStatusError(error);
    if (statusError instanceof APIContextOverflowError) return true;
    if (statusError === undefined || statusError.statusCode !== 413) return false;
    const effectiveMax = this.getEffectiveMaxContextTokens();
    return (
      effectiveMax > 0 &&
      estimatedRequestTokens >= effectiveMax * OVERFLOW_STATUS_RECOVERY_RATIO
    );
  }

  private observeContextOverflow(estimatedRequestTokens: number): void {
    if (!Number.isFinite(estimatedRequestTokens) || estimatedRequestTokens <= 0) return;
    const modelAlias = this.profile.data().modelAlias;
    if (modelAlias === undefined) return;
    const observed = Math.max(
      1,
      Math.floor(estimatedRequestTokens * OVERFLOW_CONTEXT_SAFETY_RATIO),
    );
    const current = this.getEffectiveMaxContextTokens();
    if (current > 0 && observed >= current) return;
    this.observedMaxContextTokensByModel.set(modelAlias, observed);
  }

  begin(input: FullCompactionInput): boolean {
    if (this._compacting) return false;
    const data: CompactionBeginData = { source: input.source, instruction: input.instruction };
    if (data.source === 'manual') {
      this.compactionCountInTurn = 0;
    } else {
      this.compactionCountInTurn += 1;
    }
    if (this.compactionCountInTurn > this.strategy.maxCompactionPerTurn) return false;

    const history = this.context.get();
    if (history.length === 0) {
      throw new KimiError(ErrorCodes.COMPACTION_UNABLE, 'No messages to compact in current history.');
    }
    if (data.source === 'manual' && this.activity.lane() !== 'idle') {
      throw new KimiError(
        ErrorCodes.COMPACTION_UNABLE,
        'Cannot compact while a turn is active. Wait for it to finish, then retry.',
      );
    }
    const tokenCount = estimateTokensForMessages(history);

    this.wire.dispatch(fullCompactionBegin(data));

    const abortController = new AbortController();
    let resolveCompaction!: (result: CompactionResult) => void;
    let rejectCompaction!: (reason: unknown) => void;
    const promise = new Promise<CompactionResult>((resolve, reject) => {
      resolveCompaction = resolve;
      rejectCompaction = reject;
    });
    const active: ActiveCompaction = {
      abortController,
      promise,
      trigger: data.source,
      tokenCount,
      blockedByTurn: false,
      bgRegistration: this.activity.registerBackground('compaction', abortController),
    };
    this._compacting = active;
    abortController.signal.addEventListener('abort', () => {
      this.cancelActive(active);
    }, { once: true });
    void this.compactionWorker(
      active,
      data,
    )
      .then(resolveCompaction, rejectCompaction);
    void active.promise.catch(() => undefined);
    return true;
  }

  private cancelActive(active: ActiveCompaction, reason: CompactionCancelReason = 'abort'): boolean {
    if (this._compacting !== active) return false;
    active.cancelReason ??= reason;
    this.wire.dispatch(fullCompactionCancel({}));
    this._compacting = null;
    active.bgRegistration?.dispose();
    if (!active.abortController.signal.aborted) {
      active.abortController.abort();
    }
    this.eventBus.publish({ type: 'compaction.cancelled' });
    return true;
  }

  private markCompleted(active: ActiveCompaction): boolean {
    if (this._compacting !== active) return false;
    this.wire.dispatch(fullCompactionComplete({}));
    this._compacting = null;
    active.bgRegistration?.dispose();
    return true;
  }

  private normalizeAfterReplay(): void {
    // A compaction in flight when the session was torn down cannot resume — the
    // worker and its AbortController are gone — so a `running` phase replayed
    // from the log is stranded. Collapse it back to idle silently: no live
    // `compaction.cancelled` signal, since restore must stay quiet.
    if (this.wire.getModel(CompactionModel).phase !== 'running') return;
    this.wire.dispatch(fullCompactionCancel({}));
  }

  private resetForTurn(): void {
    this.compactionCountInTurn = 0;
    this.lastCompactedTokenCount = null;
    this.consecutiveOverflowCompactions = 0;
  }

  private async onLoopError(
    context: LoopErrorContext,
    next: () => Promise<void>,
  ): Promise<void> {
    const estimatedRequestTokens = this.estimateCurrentRequestTokens();
    const isOverflow = this.shouldRecoverFromContextOverflow(
      context.error,
      estimatedRequestTokens,
    );
    if (!isOverflow) {
      await next();
      return;
    }
    this.observeContextOverflow(estimatedRequestTokens);
    this.consecutiveOverflowCompactions += 1;
    const maxAttempts = this.strategy.maxOverflowCompactionAttempts;
    if (this.consecutiveOverflowCompactions > maxAttempts) {
      throw new KimiError(
        ErrorCodes.CONTEXT_OVERFLOW,
        `Compaction failed to bring the context under the model window after ${String(maxAttempts)} attempts.`,
        { cause: context.error instanceof Error ? context.error : undefined },
      );
    }
    const didStartCompaction = this.beginAutoCompaction();
    if (!didStartCompaction && !this._compacting) {
      await next();
      return;
    }
    context.retry = true;
    await this.block(context.signal, context.turnId);
  }

  private async beforeStep(signal: AbortSignal, turnId?: number): Promise<void> {
    this.checkAutoCompaction();
    if (this.strategy.shouldBlock(this.tokenCountWithPending())) {
      await this.block(signal, turnId);
    }
  }

  /**
   * `profile.onWillSetModel` handler: switching to a model whose window is
   * smaller than the live context would make the next step overflow and force
   * the compaction summary request itself through the overflow-shrink ladder
   * against the smaller window. Compact instead while the outgoing
   * (larger-window) model is still the active provider, so the summary covers
   * the full history in one shot. Failures here must not veto the switch —
   * the next step's overflow recovery remains as the fallback.
   */
  private async preCompactForModelDownshift(context: WillSetModelContext): Promise<void> {
    if (this._compacting !== null) return;
    // Mid-turn switches can't block here; the running turn's overflow path
    // handles the smaller window.
    if (this.turn.getActiveTurn() !== undefined) return;
    if (this.context.get().length === 0) return;
    const nextMax = context.nextMaxContextTokens;
    if (nextMax === undefined || nextMax <= 0) return;
    if (nextMax >= this.getEffectiveMaxContextTokens()) return;
    if (!this.strategy.shouldCompactForWindow(this.tokenCountWithPending(), nextMax)) return;
    this.begin({ source: 'auto' });
    try {
      await this.block();
    } catch (error) {
      this.log.warn('Pre-compaction before model downshift failed; switching model anyway.', {
        error,
      });
    }
  }

  private async afterStep(context: AfterStepContext): Promise<void> {
    // A completed step means a request succeeded, so any prior
    // overflow -> compact cycle produced a request that now fits; clear the
    // loop guard.
    this.consecutiveOverflowCompactions = 0;
    // Only compact mid-turn when the turn will actually continue. A step whose
    // response carries no tool calls ends the turn; compacting there spends a
    // summary request on a finished turn and swaps still-fresh context for a
    // lossy summary moments before the user reads it. Deferring is safe: the
    // next turn's beforeStep re-evaluates the same thresholds pre-turn (and
    // blocks if the hard limit is reached), mirroring the loop's own
    // `stopReason === 'tool_calls'` continuation rule.
    if (this.strategy.checkAfterStep && context.finishReason === 'tool_calls') {
      this.checkAutoCompaction(false);
    }
  }

  private checkAutoCompaction(throwOnLimit = true): boolean {
    if (this._compacting) return true;
    if (
      this.lastCompactedTokenCount !== null &&
      this.tokenCountWithPending() <= this.lastCompactedTokenCount
    ) {
      return false;
    }
    if (!this.strategy.shouldCompact(this.tokenCountWithPending())) return false;
    return this.beginAutoCompaction(throwOnLimit);
  }

  private beginAutoCompaction(throwOnLimit = true): boolean {
    if (this._compacting) return true;
    const maxCompactions = this.strategy.maxCompactionPerTurn;
    if (this.compactionCountInTurn >= maxCompactions) {
      if (throwOnLimit) {
        throw new KimiError(ErrorCodes.CONTEXT_OVERFLOW, `Compaction limit exceeded (${String(maxCompactions)})`, {
          details: { maxCompactions },
        });
      }
      return false;
    }
    return this.begin({ source: 'auto' });
  }

  private async block(signal?: AbortSignal, turnId?: number): Promise<void> {
    const active = this._compacting;
    if (active === null) return;
    active.blockedByTurn = true;
    if (signal !== undefined) {
      signal.addEventListener('abort', () => {
        if (this._compacting === active) {
          active.abortController.abort();
        }
      }, { once: true });
    }
    this.eventBus.publish({ type: 'compaction.blocked', turnId });
    try {
      await active.promise;
    } catch (error) {
      if (signal?.aborted === true && (active.abortController.signal.aborted || isAbortError(error))) return;
      throw error;
    }
  }

  private async compactionWorker(
    active: ActiveCompaction,
    data: Readonly<CompactionBeginData>,
  ): Promise<CompactionResult> {
    try {
      const result = await this.compactionRound(active, data);
      if (this._compacting !== active) throw compactionCancelledReason(active);
      try {
        await this.profile.refreshSystemPrompt();
      } catch (error) {
        this.log.error('failed to refresh system prompt after compaction', { error });
      }
      // Fallback floor when reinjection throws; raised below once the per-turn
      // reminders are back.
      this.lastCompactedTokenCount = result.tokensAfter;
      // Re-arm the per-turn injectors while the compaction still holds the
      // context (before markCompleted), so the first post-compaction request —
      // including a replayed deferred prompt's — already carries the goal
      // reminder the compaction folded away.
      await this.contextInjector.injectAfterCompaction();
      // The reinjected reminders are part of the post-compaction floor: a
      // baseline captured before this point would leave them outside the
      // "nothing new since compaction" guard and checkAutoCompaction could
      // re-trigger against a shape that cannot shrink.
      this.lastCompactedTokenCount = this.tokenCountWithPending();
      if (!this.markCompleted(active)) {
        throw compactionCancelledReason(active);
      }
      const { contextSummary: _contextSummary, ...eventResult } = result;
      void _contextSummary;
      this.eventBus.publish({ type: 'compaction.completed', result: eventResult });
      return result;
    } catch (error) {
      if (active.abortController.signal.aborted || isAbortError(error)) {
        this.cancelActive(active);
        throw error;
      }
      const blockedByTurn = this._compacting === active && active.blockedByTurn;
      if (this._compacting === active) {
        this.cancelActive(active);
      }
      if (blockedByTurn) {
        throw error;
      }
      this.eventBus.publish({
        type: 'error',
        ...toKimiErrorPayload(error),
      });
      throw error;
    } finally {
      // Fires on completion, cancellation, AND failure so input deferred while
      // the compaction held the context is never lost. `_compacting` is already
      // null on every path, so a replayed launch starts a turn instead of
      // re-buffering.
      await this.hooks.onDidFinishCompaction.run(active);
    }
  }

  private async compactionRound(
    active: ActiveCompaction,
    data: Readonly<CompactionBeginData>,
  ): Promise<CompactionResult> {
    const startedAt = Date.now();
    const originalHistory = [...this.context.get()];
    const tokensBefore = estimateTokensForMessages(originalHistory);
    let retryCount = 0;

    try {
      const signal = active.abortController.signal;
      signal.throwIfAborted();

      await this.hooks.onWillCompact.run(active);

      const resolvedModel = this.profile.resolveModelContext();
      const maxContextTokens = resolvedModel.modelCapabilities.max_context_tokens;
      const defaultCompactionCap =
        maxContextTokens > 0
          ? Math.min(maxContextTokens, DEFAULT_COMPACTION_MAX_COMPLETION_TOKENS)
          : undefined;
      const compactionMaxOutputSize = resolvedModel.maxOutputSize ?? defaultCompactionCap;

      const instruction = renderPrompt(compactionInstructionTemplate, {
        customInstruction: data.instruction?.trim() ?? '',
      }).trimEnd();

      const delays = retryBackoffDelays(MAX_COMPACTION_RETRY_ATTEMPTS);
      let attempt: CompactionAttemptResult | undefined;
      let historyForModel: readonly ContextMessage[] = stripDynamicToolContext(originalHistory);
      let droppedCount = 0;
      let overflowShrinkCount = 0;
      let emptyOrTruncatedShrinkCount = 0;
      while (true) {
        const messagesToCompact = historyForModel;
        // Raw context slice — `llmRequester` projects every request once;
        // projecting here too would run micro-compaction on shifted indices.
        const messages: Message[] = [...messagesToCompact, createUserMessage(instruction)];
        const estimatedCompactionRequestTokens = this.estimateRequestTokens(messages);

        try {
          attempt = collectSummary(
            await this.llmRequester.request(
              {
                messages,
                maxOutputSize: compactionMaxOutputSize,
                source: { type: 'operation', requestKind: 'full_compaction' },
                retry: {
                  maxAttempts: 1,
                },
              },
              undefined,
              signal,
            ),
          );
          break;
        } catch (error) {
          const isContextOverflow = this.shouldRecoverFromContextOverflow(
            error,
            estimatedCompactionRequestTokens,
          );
          if (isContextOverflow) {
            this.observeContextOverflow(estimatedCompactionRequestTokens);
            overflowShrinkCount += 1;
            if (
              overflowShrinkCount > MAX_COMPACTION_OVERFLOW_SHRINK_ATTEMPTS ||
              messagesToCompact.length <= 1
            ) {
              throw error;
            }
            const before = messagesToCompact.length;
            historyForModel = shrinkCompactionHistoryAfterOverflow(
              messagesToCompact,
              overflowShrinkCount,
            );
            droppedCount += before - historyForModel.length;
            retryCount = 0;
            continue;
          }
          if (
            (error instanceof CompactionTruncatedError || error instanceof APIEmptyResponseError) &&
            messagesToCompact.length > 1
          ) {
            emptyOrTruncatedShrinkCount += 1;
            if (emptyOrTruncatedShrinkCount > MAX_COMPACTION_RETRY_ATTEMPTS) {
              throw error;
            }
            const reduced = dropOldestMessageAndLeadingToolResults(messagesToCompact);
            droppedCount += messagesToCompact.length - reduced.length;
            historyForModel = reduced;
            retryCount = 0;
            continue;
          }
          if (!isRetryableGenerateError(error)) {
            throw error;
          }
          if (retryCount + 1 >= MAX_COMPACTION_RETRY_ATTEMPTS) {
            throw error;
          }
          await sleepForRetry(delays[retryCount]!, signal);
          retryCount += 1;
        }
      }

      if (attempt === undefined) {
        throw new APIEmptyResponseError(
          'The compaction response did not contain a usable summary.',
        );
      }

      if (!historySafeToCompact(this.context.get(), originalHistory)) {
        const active = this._compacting;
        if (active !== null) {
          this.cancelActive(active, 'history_changed');
        }
        throw compactionCancelledReason(active);
      }

      const summary = this.postProcessSummary(attempt.summary);
      const normalizedDroppedCount = droppedCount === 0 ? undefined : droppedCount;
      const result = isSpineEnabled()
        ? await this.applyRootCompaction(summary, originalHistory.length, tokensBefore, normalizedDroppedCount)
        : this.context.applyCompaction({
            summary,
            contextSummary: buildCompactionSummaryText(summary),
            compactedCount: originalHistory.length,
            tokensBefore,
            droppedCount: normalizedDroppedCount,
          });

      this.telemetry.track('compaction_finished', {
        // Never send `data.instruction` (user-authored content) to telemetry.
        source: data.source,
        tokens_before: result.tokensBefore,
        tokens_after: result.tokensAfter,
        duration_ms: Date.now() - startedAt,
        compacted_count: result.compactedCount,
        dropped_count: result.droppedCount,
        retry_count: retryCount,
        round: 1,
        thinking_effort: this.profile.data().thinkingLevel,
        ...usageTelemetry(attempt.usage),
      });
      return result;
    } catch (error) {
      const failedTelemetry = (category: string): CompactionTelemetryProperties => ({
        source: data.source,
        tokens_before: tokensBefore,
        duration_ms: Date.now() - startedAt,
        round: 1,
        retry_count: retryCount,
        thinking_effort: this.profile.data().thinkingLevel,
        error_type: error instanceof Error ? error.name : 'Unknown',
        error_category: category,
      });
      if (isAbortError(error)) {
        // Race cancels (history changed under the in-flight summary request)
        // ride the abort path but are not user aborts: record them as their
        // own failure category instead of letting them vanish silently. User
        // aborts stay untracked, as before.
        if (active.cancelReason === 'history_changed') {
          this.telemetry.track('compaction_failed', failedTelemetry('history_changed'));
        }
        throw error;
      }
      this.telemetry.track('compaction_failed', failedTelemetry('summary_generation'));
      if (isKimiError(error) && error.code === ErrorCodes.AUTH_LOGIN_REQUIRED) throw error;
      throw new KimiError(ErrorCodes.COMPACTION_FAILED, String(error), { cause: error });
    }
  }

  private async applyRootCompaction(
    summary: string,
    compactedCount: number,
    tokensBefore: number,
    droppedCount: number | undefined,
  ): Promise<CompactionResult> {
    const contextSummary = buildCompactionSummaryText(summary);
    const summaryMessage = createCompactionSummaryMessage(contextSummary);
    const summaryAt = this.context.get().length;
    // The epoch boundary folds everything before `epochStartAt` out of the
    // projection except the summary message itself — snapshot that span before
    // appending so the epoch archive records exactly what the model stops
    // seeing.
    const foldedMessages = this.context.get().slice(0, summaryAt);
    this.context.append(summaryMessage);
    const epochStartAt = this.context.get().length;
    const tokensAfter = estimateTokensForMessages([summaryMessage]);
    const spineState = this.wire.getModel(SpineModel);
    const epoch = spineState.rootEpoch + 1;
    const archivePath = await this.spine.archiveEpochRoot({
      epoch,
      epochStartAt,
      epochMemoryAt: summaryAt,
      summary,
      messages: foldedMessages,
    });
    if (archivePath === undefined) {
      // `archiveEpochRoot` only declines when spine is disabled (impossible on
      // this path) or the hostFs write failed — surface the latter so a
      // missing epoch archive is diagnosable instead of silently absent.
      this.log.warn(
        'Spine epoch archive could not be written; root compaction proceeds without an archive path.',
        { epoch },
      );
    }
    this.wire.dispatch(
      spineRootCompact({
        epoch,
        epochStartAt,
        epochMemoryAt: summaryAt,
        archivePath,
      }),
      contextSizeMeasured({ length: epochStartAt, tokens: tokensAfter, kind: 'estimate' }),
    );
    return {
      summary,
      contextSummary,
      compactedCount,
      tokensBefore,
      tokensAfter,
      keptUserMessageCount: 0,
      droppedCount,
    };
  }

  private postProcessSummary(summary: string): string {
    const todos = this.currentTodos();
    if (todos.length === 0) {
      return summary;
    }
    return `${summary.trim()}\n\n${renderTodoList(todos, '## TODO List')}`;
  }

  private currentTodos(): readonly TodoItem[] {
    // With spine enabled the tree (not the frozen flat list) carries the plan:
    // the TodoList tool is gated off, so anything left here is stale data from
    // before the experiment switched on. The tree itself survives compaction
    // in the wire and needs no re-injection.
    if (isSpineEnabled()) return [];
    return this.todo.getTodos();
  }

  private tokenCountWithPending(): number {
    return this.contextSize.get().size;
  }

  /**
   * Resolved lazily (not constructor-injected): materializing the injector
   * from this constructor would reorder loop-hook registration across the
   * dependency cascade (see AgentPromptService.fullCompaction for the same
   * hazard).
   */
  private get contextInjector(): IAgentContextInjectorService {
    if (this.contextInjectorService === undefined) {
      this.contextInjectorService = this.instantiation.invokeFunction((accessor) =>
        accessor.get(IAgentContextInjectorService),
      );
    }
    return this.contextInjectorService;
  }
}

function findAPIStatusError(error: unknown): APIStatusError | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    if (current instanceof APIStatusError) return current;
    seen.add(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

function collectSummary(finish: LLMRequestFinish): CompactionAttemptResult {
  if (finish.providerFinishReason === 'truncated') {
    throw new CompactionTruncatedError();
  }

  const summary = finish.message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim();
  if (summary.length === 0) {
    throw new APIEmptyResponseError(
      'The compaction response did not contain a non-empty summary.',
    );
  }

  return { summary, usage: finish.usage };
}

function historySafeToCompact(
  current: readonly ContextMessage[],
  original: readonly ContextMessage[],
): boolean {
  if (current.length < original.length) return false;
  if (!original.every((message, index) => message === current[index])) return false;
  return current.slice(original.length).every(isRealUserInput);
}

function shrinkCompactionHistoryAfterOverflow<T extends Message>(
  messages: readonly T[],
  attempt: number,
): T[] {
  if (messages.length <= 1) return messages.slice();
  const ratio = COMPACTION_OVERFLOW_SHRINK_RATIOS[
    Math.min(attempt - 1, COMPACTION_OVERFLOW_SHRINK_RATIOS.length - 1)
  ]!;
  const tokenBudget = Math.floor(estimateTokensForMessages(messages) * ratio);
  return takeRecentMessagesWithinTokenBudget(messages, tokenBudget);
}

function takeRecentMessagesWithinTokenBudget<T extends Message>(
  messages: readonly T[],
  tokenBudget: number,
): T[] {
  let start = messages.length;
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const messageTokens = estimateTokensForMessage(messages[i]!);
    if (tokens + messageTokens > tokenBudget) break;
    tokens += messageTokens;
    start = i;
  }
  if (start === 0) start = 1;
  return dropLeadingToolResults(messages.slice(start));
}

function dropOldestMessageAndLeadingToolResults<T extends { readonly role: string }>(
  messages: readonly T[],
): T[] {
  if (messages.length <= 1) return messages.slice();
  return dropLeadingToolResults(messages.slice(1));
}

function dropLeadingToolResults<T extends { readonly role: string }>(messages: readonly T[]): T[] {
  let start = 0;
  while (start < messages.length && messages[start]!.role === 'tool') {
    start += 1;
  }
  return messages.slice(start);
}

function usageTelemetry(usage: TokenUsage | null): CompactionTelemetryProperties {
  if (usage === null) return {};
  return {
    input_other: usage.inputOther,
    output: usage.output,
    input_cache_read: usage.inputCacheRead,
    input_cache_creation: usage.inputCacheCreation,
  };
}

function compactionCancelledReason(active: ActiveCompaction | null): Error {
  const reason = active?.abortController.signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error('Compaction cancelled.');
  error.name = 'AbortError';
  return error;
}

// Construct eagerly (not delayed): the service registers turn and loop hooks
// (onLaunched / beforeStep / afterStep / onError) that drive auto
// compaction. With delayed instantiation the eager `accessor.get(IAgentFullCompactionService)`
// only realizes a proxy, so the hooks would not register until the first RPC —
// after turns have already run without the auto-compaction gate.
registerScopedService(
  LifecycleScope.Agent,
  IAgentFullCompactionService,
  AgentFullCompactionService,
  InstantiationType.Eager,
  'fullCompaction',
);
