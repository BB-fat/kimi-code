// apps/kimi-web/test/side-chat.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../src/api/daemon/eventReducer';
import { useSideChat } from '../src/composables/client/useSideChat';
import type { ExtendedState } from '../src/composables/useKimiWebClient';
import type { AppMessage } from '../src/api/types';

const apiMock = vi.hoisted(() => ({
  startBtw: vi.fn(),
  submitPrompt: vi.fn(),
  undoSession: vi.fn(),
}));

vi.mock('../src/api', () => ({
  getKimiWebApi: () => apiMock,
}));

function createState(): ExtendedState {
  return {
    ...createInitialState(),
    sessions: [
      {
        id: 'sess_1',
        title: 'Session',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        busy: false as const,
        archived: false,
        currentPromptId: null,
        cwd: '/workspace',
        model: 'kimi-code',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          totalCostUsd: 0,
          contextTokens: 0,
          contextLimit: 0,
          turnCount: 0,
        },
        messageCount: 0,
        lastSeq: 0,
      },
    ],
    activeSessionId: 'sess_1',
    permission: 'auto',
    thinking: 'high',
    planModeBySession: { sess_1: true },
    swarmModeBySession: {},
    sideChatMessagesByAgent: {},
    sideChatSendingByAgent: {},
    sideChatUserMessageIdsBySession: {},
  } as unknown as ExtendedState;
}

describe('useSideChat — sendSideChatPromptOn', () => {
  it('carries model, thinking, permission and plan/swarm modes on the prompt', async () => {
    apiMock.startBtw.mockReset();
    apiMock.submitPrompt.mockReset();
    apiMock.startBtw.mockResolvedValue({ agentId: 'agent_btw_1' });
    apiMock.submitPrompt.mockResolvedValue({ promptId: 'pr_btw', userMessageId: 'msg_opt_btw' });

    const state = createState();
    const pushOperationFailure = vi.fn();
    const sideChat = useSideChat(state, {
      pushOperationFailure,
      nextOptimisticMsgId: () => 'msg_opt_btw',
      connectEventsIfNeeded: vi.fn(),
      getEventConn: () => null,
      resolveThinkingForPrompt: async () => undefined,
    });

    await sideChat.openSideChatOn('sess_1', 'what changed?');

    expect(apiMock.startBtw).toHaveBeenCalledWith('sess_1');
    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({
        agentId: 'agent_btw_1',
        model: 'kimi-code',
        thinking: 'high',
        permissionMode: 'auto',
        planMode: true,
        swarmMode: false,
      }),
    );
    expect(pushOperationFailure).not.toHaveBeenCalled();
  });

  it('falls back to the active level when the parent model has left the catalog', async () => {
    // resolveThinkingForPrompt returns undefined for a model the catalog no
    // longer lists — the submit then keeps the active-session level (same
    // fallback as the normal prompt paths).
    apiMock.startBtw.mockReset();
    apiMock.submitPrompt.mockReset();
    apiMock.startBtw.mockResolvedValue({ agentId: 'agent_btw_1' });
    apiMock.submitPrompt.mockResolvedValue({ promptId: 'pr_btw', userMessageId: 'msg_opt_btw' });

    const state = createState();
    state.thinking = 'max';
    const sideChat = useSideChat(state, {
      pushOperationFailure: vi.fn(),
      nextOptimisticMsgId: () => 'msg_opt_btw',
      connectEventsIfNeeded: vi.fn(),
      getEventConn: () => null,
      resolveThinkingForPrompt: async () => undefined,
    });

    await sideChat.openSideChatOn('sess_1', 'what changed?');

    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({ thinking: 'max' }),
    );
  });

  it('resolves thinking from the parent model, not the level of the session the user switched to', async () => {
    // startBtw spans an await during which the user can switch sessions; the
    // BTW prompt must still carry the PARENT model's level ('low'), never the
    // active view's ('max').
    apiMock.startBtw.mockReset();
    apiMock.submitPrompt.mockReset();
    apiMock.startBtw.mockResolvedValue({ agentId: 'agent_btw_1' });
    apiMock.submitPrompt.mockResolvedValue({ promptId: 'pr_btw', userMessageId: 'msg_opt_btw' });

    const state = createState();
    state.thinking = 'max'; // the user is now viewing a max-only session elsewhere
    const sideChat = useSideChat(state, {
      pushOperationFailure: vi.fn(),
      nextOptimisticMsgId: () => 'msg_opt_btw',
      connectEventsIfNeeded: vi.fn(),
      getEventConn: () => null,
      resolveThinkingForPrompt: async (_sid, id) => (id === 'kimi-code' ? 'low' : undefined),
    });

    await sideChat.openSideChatOn('sess_1', 'what changed?');

    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({ model: 'kimi-code', thinking: 'low' }),
    );
  });
});

