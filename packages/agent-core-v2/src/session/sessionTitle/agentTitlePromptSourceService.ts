/**
 * `sessionTitle` domain (L6) — `IAgentTitlePromptSource` implementation.
 *
 * Projects the first active natural-language prompts from the Agent's
 * authoritative `wire` journal through `storage`, merging the live
 * `contextMemory` tail and `prompt` queue so submissions waiting behind an
 * active turn are visible. Bound at Agent scope.
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import {
  createContextTranscriptReducer,
  mergeContextTranscriptWithLive,
} from '#/agent/contextMemory/contextTranscript';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { promptMetadataTextFromContentParts } from '#/agent/prompt/promptMetadataText';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';
import { IWireService } from '#/wire/wire';

import { IAgentTitlePromptSource } from './agentTitlePromptSource';

export class AgentTitlePromptSourceService implements IAgentTitlePromptSource {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentPromptService private readonly prompt: IAgentPromptService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAppendLogStore private readonly appendLog: IAppendLogStore,
    @IWireService private readonly wire: IWireService,
  ) {}

  async firstUserPrompts(limit: number): Promise<readonly string[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) return [];

    await this.wire.flush();
    const reducer = createContextTranscriptReducer();
    for await (const record of this.appendLog.read<WireRecord>(
      this.scopeContext.scope(),
      AGENT_WIRE_RECORD_KEY,
    )) {
      reducer.add(record);
    }
    const transcript = mergeContextTranscriptWithLive(reducer.result(), this.context.get());
    const queue = this.prompt.list();
    const result: string[] = [];
    const seenMessageIds = new Set<string>();

    const add = (message: ContextMessage): void => {
      if (result.length >= limit || !isNaturalLanguagePrompt(message)) return;
      if (message.id !== undefined) {
        if (seenMessageIds.has(message.id)) return;
        seenMessageIds.add(message.id);
      }
      const text = promptMetadataTextFromContentParts(message.content);
      if (text !== undefined) result.push(text);
    };

    for (const message of transcript.messages) add(message);
    if (queue.active !== undefined) add(queue.active.message);
    for (const item of queue.pending) add(item.message);
    return result;
  }
}

function isNaturalLanguagePrompt(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  const origin = message.origin;
  return origin === undefined || origin.kind === 'user';
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentTitlePromptSource,
  AgentTitlePromptSourceService,
  ScopeActivation.OnDemand,
  'sessionTitle',
);
