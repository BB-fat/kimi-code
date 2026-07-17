import { createDecorator } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { FinishReason } from '#/app/llmProtocol/finishReason';
import type { Message, StreamedMessagePart } from '#/app/llmProtocol/message';
import type { Tool } from '#/app/llmProtocol/tool';
import type { TokenUsage } from '#/app/llmProtocol/usage';
import type { LLMRequestTrace } from '#/app/llmProtocol/requestTrace';
import type { LogContext } from '#/_base/log/log';

export type LLMRequestLogFields = Readonly<LogContext>;

export type LLMRequestSource =
  | {
      readonly type: 'turn';
      readonly turnId: number;
      readonly step?: number;
      readonly logFields?: LLMRequestLogFields;
    }
  | {
      readonly type: 'operation';
      readonly requestKind?: string;
      readonly logFields?: LLMRequestLogFields;
    };

export interface LLMRequestRetryContext {
  readonly failedAttempt: number;
  readonly nextAttempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly errorName: string;
  readonly errorMessage: string;
  readonly statusCode?: number;
}

export type LLMRequestRetryHandler = (
  context: LLMRequestRetryContext,
) => void | Promise<void>;

export interface LLMRequestRetryOptions {
  readonly maxAttempts?: number;
  readonly onRetry?: LLMRequestRetryHandler;
}

export interface LLMStreamTiming {
  readonly firstTokenLatencyMs: number;
  readonly streamDurationMs: number;
  readonly requestBuildMs?: number;
  readonly serverFirstTokenMs?: number;
  readonly serverDecodeMs?: number;
  readonly clientConsumeMs?: number;
}

export interface LLMRequestParams {
  messages: Message[];
  tools: readonly Tool[];
  signal: AbortSignal;
  source?: LLMRequestSource;
}

export interface LLMRequestFinish {
  message: Message;
  usage: TokenUsage;
  model?: string | undefined;
  providerFinishReason?: FinishReason;
  rawFinishReason?: string;
  providerMessageId?: string;
  timing?: LLMStreamTiming;
  /** Trace id of the request that produced this finish (Kimi `x-trace-id`). */
  traceId?: string;
}

export type LLMRequestPartHandler = (part: StreamedMessagePart) => void | Promise<void>;

export interface LLMRequestOverrides {
  messages?: readonly Message[];
  tools?: readonly Tool[];
  systemPrompt?: string;
  source?: LLMRequestSource;
  maxOutputSize?: number;
  retry?: LLMRequestRetryOptions;
}

/**
 * Read-only view of the request being assembled, handed to system-prompt
 * contributions so they can decide whether they apply: `source` distinguishes
 * turns from operations (e.g. compaction), and `tools` is the final
 * provider-visible tool list of the request.
 */
export interface SystemPromptContributionContext {
  readonly source: LLMRequestSource | undefined;
  readonly tools: readonly Tool[];
}

/**
 * Transform over the assembled system prompt. Prompt-shaping features (e.g.
 * the spine view protocol block) register a contribution instead of the
 * requester importing them: the requester stays closed for modification.
 *
 * The contract a contribution signs up for:
 *   - It receives the prompt assembled so far plus the request's source and
 *     final tool list, and returns the prompt to pass on; return the input
 *     unchanged to decline.
 *   - Contributions compose in registration order, each seeing the output of
 *     the previous one.
 *   - The input prompt and context are read-only.
 */
export type SystemPromptContribution = (
  prompt: string,
  context: SystemPromptContributionContext,
) => string;

export interface LLMRequestTask {
  readonly trace: LLMRequestTrace;
  readonly result: Promise<LLMRequestFinish>;
}
export interface IAgentLLMRequesterService {
  readonly _serviceBrand: undefined;

  request(
    overrides?: LLMRequestOverrides,
    onPart?: LLMRequestPartHandler,
    signal?: AbortSignal,
  ): Promise<LLMRequestFinish>;

  /**
   * Register a contribution applied to every assembled system prompt; returns
   * a disposable that unregisters it. With no contributions registered the
   * profile's system prompt passes through unchanged.
   */
  registerSystemPromptContribution(
    id: string,
    contribution: SystemPromptContribution,
  ): IDisposable;

  start(
    overrides?: LLMRequestOverrides,
    onPart?: LLMRequestPartHandler,
    signal?: AbortSignal,
  ): LLMRequestTask;
}

export const IAgentLLMRequesterService = createDecorator<IAgentLLMRequesterService>(
  'agentLLMRequesterService',
);
