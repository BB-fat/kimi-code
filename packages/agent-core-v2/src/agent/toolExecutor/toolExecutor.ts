import { createDecorator } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { ToolResult } from '#/agent/tool/toolContract';
import type { ToolDidExecuteContext, ToolWillExecuteContext } from '#/agent/tool/toolHooks';
import type { ToolCall } from '#/app/llmProtocol/message';
import type { OrderedHookSlot } from '#/hooks';

export interface ToolCallStartedPayload {
  readonly toolCallId: string;
  readonly name: string;
  readonly args: unknown;
}

export interface ToolExecutorExecuteOptions {
  readonly signal: AbortSignal;
  readonly turnId: number;
  readonly onToolCall?: (payload: ToolCallStartedPayload) => void;
}

export interface ToolExecutionResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly result: ToolResult;
}

/**
 * Wording hook for a tool call the executor will not run: it maps the tool
 * name to substitute result text; returning `undefined` declines so the
 * executor asks the next registered describer, then falls back to its
 * default wording.
 */
export type ToolCallDescriber = (name: string) => string | undefined;

export interface IAgentToolExecutorService {
  readonly _serviceBrand: undefined;

  execute(calls: ToolCall[], options: ToolExecutorExecuteOptions): AsyncIterable<ToolExecutionResult>;

  /**
   * Register a describer for calls whose tool name still resolves but must
   * not execute right now (e.g. a progressive-disclosure tool that is
   * visible but not loaded). Describers run in registration order *before*
   * argument validation; the first non-undefined wording wins.
   */
  registerUnavailableToolDescriber(describer: ToolCallDescriber): IDisposable;

  /**
   * Register a describer for calls whose tool name resolves to no registered
   * tool (e.g. a loaded MCP tool whose server disconnected). Runs at the
   * not-found reject; the first non-undefined wording wins, keeping the
   * default `Tool "<name>" not found` for plain unknown names.
   */
  registerMissingToolDescriber(describer: ToolCallDescriber): IDisposable;

  readonly hooks: {
    readonly onWillExecuteTool: OrderedHookSlot<ToolWillExecuteContext>;
    readonly onDidExecuteTool: OrderedHookSlot<ToolDidExecuteContext>;
  };
}

export const IAgentToolExecutorService =
  createDecorator<IAgentToolExecutorService>('agentToolExecutorService');
