/**
 * Scenario: LLM requester retries once with strict projection after provider
 * tool-use adjacency rejection.
 *
 * Responsibilities: assert retry eligibility, strict-history rebuilding,
 * request recording, and usage accounting. Wiring: real
 * AgentLLMRequesterService with stubbed context memory, projector, context
 * sizing, profile, model, telemetry, and wire/log services. Run:
 * ../../node_modules/.bin/vitest run test/llmRequester/strict-resend.test.ts
 */

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import {
  IAgentContextProjectorService,
  type ProjectOptions,
} from '#/agent/contextProjector/contextProjector';
import { AgentLLMRequesterService } from '#/agent/llmRequester/llmRequesterService';
import { IAgentLLMRequesterService, type LLMRequestSource } from '#/agent/llmRequester/llmRequester';
import { IAgentContextSizeService } from '#/agent/contextSize/contextSize';
import { IAgentProfileService } from '#/agent/profile/profile';
import type { ToolInfo } from '#/agent/tool/toolContract';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { IAgentUsageService } from '#/agent/usage/usage';
import { IConfigService } from '#/app/config/config';
import { APIStatusError } from '#/app/llmProtocol/errors';
import type { MaxCompletionTokensOptions } from '#/app/llmProtocol/provider';
import type { Tool } from '#/app/llmProtocol/tool';
import { emptyUsage } from '#/app/llmProtocol/usage';
import type { Message } from '#/app/llmProtocol/message';
import type { ModelCapability } from '#/app/llmProtocol/capability';
import type { LLMEvent, Model } from '#/app/model/modelInstance';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ILogService } from '#/_base/log/log';
import { IAgentWireService } from '#/wire/tokens';
import { WireService } from '#/wire/wireServiceImpl';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const capabilities: ModelCapability = {
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: false,
  max_context_tokens: 1000,
};

const history: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
];

function createModel(
  calls: { value: number },
  capturedBudgetOptions: { value?: MaxCompletionTokensOptions } = {},
  failFirst = true,
): Model {
  const build = (): Model => ({
    id: 'm',
    name: 'wire-model',
    aliases: [],
    protocol: 'anthropic',
    baseUrl: 'https://example.test',
    headers: {},
    capabilities,
    maxContextSize: 1000,
    thinkingEffort: null,
    alwaysThinking: false,
    providerName: 'p',
    authProvider: { getAuth: async () => undefined },
    withThinking: () => build(),
    withMaxCompletionTokens: (_maxTokens: number, options?: MaxCompletionTokensOptions) => {
      capturedBudgetOptions.value = options;
      return build();
    },
    withGenerationKwargs: () => build(),
    withProviderOptions: () => build(),
    withThinkingKeep: () => build(),
    request: async function* () {
      calls.value += 1;
      if (failFirst && calls.value === 1) {
        throw new APIStatusError(400, 'messages: `tool_use` ids must be unique');
      }
      yield {
        type: 'finish',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], toolCalls: [] },
        providerFinishReason: 'completed',
        rawFinishReason: 'stop',
        id: 'resp-1',
      };
    },
  });
  return build();
}

let disposables: DisposableStore;

beforeEach(() => {
  disposables = new DisposableStore();
});

afterEach(() => disposables.dispose());

function createService(
  model: Model,
  projector: Pick<IAgentContextProjectorService, 'project' | 'projectStrict'>,
  contextSize: Pick<IAgentContextSizeService, 'get' | 'measured'> = {
    get: () => ({ size: 0, measured: 0, estimated: 0 }),
    measured: () => undefined,
  },
  toolEntries: readonly ToolInfo[] = [],
) {
  const ix = disposables.add(new TestInstantiationService());
  const profile: Partial<IAgentProfileService> = {
    resolveModelContext: () => ({
      modelAlias: 'm',
      modelCapabilities: capabilities,
      maxOutputSize: undefined,
      alwaysThinking: undefined,
      thinkingLevel: 'off',
      reservedContextSize: undefined,
      compactionTriggerRatio: undefined,
    }),
    getProvider: () => model,
    getSystemPrompt: () => 'system',
    data: () => ({
      cwd: '',
      modelAlias: 'm',
      modelCapabilities: capabilities,
      thinkingLevel: 'off',
      systemPrompt: 'system',
    }),
    isToolActive: () => true,
  };
  const usage = { record: () => undefined, status: () => ({}) };
  const context = { get: () => history };
  const tools = { list: () => toolEntries };
  const config: Partial<IConfigService> = {
    get: (() => undefined) as IConfigService['get'],
  };
  const log = { info: () => undefined, warn: () => undefined };
  const telemetry = { track: () => undefined, track2: () => undefined };
  const toolSelect: Partial<IAgentToolSelectService> = {
    enabled: () => false,
    shapeTools: (entries) => entries,
    shapeHistory: (messages) => messages,
  };

  ix.stub(IAgentContextMemoryService, context);
  ix.stub(IAgentToolSelectService, toolSelect);
  ix.stub(IAgentContextProjectorService, projector);
  ix.stub(IAgentContextSizeService, contextSize);
  ix.stub(IAgentToolRegistryService, tools);
  ix.stub(IAgentProfileService, profile);
  ix.stub(IAgentUsageService, usage);
  ix.stub(IConfigService, config);
  ix.stub(ILogService, log);
  ix.stub(ITelemetryService, telemetry);
  ix.set(
    IAgentWireService,
    new SyncDescriptor(WireService, [{ logScope: 'wire', logKey: 'strict-resend' }]),
  );
  ix.set(IAgentLLMRequesterService, new SyncDescriptor(AgentLLMRequesterService));

  return ix.get(IAgentLLMRequesterService);
}