describe('useSideChat — undoSideChat', () => {
  function msg(
    id: string,
    role: 'user' | 'assistant',
    text: string,
  ): AppMessage {
    return {
      id,
      sessionId: 'sess_1',
      role,
      content: [{ type: 'text', text }],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
  }

  it('calls :undo with the BTW agent_id and truncates the local transcript', async () => {
    apiMock.undoSession.mockReset();
    apiMock.undoSession.mockResolvedValue(undefined);

    const state = createState();
    state.sideChatMessagesByAgent = {
      agent_btw_1: [
        msg('u1', 'user', 'first'),
        msg('a1', 'assistant', 'reply 1'),
        msg('u2', 'user', 'second'),
        msg('a2', 'assistant', 'reply 2'),
      ],
    };
    state.sideChatUserMessageIdsBySession = {
      sess_1: ['u1', 'u2'],
    };

    const sideChat = useSideChat(state, {
      pushOperationFailure: vi.fn(),
      nextOptimisticMsgId: () => 'msg_opt',
      connectEventsIfNeeded: vi.fn(),
      getEventConn: () => null,
      resolveThinkingForPrompt: async () => undefined,
    });
    // Open the side chat against the existing agent without calling startBtw.
    sideChat.sideChatTargetBySession.value = {
      sess_1: { agentId: 'agent_btw_1' },
    };

    const undone = await sideChat.undoSideChat(1);

    expect(undone).toBe('second');
    expect(apiMock.undoSession).toHaveBeenCalledWith('sess_1', 1, 'agent_btw_1');
    expect(state.sideChatMessagesByAgent['agent_btw_1']).toEqual([
      msg('u1', 'user', 'first'),
      msg('a1', 'assistant', 'reply 1'),
    ]);
    expect(state.sideChatUserMessageIdsBySession['sess_1']).toEqual(['u1']);
  });

  it('reports failure and leaves the transcript untouched when :undo rejects', async () => {
    apiMock.undoSession.mockReset();
    apiMock.undoSession.mockRejectedValue(new Error('busy'));

    const state = createState();
    const messages = [
      msg('u1', 'user', 'hello'),
      msg('a1', 'assistant', 'hi'),
    ];
    state.sideChatMessagesByAgent = { agent_btw_1: messages };

    const pushOperationFailure = vi.fn();
    const sideChat = useSideChat(state, {
      pushOperationFailure,
      nextOptimisticMsgId: () => 'msg_opt',
      connectEventsIfNeeded: vi.fn(),
      getEventConn: () => null,
      resolveThinkingForPrompt: async () => undefined,
    });
    sideChat.sideChatTargetBySession.value = {
      sess_1: { agentId: 'agent_btw_1' },
    };

    const undone = await sideChat.undoSideChat(1);

    expect(undone).toBeNull();
    expect(pushOperationFailure).toHaveBeenCalledWith(
      'undoSideChat',
      expect.any(Error),
      { sessionId: 'sess_1' },
    );
    expect(state.sideChatMessagesByAgent['agent_btw_1']).toEqual(messages);
  });
});
