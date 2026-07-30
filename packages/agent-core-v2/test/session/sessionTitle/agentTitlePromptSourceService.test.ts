/**
 * Scenario: the Agent-scoped title prompt projection reads the durable wire
 * journal, follows conversation undo, and includes prompts still waiting in
 * the live prompt queue. Wiring: the real source with contract-level fakes
 * for storage, wire flush, context, and prompt queue.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAgentTitlePromptSource } from '#/session/sessionTitle/agentTitlePromptSource';
import { AgentTitlePromptSourceService } from '#/session/sessionTitle/agentTitlePromptSourceService';
import { IWireService } from '#/wire/wire';
import type { WireRecord } from '#/wire/record';

function promptRecord(id: string, text: string): WireRecord {
  return {
    type: 'context.append_message',
    message: {
      id,
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin: { kind: 'user' },
    },
  };
}

function undoRecord(count: number): WireRecord {
  return { type: 'context.undo', count };
}

describe('AgentTitlePromptSource', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let records: WireRecord[];
  let liveMessages: readonly ContextMessage[];
  let queue: ReturnType<IAgentPromptService['list']>;

  beforeEach(() => {
    records = [];
    liveMessages = [];
    queue = { active: undefined, pending: [] };
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.definePartialInstance(IAgentContextMemoryService, { get: () => liveMessages });
        reg.definePartialInstance(IAgentPromptService, { list: () => queue });
        reg.defineInstance(
          IAgentScopeContext,
          makeAgentScopeContext({ agentId: 'main', agentScope: 'sessions/sess-1/agents/main' }),
        );
        reg.definePartialInstance(IAppendLogStore, {
          read: <R>() => (async function* () {
            yield* records as R[];
          })(),
        });
        reg.definePartialInstance(IWireService, { flush: async () => undefined });
        reg.define(IAgentTitlePromptSource, AgentTitlePromptSourceService);
      },
    });
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('returns the first three prompts from the journal and live queue in order', async () => {
    records = [promptRecord('one', '第一条')];
    queue = {
      active: undefined,
      pending: [
        {
          id: 'two',
          userMessageId: 'two',
          createdAt: '2026-01-01T00:00:00.000Z',
          state: 'pending',
          message: {
            id: 'two',
            role: 'user',
            content: [{ type: 'text', text: '第二条' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        },
        {
          id: 'three',
          userMessageId: 'three',
          createdAt: '2026-01-01T00:00:01.000Z',
          state: 'pending',
          message: {
            id: 'three',
            role: 'user',
            content: [{ type: 'text', text: '第三条' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        },
      ],
    };

    await expect(ix.get(IAgentTitlePromptSource).firstUserPrompts(3)).resolves.toEqual([
      '第一条',
      '第二条',
      '第三条',
    ]);
  });

  it('excludes a prompt removed by conversation undo', async () => {
    records = [promptRecord('one', 'A'), undoRecord(1), promptRecord('two', 'B')];

    await expect(ix.get(IAgentTitlePromptSource).firstUserPrompts(3)).resolves.toEqual(['B']);
  });

  it('rebuilds the same prompt list from persisted records without a live context', async () => {
    records = [promptRecord('one', '第一条'), promptRecord('two', '第二条')];
    liveMessages = [];

    await expect(ix.get(IAgentTitlePromptSource).firstUserPrompts(3)).resolves.toEqual([
      '第一条',
      '第二条',
    ]);
  });
});