describe('AgentLLMRequesterService strict resend', () => {
  it('resends once with strict projection after a recoverable structural 400', async () => {
    const calls = { value: 0 };
    let projectCalls = 0;
    let strictCalls = 0;
    const service = createService(createModel(calls), {
      project: (messages: readonly ContextMessage[]) => {
        projectCalls += 1;
        return messages;
      },
      projectStrict: (messages: readonly ContextMessage[]) => {
        strictCalls += 1;
        return messages;
      },
    });

    const result = await service.request({ retry: { maxAttempts: 1 } });

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(result.usage).toEqual(emptyUsage());
    expect(calls.value).toBe(2);
    expect(projectCalls).toBe(1);
    expect(strictCalls).toBe(1);
  });

  it('does not resend for non-recoverable errors', async () => {
    const model = createModel({ value: 0 });
    Object.defineProperty(model, 'request', {
      value: async function* () {
        const events: LLMEvent[] = [];
        for (const event of events) yield event;
        throw new APIStatusError(401, 'unauthorized');
      },
    });
    Object.defineProperty(model, 'withMaxCompletionTokens', {
      value: () => model,
    });
    let strictCalls = 0;
    const service = createService(model, {
      project: (messages: readonly ContextMessage[]) => messages,
      projectStrict: (messages: readonly ContextMessage[]) => {
        strictCalls += 1;
        return messages;
      },
    });

    await expect(service.request({ retry: { maxAttempts: 1 } })).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(strictCalls).toBe(0);
  });
});

describe('AgentLLMRequesterService completion budget sizing', () => {
  const contextSizeWithTail: Pick<IAgentContextSizeService, 'get' | 'measured'> = {
    get: () => ({ size: 600, measured: 100, estimated: 500 }),
    measured: () => undefined,
  };
  const identityProjector: Pick<IAgentContextProjectorService, 'project' | 'projectStrict'> = {
    project: (messages: readonly ContextMessage[]) => messages,
    projectStrict: (messages: readonly ContextMessage[]) => messages,
  };

  it('feeds the full context size (measured prefix + estimated tail) to the budget clamp', async () => {
    const budget: { value?: MaxCompletionTokensOptions } = {};
    const service = createService(
      createModel({ value: 0 }, budget, false),
      identityProjector,
      contextSizeWithTail,
    );

    await service.request({});

    // The tail accumulated since the last usage event must count toward the
    // remaining-window clamp; `.measured` alone would drift optimistic.
    expect(budget.value?.usedContextTokens).toBe(600);
  });

  it('skips the remaining-window clamp for overridden messages', async () => {
    const budget: { value?: MaxCompletionTokensOptions } = {};
    const service = createService(
      createModel({ value: 0 }, budget, false),
      identityProjector,
      contextSizeWithTail,
    );

    await service.request({ messages: [...history] });

    expect(budget.value).toBeDefined();
    expect(budget.value?.usedContextTokens).toBeUndefined();
  });
});

