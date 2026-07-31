import { describe, expect, it, vi } from 'vitest';

import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { getBuiltInPalette } from '#/tui/theme';

function makeHost(options: { generateTitle?: () => Promise<string | undefined> } = {}) {
  const harness = {
    generateSessionTitle: vi.fn(options.generateTitle ?? (async () => undefined)),
  };
  const host = {
    state: {
      appState: {
        sessionId: 's1',
        sessionTitle: null,
        workDir: '/tmp/work',
        streamingPhase: 'waiting',
        model: 'kimi-model',
        permissionMode: 'auto',
      },
      queuedMessages: [],
      queuedMessageDispatchPending: false,
      theme: { palette: getBuiltInPalette('dark') },
      toolOutputExpanded: false,
      todoPanel: { getTodos: vi.fn(() => []) },
      transcriptContainer: { addChild: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    session: undefined,
    aborted: false,
    sessionEventUnsubscribe: undefined,
    streamingUI: {
      setTurnId: vi.fn(),
      flushNow: vi.fn(),
      resetToolUi: vi.fn(),
      finalizeTurn: vi.fn(),
    },
    harness,
    requireSession: vi.fn(),
    setAppState: vi.fn(),
    patchLivePane: vi.fn(),
    resetLivePane: vi.fn(),
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    track: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    restoreInputText: vi.fn(),
    appendTranscriptEntry: vi.fn(),
    sendNormalUserInput: vi.fn(),
    sendQueuedMessage: vi.fn(),
    shiftQueuedMessage: vi.fn(),
    updateActivityPane: vi.fn(),
    updateTerminalTitle: vi.fn(),
    handleShellOutput: vi.fn(),
    handleShellStarted: vi.fn(),
    btwPanelController: { routeEvent: vi.fn(() => false) },
    tasksBrowserController: {},
  };
  return { host: host as any, harness };
}

function turnEndedEvent(sessionId = 's1') {
  return {
    type: 'turn.ended',
    sessionId,
    agentId: 'main',
    turnId: 1,
    reason: 'completed',
  } as const;
}

async function flushMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('session auto title generation', () => {
  it.each([
    ['unavailable', async (): Promise<string | undefined> => undefined],
    ['applied', async (): Promise<string | undefined> => '生成的标题'],
    [
      'rejected',
      async (): Promise<string | undefined> => {
        throw new Error('core rpc unavailable');
      },
    ],
  ] as const)('requests only once per runtime when the attempt is %s', async (_outcome, generateTitle) => {
    const { host, harness } = makeHost({ generateTitle });
    const handler = new SessionEventHandler(host);

    handler.requestSessionTitleGeneration();
    await flushMicrotasks();
    handler.requestSessionTitleGeneration();

    expect(harness.generateSessionTitle).toHaveBeenCalledTimes(1);
    expect(harness.generateSessionTitle).toHaveBeenCalledWith({ id: 's1' });
  });

  it('does not request a title when a turn ends', () => {
    const { host, harness } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnEndedEvent(), vi.fn());

    expect(harness.generateSessionTitle).not.toHaveBeenCalled();
  });

  it('grants a fresh attempt on runtime reset', () => {
    const { host, harness } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.requestSessionTitleGeneration();
    handler.resetRuntimeState();
    handler.requestSessionTitleGeneration();

    expect(harness.generateSessionTitle).toHaveBeenCalledTimes(2);
  });

  it.each(['generated', 'custom'] as const)(
    'skips the request when the resumed session already has a %s title',
    (titleKind) => {
      const { host, harness } = makeHost();
      const handler = new SessionEventHandler(host);

      handler.syncTitleGenerationGate(titleKind);
      handler.requestSessionTitleGeneration();

      expect(harness.generateSessionTitle).not.toHaveBeenCalled();
    },
  );

  it.each(['replaceable', undefined] as const)(
    'requests when the resumed title state is %s',
    (titleKind) => {
      const { host, harness } = makeHost();
      const handler = new SessionEventHandler(host);

      handler.syncTitleGenerationGate(titleKind);
      handler.requestSessionTitleGeneration();

      expect(harness.generateSessionTitle).toHaveBeenCalledWith({ id: 's1' });
    },
  );

  it('re-opens the gate on runtime reset for a session seeded as settled', () => {
    const { host, harness } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.syncTitleGenerationGate('generated');
    handler.resetRuntimeState();
    handler.requestSessionTitleGeneration();

    expect(harness.generateSessionTitle).toHaveBeenCalledWith({ id: 's1' });
  });

  it('stops requesting after a custom rename event arrives', () => {
    const { host, harness } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(
      {
        type: 'session.meta.updated',
        agentId: 'main',
        sessionId: 's1',
        title: '用户手工标题',
        patch: { title: '用户手工标题', isCustomTitle: true },
      } as const,
      vi.fn(),
    );
    handler.requestSessionTitleGeneration();

    expect(harness.generateSessionTitle).not.toHaveBeenCalled();
  });
});
