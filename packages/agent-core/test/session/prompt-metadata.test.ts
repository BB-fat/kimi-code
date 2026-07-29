/**
 * prompt-metadata — the session title / lastPrompt text derived from a
 * prompt payload.
 *
 * Tests pin:
 *   - media parts render as `[image]` / `[video]` / `[audio]` placeholders
 *   - an inline image-compression caption (harness metadata placed next to
 *     the image by prompt ingestion) never leaks into titles/lastPrompt,
 *     whether it is a standalone text part or merged into the user's text
 *   - SessionAPIImpl.steer updates title/lastPrompt exactly like prompt —
 *     a steer can launch the session's first turn (e.g. goal mode)
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import type { ProviderConfig } from '@moonshot-ai/kosong';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FlagResolver } from '../../src/flags';
import type { ResolvedAgentProfile } from '../../src/profile';
import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { promptMetadataTextFromPayload } from '../../src/session/prompt-metadata';
import { ProviderManager } from '../../src/session/provider-manager';
import { SessionAPIImpl } from '../../src/session/rpc';
import { buildImageCompressionCaption } from '../../src/tools/support/image-compress';
import { createScriptedGenerate } from '../agent/harness/scripted-generate';
import { testKaos } from '../fixtures/test-kaos';

const CAPTION = buildImageCompressionCaption({
  original: { width: 3264, height: 666, byteLength: 344 * 1024, mimeType: 'image/png' },
  final: { width: 2000, height: 408, byteLength: 282 * 1024, mimeType: 'image/png' },
  originalPath: '/tmp/originals/shot.png',
});

describe('promptMetadataTextFromPayload', () => {
  it('renders text and media placeholders', () => {
    const text = promptMetadataTextFromPayload({
      input: [
        { type: 'text', text: 'look at this' },
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
      ],
    });
    expect(text).toBe('look at this [image]');
  });

  it('keeps a standalone image-compression caption out of the metadata text', () => {
    const text = promptMetadataTextFromPayload({
      input: [
        { type: 'text', text: CAPTION },
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
      ],
    });
    expect(text).toBe('[image]');
  });

  it('strips a caption merged into the user text and keeps the rest', () => {
    const text = promptMetadataTextFromPayload({
      input: [
        { type: 'text', text: `能展示但是没有快捷键提示${CAPTION}` },
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
      ],
    });
    expect(text).toBe('能展示但是没有快捷键提示 [image]');
    expect(text).not.toContain('<system>');
    expect(text).not.toContain('Image compressed');
  });
});

describe('SessionAPIImpl prompt metadata', () => {
  it('derives title and lastPrompt from a steer the same way as a prompt', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const scripted = createScriptedGenerate();
    const session = track(
      new Session({
        id: 'prompt-metadata-steer',
        kaos: testKaos.withCwd(sessionDir),
        homedir: sessionDir,
        rpc: createSessionRpc(events),
        skills: { explicitDirs: [join(sessionDir, 'missing-skills')] },
        providerManager: testProviderManager(),
      }),
    );
    const { agent } = await session.createAgent(
      { type: 'main', generate: scripted.generate },
      { profile: testProfile() },
    );
    agent.config.update({ modelAlias: MOCK_PROVIDER.model, thinkingEffort: 'off' });
    agent.permission.setMode('yolo');

    const api = new SessionAPIImpl(session);
    await api.steer({ agentId: 'main', input: [{ type: 'text', text: 'steered goal objective' }] });
    if (agent.turn.hasActiveTurn) {
      await agent.turn.waitForCurrentTurn();
    }

    expect(session.metadata.title).toBe('steered goal objective');
    expect(session.metadata.lastPrompt).toBe('steered goal objective');
  });
});

const MOCK_PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  model: 'mock-model',
} as const satisfies ProviderConfig;

const MANAGED_PROVIDER = {
  type: 'kimi',
  baseUrl: 'https://api.example.test/coding/v1',
  oauth: { storage: 'file', key: 'kimi-code' },
} as const;

describe('SessionAPIImpl auto title', () => {
  it('replaces the easy title with the generated one when the flag is on', async () => {
    const fetchMock = stubChatTitleFetch('生成的标题');
    const { api, session, events, agent } = await setupAutoTitleSession({
      autoTitle: true,
    });

    await api.prompt({ agentId: 'main', input: [{ type: 'text', text: '帮我看个 Go 报错' }] });
    if (agent.turn.hasActiveTurn) {
      await agent.turn.waitForCurrentTurn();
    }

    await waitFor(() =>
      events.some((e) => e['type'] === 'session.meta.updated' && e['title'] === '生成的标题'),
    );
    expect(session.metadata.isCustomTitle).toBe(false);
    const [, init] = chatTitleCalls(fetchMock)[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({
      method: 'chat_title',
      params: { chat_content: 'user: 帮我看个 Go 报错' },
    });
    const titleEvents = events.filter((e) => e['type'] === 'session.meta.updated');
    expect(titleEvents.at(-1)).toMatchObject({ title: '生成的标题' });
  });

  it('keeps the easy title when the flag is off', async () => {
    const fetchMock = stubChatTitleFetch('生成的标题');
    const { api, session, agent } = await setupAutoTitleSession({ autoTitle: false });

    await api.prompt({ agentId: 'main', input: [{ type: 'text', text: '帮我看个 Go 报错' }] });
    if (agent.turn.hasActiveTurn) {
      await agent.turn.waitForCurrentTurn();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(chatTitleCalls(fetchMock)).toHaveLength(0);
    expect(session.metadata.title).toBe('帮我看个 Go 报错');
  });

  it('keeps the easy title when the managed provider is not OAuth-backed', async () => {
    const fetchMock = stubChatTitleFetch('生成的标题');
    const { api, session, agent } = await setupAutoTitleSession({
      autoTitle: true,
      managedOAuth: false,
    });

    await api.prompt({ agentId: 'main', input: [{ type: 'text', text: '帮我看个 Go 报错' }] });
    if (agent.turn.hasActiveTurn) {
      await agent.turn.waitForCurrentTurn();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(chatTitleCalls(fetchMock)).toHaveLength(0);
    expect(session.metadata.title).toBe('帮我看个 Go 报错');
  });
});

function chatTitleCalls(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit?][] {
  return (fetchMock.mock.calls as unknown as [string, RequestInit?][]).filter(([url]) =>
    String(url).includes('/tools'),
  );
}

function stubChatTitleFetch(title: string) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ title }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met before timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function setupAutoTitleSession(options: { autoTitle: boolean; managedOAuth?: boolean }) {
  const sessionDir = await makeTempDir();
  const events: Array<Record<string, unknown>> = [];
  const scripted = createScriptedGenerate();
  const flags = new FlagResolver({});
  flags.setConfigOverrides({ 'auto-title': options.autoTitle });
  const managed =
    options.managedOAuth === false
      ? { type: 'kimi', apiKey: 'sk-test' }
      : MANAGED_PROVIDER;
  const session = track(
    new Session({
      id: 'auto-title',
      kaos: testKaos.withCwd(sessionDir),
      homedir: sessionDir,
      rpc: createSessionRpc(events),
      skills: { explicitDirs: [join(sessionDir, 'missing-skills')] },
      providerManager: new ProviderManager({
        config: {
          providers: {
            test: { type: MOCK_PROVIDER.type, apiKey: MOCK_PROVIDER.apiKey },
            'managed:kimi-code': managed,
          },
          models: {
            [MOCK_PROVIDER.model]: {
              provider: 'test',
              model: MOCK_PROVIDER.model,
              maxContextSize: 1_000_000,
            },
          },
        },
        resolveOAuthTokenProvider: () => ({ getAccessToken: async () => 'test-token' }),
      }),
      experimentalFlags: flags,
    }),
  );
  const { agent } = await session.createAgent(
    { type: 'main', generate: scripted.generate },
    { profile: testProfile() },
  );
  agent.config.update({ modelAlias: MOCK_PROVIDER.model, thinkingEffort: 'off' });
  agent.permission.setMode('yolo');
  const api = new SessionAPIImpl(session);
  return { api, session, events, agent };
}

const tempDirs: string[] = [];
const openSessions: Session[] = [];

function track(session: Session): Session {
  openSessions.push(session);
  return session;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  // Close sessions first so their async metadata/wire writes settle before the
  // temp dirs are removed (otherwise rm races with a write -> ENOTEMPTY).
  await Promise.allSettled(openSessions.splice(0).map((s) => s.close()));
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-prompt-metadata-'));
  tempDirs.push(dir);
  return dir;
}

function testProviderManager(): ProviderManager {
  return new ProviderManager({
    config: {
      providers: {
        test: { type: MOCK_PROVIDER.type, apiKey: MOCK_PROVIDER.apiKey },
      },
      models: {
        [MOCK_PROVIDER.model]: {
          provider: 'test',
          model: MOCK_PROVIDER.model,
          maxContextSize: 1_000_000,
        },
      },
    },
  });
}

function testProfile(): ResolvedAgentProfile {
  return {
    name: 'test',
    systemPrompt: () => '<system-prompt>',
    tools: [],
  };
}

function createSessionRpc(events: Array<Record<string, unknown>>): SDKSessionRPC {
  return {
    emitEvent: vi.fn(async (event) => {
      events.push(event);
    }),
    requestApproval: vi.fn(async () => ({ decision: 'cancelled' })),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({
      output: 'custom tools are not supported in this test',
      isError: true,
    })),
  } as unknown as SDKSessionRPC;
}
