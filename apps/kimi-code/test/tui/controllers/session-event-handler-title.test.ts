import { describe, expect, it, vi } from 'vitest';

import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { getBuiltInPalette } from '#/tui/theme';

function makeHost(options: { sessionTitle?: string | null; generateTitle?: () => Promise<string | undefined> } = {}) {
  const harness = {
    generateSessionTitle: vi.fn(options.generateTitle ?? (async () => undefined)),
  };
  const host = {
    state: {
      appState: {
        sessionId: 's1',
        sessionTitle: options.sessionTitle ?? null,
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
  it('requests a title after a turn ends while the session has none', () => {
    const { host, harness } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnEndedEvent(), vi.fn());

    expect(harness.generateSessionTitle).toHaveBeenCalledWith({ id: 's1' });
  });

  it('requests a title after a turn ends even when an easy title exists', () => {
    const { host, harness } = makeHost({ sessionTitle: '首条 prompt 的截断标题' });
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnEndedEvent(), vi.fn());

    expect(harness.generateSessionTitle).toHaveBeenCalledWith({ id: 's1' });
  });

  it('stops requesting after a title was generated', async () => {
    const { host, harness } = makeHost({ generateTitle: async () => '生成的标题' });
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnEndedEvent(), vi.fn());
    await flushMicrotasks();
    handler.handleEvent(turnEndedEvent(), vi.fn());

    expect(harness.generateSessionTitle).toHaveBeenCalledTimes(1);
  });

  it('keeps requesting after an unavailable (undefined) result', async () => {
    const { host, harness } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnEndedEvent(), vi.fn());
    await flushMicrotasks();
    handler.handleEvent(turnEndedEvent(), vi.fn());

    expect(harness.generateSessionTitle).toHaveBeenCalledTimes(2);
  });

  it('stops requesting after the harness rejects, and resetRuntimeState re-enables', async () => {
    const { host, harness } = makeHost({
      generateTitle: async () => {
        throw new Error('not implemented');
      },
    });
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnEndedEvent(), vi.fn());
    await flushMicrotasks();
    handler.handleEvent(turnEndedEvent(), vi.fn());
    expect(harness.generateSessionTitle).toHaveBeenCalledTimes(1);

    handler.resetRuntimeState();
    handler.handleEvent(turnEndedEvent(), vi.fn());
    expect(harness.generateSessionTitle).toHaveBeenCalledTimes(2);
  });

  it('ignores a generated title from the previous session after runtime reset', async () => {
    let resolveTitle: ((title: string | undefined) => void) | undefined;
    const pendingTitle = new Promise<string | undefined>((resolve) => {
      resolveTitle = resolve;
    });
    const { host, harness } = makeHost();
    harness.generateSessionTitle.mockReturnValueOnce(pendingTitle);
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnEndedEvent('s1'), vi.fn());
    host.state.appState.sessionId = 's2';
    handler.resetRuntimeState();
    resolveTitle?.('s1 generated title');
    await flushMicrotasks();
    handler.handleEvent(turnEndedEvent('s2'), vi.fn());

    expect(harness.generateSessionTitle).toHaveBeenCalledTimes(2);
    expect(harness.generateSessionTitle).toHaveBeenLastCalledWith({ id: 's2' });
  });

  it('ignores a rejection from the previous runtime after same-session reset', async () => {
    let rejectTitle: ((error: Error) => void) | undefined;
    const pendingTitle = new Promise<string | undefined>((_resolve, reject) => {
      rejectTitle = reject;
    });
    const { host, harness } = makeHost();
    harness.generateSessionTitle.mockReturnValueOnce(pendingTitle);
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnEndedEvent(), vi.fn());
    handler.resetRuntimeState();
    rejectTitle?.(new Error('stale request failed'));
    await flushMicrotasks();
    handler.handleEvent(turnEndedEvent(), vi.fn());

    expect(harness.generateSessionTitle).toHaveBeenCalledTimes(2);
  });
});
