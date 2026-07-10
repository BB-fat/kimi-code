import { createDecorator } from "#/_base/di/instantiation";
import type { IDisposable } from '#/_base/di/lifecycle';
import type { Message } from '#/app/llmProtocol/message';

import type { ContextMessage } from '#/agent/contextMemory/types';

/**
 * Pre-projection transform over the stored history. History-collapsing
 * features (spine) register a fold instead of the projector importing them:
 * the projector stays closed for modification, and folds compose in
 * registration order before projection. A fold must treat the input as
 * read-only and return a new array when it changes anything.
 */
export type ContextFold = (messages: readonly ContextMessage[]) => readonly ContextMessage[];

export interface IAgentContextProjectorService {
  readonly _serviceBrand: undefined;

  project(messages: readonly ContextMessage[]): readonly Message[];
  projectStrict(messages: readonly ContextMessage[]): readonly Message[];

  /**
   * Register a fold applied to every projection; returns a disposable that
   * unregisters it. With no folds registered the projection passes the stored
   * history through unchanged.
   */
  registerContextFold(id: string, fold: ContextFold): IDisposable;
}

export const IAgentContextProjectorService = createDecorator<IAgentContextProjectorService>(
  'agentContextProjectorService',
);
