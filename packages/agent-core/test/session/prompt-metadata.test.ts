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
 *   - auto-title sends the effective managed endpoint, credentials, and
 *     env < host < provider request-header layers
 *
 * Wiring: real Session / ProviderManager with scripted model output; only the
 * external fetch boundary is stubbed. Run with:
 * `pnpm exec vitest run packages/agent-core/test/session/prompt-metadata.test.ts`.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import type { ProviderConfig } from '@moonshot-ai/kosong';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OAuthRef, ProviderConfig as ConfigProviderConfig } from '../../src/config';
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
  customHeaders: { 'X-Msh-Platform': 'provider-platform' },
} as const satisfies ConfigProviderConfig;

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

  it('trusts modern non-custom title state over a stale legacy customTitle', async () => {
    stubChatTitleFetch('生成的标题');
    const { api, session, events, agent } = await setupAutoTitleSession({
      autoTitle: true,
    });
    session.metadata = {
      ...session.metadata,
      title: 'New Session',
      isCustomTitle: false,
      customTitle: 'stale legacy title',
    } as typeof session.metadata;

    await api.prompt({ agentId: 'main', input: [{ type: 'text', text: '帮我看个 Go 报错' }] });
    if (agent.turn.hasActiveTurn) {
      await agent.turn.waitForCurrentTurn();
    }

    await waitFor(() =>
      events.some((event) =>
        event['type'] === 'session.meta.updated' && event['title'] === '生成的标题'
      ),
    );
    expect(session.metadata.title).toBe('生成的标题');
  });

  it('sends managed request headers with the established layer precedence', async () => {
    vi.stubEnv(
      'KIMI_CODE_CUSTOM_HEADERS',
      'User-Agent: env-client\nX-Msh-Platform: env-platform\nX-Environment: present',
    );
    const fetchMock = stubChatTitleFetch('生成的标题');
    const { api, events, agent } = await setupAutoTitleSession({ autoTitle: true });

    await api.prompt({ agentId: 'main', input: [{ type: 'text', text: '帮我看个 Go 报错' }] });
    if (agent.turn.hasActiveTurn) {
      await agent.turn.waitForCurrentTurn();
    }
    await waitFor(() =>
      events.some((e) => e['type'] === 'session.meta.updated' && e['title'] === '生成的标题'),
    );

    const [, init] = chatTitleCalls(fetchMock)[0]!;
    const headers = new Headers(init?.headers as Record<string, string>);
    expect(headers.get('user-agent')).toBe('kimi-code-cli/test');
    expect(headers.get('x-msh-device-id')).toBe('device-test');
    expect(headers.get('x-msh-platform')).toBe('provider-platform');
    expect(headers.get('x-environment')).toBe('present');
  });

  it('keeps the easy title when the flag is off', async () => {
    const fetchMock = stubChatTitleFetch('生成的标题');
    const { api, session, agent } = await setupAutoTitleSession({ autoTitle: false });

    await api.prompt({ agentId: 'main', input: [{ type: 'text', text: '帮我看个 Go 报错' }] });
    if (agent.turn.hasActiveTurn) {
      await agent.turn.waitForCurrentTurn();
    }

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

    expect(chatTitleCalls(fetchMock)).toHaveLength(0);
    expect(session.metadata.title).toBe('帮我看个 Go 报错');
  });

  it('pairs the environment endpoint with its credential slot when it overrides persisted config', async () => {
    vi.stubEnv('KIMI_CODE_BASE_URL', 'https://api.env.example.test/coding/v1');
    vi.stubEnv('KIMI_CODE_OAUTH_HOST', 'https://auth.env.example.test');
    const fetchMock = stubChatTitleFetch('生成的标题');
    const { api, events, agent, resolvedOAuthRefs } = await setupAutoTitleSession({
      autoTitle: true,
    });

    await api.prompt({ agentId: 'main', input: [{ type: 'text', text: '帮我看个 Go 报错' }] });
    if (agent.turn.hasActiveTurn) {
      await agent.turn.waitForCurrentTurn();
    }
    await waitFor(() =>
      events.some((e) => e['type'] === 'session.meta.updated' && e['title'] === '生成的标题'),
    );

    expect(chatTitleCalls(fetchMock)[0]?.[0]).toBe(
      'https://api.env.example.test/coding/v1/tools',
    );
    expect(resolvedOAuthRefs[0]).toMatchObject({
      storage: 'file',
      oauthHost: 'https://auth.env.example.test',
    });
    expect(resolvedOAuthRefs[0]?.key).not.toBe(MANAGED_PROVIDER.oauth.key);
  });
});

function chatTitleCalls(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit?][] {
  return (fetchMock.mock.calls as unknown as [string, RequestInit?][]).filter(([url]) =>
    url.includes('/tools'),
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
  const resolvedOAuthRefs: Array<OAuthRef | undefined> = [];
  flags.setConfigOverrides({ 'auto-title': options.autoTitle });
  const managed: ConfigProviderConfig =
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
        kimiRequestHeaders: {
          'User-Agent': 'kimi-code-cli/test',
          'X-Msh-Platform': 'host-platform',
          'X-Msh-Device-Id': 'device-test',
        },
        resolveOAuthTokenProvider: (_providerName, oauthRef) => {
          resolvedOAuthRefs.push(oauthRef);
          return { getAccessToken: async () => 'test-token' };
        },
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
  return { api, session, events, agent, resolvedOAuthRefs };
}

const tempDirs: string[] = [];
const openSessions: Session[] = [];

function track(session: Session): Session {
  openSessions.push(session);
  return session;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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