describe('AgentLLMRequesterService fold application', () => {
  function recordingProjector(seen: { value?: ProjectOptions }) {
    return {
      project: (messages: readonly ContextMessage[], options?: ProjectOptions) => {
        seen.value = options;
        return messages;
      },
      projectStrict: (messages: readonly ContextMessage[], options?: ProjectOptions) => {
        seen.value = options;
        return messages;
      },
    };
  }

  it('applies folds for requests over the live history', async () => {
    const seen: { value?: ProjectOptions } = {};
    const service = createService(createModel({ value: 0 }, {}, false), recordingProjector(seen));

    await service.request({ retry: { maxAttempts: 1 } });

    expect(seen.value).toEqual({ applyFolds: true });
  });

  it('skips folds for requests over an explicit message list', async () => {
    const seen: { value?: ProjectOptions } = {};
    const service = createService(createModel({ value: 0 }, {}, false), recordingProjector(seen));

    await service.request({ messages: [...history], retry: { maxAttempts: 1 } });

    expect(seen.value).toEqual({ applyFolds: false });
  });
});

describe('AgentLLMRequesterService system prompt contributions', () => {
  const identityProjector: Pick<IAgentContextProjectorService, 'project' | 'projectStrict'> = {
    project: (messages: readonly ContextMessage[]) => messages,
    projectStrict: (messages: readonly ContextMessage[]) => messages,
  };
  const turnSource: LLMRequestSource = { type: 'turn', turnId: 1 };
  const readTool: Tool = { name: 'Read', description: 'read files', parameters: {} };
  const readToolInfo: ToolInfo = { ...readTool, source: 'builtin' };

  function capturingModel(captured: { systemPrompt?: string; toolNames?: string[] }): Model {
    const model = createModel({ value: 0 }, {}, false);
    // The `withXxx` builders of `createModel` return fresh instances, so patch
    // them to return the same instance — otherwise the capture patch below is
    // lost the moment the requester applies the completion budget.
    Object.defineProperties(model, {
      request: {
        value: async function* (input: { systemPrompt: string; tools: readonly Tool[] }) {
          captured.systemPrompt = input.systemPrompt;
          captured.toolNames = input.tools.map((tool) => tool.name);
          yield {
            type: 'finish',
            message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], toolCalls: [] },
            providerFinishReason: 'completed',
            rawFinishReason: 'stop',
            id: 'resp-1',
          };
        },
      },
      withMaxCompletionTokens: { value: () => model },
      withThinking: { value: () => model },
      withGenerationKwargs: { value: () => model },
      withProviderOptions: { value: () => model },
      withThinkingKeep: { value: () => model },
    });
    return model;
  }

  it('applies contributions with the request source and final tool list', async () => {
    const captured: { systemPrompt?: string } = {};
    const seen: { source?: LLMRequestSource; toolNames?: string[] } = {};
    const service = createService(capturingModel(captured), identityProjector);
    service.registerSystemPromptContribution('test', (prompt, context) => {
      seen.source = context.source;
      seen.toolNames = context.tools.map((tool) => tool.name);
      return `${prompt}\nCONTRIBUTED`;
    });

    await service.request({ source: turnSource, tools: [readTool] });

    expect(captured.systemPrompt).toBe('system\nCONTRIBUTED');
    expect(seen.source).toEqual(turnSource);
    expect(seen.toolNames).toEqual(['Read']);
  });

  it('hands the default shaped tool list to contributions when no tool override is given', async () => {
    const seen: { toolNames?: string[] } = {};
    const service = createService(
      capturingModel({}),
      identityProjector,
      { get: () => ({ size: 0, measured: 0, estimated: 0 }), measured: () => undefined },
      [readToolInfo],
    );
    service.registerSystemPromptContribution('test', (prompt, context) => {
      seen.toolNames = context.tools.map((tool) => tool.name);
      return prompt;
    });

    await service.request({ source: turnSource });

    expect(seen.toolNames).toEqual(['Read']);
  });

  it('chains contributions in registration order', async () => {
    const captured: { systemPrompt?: string } = {};
    const service = createService(capturingModel(captured), identityProjector);
    service.registerSystemPromptContribution('a', (prompt) => `${prompt}|a`);
    service.registerSystemPromptContribution('b', (prompt) => `${prompt}|b`);

    await service.request({ source: turnSource });

    expect(captured.systemPrompt).toBe('system|a|b');
  });

  it('stops applying a contribution once its registration is disposed', async () => {
    const captured: { systemPrompt?: string } = {};
    const service = createService(capturingModel(captured), identityProjector);
    const registration = service.registerSystemPromptContribution(
      'gone',
      (prompt) => `${prompt}|gone`,
    );

    registration.dispose();
    await service.request({ source: turnSource });

    expect(captured.systemPrompt).toBe('system');
  });
});
