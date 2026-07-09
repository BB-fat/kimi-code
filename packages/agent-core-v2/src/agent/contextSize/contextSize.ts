import { createDecorator } from '#/_base/di/instantiation';
import type { Message } from '#/app/llmProtocol/message';
import type { TokenUsage } from '#/app/llmProtocol/usage';

import type { ContextSizeSnapshotKind } from './contextSizeOps';

export interface ContextSize {
  readonly size: number;
  readonly measured: number;
  readonly estimated: number;
}

/** Provenance of the newest context-size record, exposed for status display. */
export interface ContextSizeMeasurement {
  readonly length: number;
  readonly tokens: number;
  readonly kind: ContextSizeSnapshotKind;
}

export interface IAgentContextSizeService {
  readonly _serviceBrand: undefined;

  get(start?: number, end?: number): ContextSize;
  measured(input: readonly Message[], output: readonly Message[], usage: TokenUsage): void;
  latestMeasurement(): ContextSizeMeasurement | undefined;
}

export const IAgentContextSizeService =
  createDecorator<IAgentContextSizeService>('agentContextSizeService');
