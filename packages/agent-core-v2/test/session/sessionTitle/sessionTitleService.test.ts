/**
 * Scenario: on-demand managed chat_title generation through the session-scoped
 * service, including OAuth failures, legacy custom titles, request headers,
 * and races.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { OAuthConnectionError, OAuthUnauthorizedError } from '@moonshot-ai/kimi-code-oauth';

import { DisposableStore, type IDisposable } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { IOAuthService } from '#/app/auth/auth';
import { type DomainEvent, IEventService } from '#/app/event/event';
import { IFlagService } from '#/app/flag/flag';
import { HostRequestHeaders, IHostRequestHeaders } from '#/kosong/model/hostRequestHeaders';
import {
  IProviderService,
  type OAuthRef,
  type ProviderConfig,
} from '#/kosong/provider/provider';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import {
  ISessionMetadata,
  type SessionMeta,
  type SessionMetaPatch,
  type SessionMetadataChangedEvent,
} from '#/session/sessionMetadata/sessionMetadata';
import { ISessionTitleService } from '#/session/sessionTitle/sessionTitle';
import { SessionTitleService } from '#/session/sessionTitle/sessionTitleService';
import '#/kosong/provider/providers/kimi/kimi.contrib';

import { registerLogServices } from '../../_base/log/stubs';
import { stubFlag } from '../../app/flag/stubs';
import { stubProviderService } from '../../app/provider/stubs';

const SESSION_ID = 'sess-1';
const MANAGED_PROVIDER: ProviderConfig = {
  type: 'kimi',
  baseUrl: 'https://api.example.test/coding/v1',
  oauth: { storage: 'file', key: 'kimi-code' },
};

class FakeEventService implements IEventService {
  declare readonly _serviceBrand: undefined;
  private readonly emitter = new Emitter<DomainEvent>();
  readonly onDidPublish = this.emitter.event;
  readonly published: DomainEvent[] = [];

  publish(event: DomainEvent): void {
    this.published.push(event);
    this.emitter.fire(event);
  }

  subscribe(handler: (event: DomainEvent) => void): IDisposable {
    return this.emitter.event(handler);
  }
}

class FakeSessionMetadata implements ISessionMetadata {
  declare readonly _serviceBrand: undefined;
  readonly ready = Promise.resolve();
  private readonly emitter = new Emitter<SessionMetadataChangedEvent>();
  readonly onDidChangeMetadata = this.emitter.event;
  meta: SessionMeta;

  constructor() {
    this.meta = {
      id: SESSION_ID,
      createdAt: 0,
      updatedAt: 0,
      archived: false,
    };
  }

  read(): Promise<SessionMeta> {
    return Promise.resolve(this.meta);
  }

  update(patch: SessionMetaPatch): Promise<void> {
    this.meta = { ...this.meta, ...patch };
    this.emitter.fire({ changed: Object.keys(patch) as (keyof SessionMeta)[] });
    return Promise.resolve();
  }

  setTitle(title: string): Promise<void> {
    return this.update({ title, isCustomTitle: true });
  }

  async setGeneratedTitleIfUncustomized(title: string): Promise<boolean> {
    if (this.meta.isCustomTitle === true) return false;
    await this.update({ title, isCustomTitle: false });
    return true;
  }

  setArchived(archived: boolean): Promise<void> {
    return this.update({ archived });
  }

  registerAgent(): Promise<void> {
    return Promise.resolve();
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met before timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('SessionTitleService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let events: FakeEventService;
  let metadata: FakeSessionMetadata;
  let flagEnabled: boolean;
  let providers: Record<string, ProviderConfig>;
  let fetchMock: Mock<(url: string, init?: RequestInit) => Promise<Response>>;
  let tokenError: Error | undefined;
  let resolvedOAuthRefs: Array<OAuthRef | undefined>;

  beforeEach(() => {
    flagEnabled = true;
    tokenError = undefined;
    resolvedOAuthRefs = [];
    providers = { 'managed:kimi-code': MANAGED_PROVIDER };
    metadata = new FakeSessionMetadata();
    events = new FakeEventService();
    fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(JSON.stringify({ title: '生成的标题' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [registerLogServices],
      additionalServices: (reg) => {
        reg.defineInstance(
          ISessionContext,
          makeSessionContext({
            sessionId: SESSION_ID,
            workspaceId: 'ws-1',
            sessionDir: '/tmp/sess-1',
            sessionScope: 'sessions/sess-1',
            cwd: '/tmp',
          }),
        );
        reg.defineInstance(ISessionMetadata, metadata);
        reg.defineInstance(IEventService, events);
        reg.defineInstance(
          IFlagService,
          stubFlag(() => flagEnabled),
        );
        reg.defineInstance(IProviderService, stubProviderService(providers));
        reg.definePartialInstance(IOAuthService, {
          resolveTokenProvider: (_provider, oauthRef) => {
            resolvedOAuthRefs.push(oauthRef);
            return {
              getAccessToken: async () => {
                if (tokenError !== undefined) throw tokenError;
                return 'test-token';
              },
            };
          },
        });
        reg.defineInstance(IHostRequestHeaders, new HostRequestHeaders({ 'User-Agent': 'test' }));
        reg.define(ISessionTitleService, SessionTitleService);
      },
    });
    ix.get(ISessionTitleService);
  });

  afterEach(() => {
    disposables.dispose();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('replaces the easy title with the generated one', async () => {
    await metadata.update({ prompts: ['帮我看一下这个 Go 的 nil pointer 报错'] });

    const title = await ix.get(ISessionTitleService).generateTitle();

    expect(title).toBe('生成的标题');
    expect(metadata.meta.title).toBe('生成的标题');
    expect(metadata.meta.isCustomTitle).toBe(false);

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({
      method: 'chat_title',
      params: { chat_content: 'user 1: 帮我看一下这个 Go 的 nil pointer 报错' },
    });
    expect(new Headers(init?.headers as Record<string, string>).get('authorization')).toBe(
      'Bearer test-token',
    );

    const rebroadcast = events.published.find(
      (event) =>
        event.type === 'session.meta.updated' &&
        (event.payload as { patch?: { title?: string } }).patch?.title === '生成的标题',
    );
    expect(rebroadcast).toBeDefined();
  });

  it('composes the title input from the recorded prompts in order', async () => {
    await metadata.update({
      prompts: ['先帮我搭一个 Vite 项目', '加上路由', '现在配一下 ESLint'],
    });

    await ix.get(ISessionTitleService).generateTitle();

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({
      method: 'chat_title',
      params: {
        chat_content: 'user 1: 先帮我搭一个 Vite 项目\nuser 2: 加上路由\nuser 3: 现在配一下 ESLint',
      },
    });
  });

  it('truncates the composed title input to the total budget, keeping the head', async () => {
    await metadata.update({ prompts: ['很长的输入'.repeat(400), '第二条'] });

    await ix.get(ISessionTitleService).generateTitle();

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init?.body as string) as { params: { chat_content: string } };
    expect(body.params.chat_content.startsWith('user 1: 很长的输入')).toBe(true);
    expect(body.params.chat_content).toHaveLength(1000);
  });

  it('falls back to lastPrompt for sessions without recorded prompts', async () => {
    await metadata.update({ lastPrompt: '帮我看一下这个 Go 的 nil pointer 报错' });

    await ix.get(ISessionTitleService).generateTitle();

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({
      method: 'chat_title',
      params: { chat_content: 'user 1: 帮我看一下这个 Go 的 nil pointer 报错' },
    });
  });

  it('does nothing without a managed OAuth provider', async () => {
    delete providers['managed:kimi-code'];
    await metadata.update({ lastPrompt: 'hello' });

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never overwrites a custom title set while generation is in flight', async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    fetchMock.mockImplementationOnce(
      async () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    await metadata.update({ lastPrompt: 'hello' });
    const generation = ix.get(ISessionTitleService).generateTitle();
    await waitFor(() => fetchMock.mock.calls.length === 1);
    await metadata.setTitle('user 取的标题');
    resolveFetch?.(
      new Response(JSON.stringify({ title: '生成的标题' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(generation).resolves.toBeUndefined();
    expect(metadata.meta.title).toBe('user 取的标题');
    expect(metadata.meta.isCustomTitle).toBe(true);
  });

  it('keeps the current title when the backend request fails', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('', { status: 500 }));
    await metadata.update({ title: 'hello', isCustomTitle: false, lastPrompt: 'hello' });

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    expect(metadata.meta.title).toBe('hello');
  });

  it('returns unavailable when the OAuth token is missing or revoked', async () => {
    tokenError = new OAuthUnauthorizedError('re-login required');
    await metadata.update({ lastPrompt: 'hello' });

    const svc = ix.get(ISessionTitleService);
    await expect(svc.generateTitle()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns unavailable when OAuth token retrieval has an operational failure', async () => {
    tokenError = new OAuthConnectionError('connection failed');
    await metadata.update({ lastPrompt: 'hello' });

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates unexpected token provider failures', async () => {
    tokenError = new Error('unexpected failure');
    await metadata.update({ lastPrompt: 'hello' });

    await expect(ix.get(ISessionTitleService).generateTitle()).rejects.toThrow(
      'unexpected failure',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('includes environment custom headers', async () => {
    vi.stubEnv('KIMI_CODE_CUSTOM_HEADERS', 'X-Proxy-Header: from-env\n');
    await metadata.update({ lastPrompt: 'hello' });

    await ix.get(ISessionTitleService).generateTitle();

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init?.headers as Record<string, string>);
    expect(headers.get('x-proxy-header')).toBe('from-env');
    expect(headers.get('user-agent')).toBe('test');
  });

  it('pairs the environment endpoint with its credential slot when it overrides persisted config', async () => {
    vi.stubEnv('KIMI_CODE_BASE_URL', 'https://api.env.example.test/coding/v1');
    vi.stubEnv('KIMI_CODE_OAUTH_HOST', 'https://auth.env.example.test');
    await metadata.update({ lastPrompt: 'hello' });

    await ix.get(ISessionTitleService).generateTitle();

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.env.example.test/coding/v1/tools');
    expect(resolvedOAuthRefs[0]).toMatchObject({
      storage: 'file',
      oauthHost: 'https://auth.env.example.test',
    });
    expect(resolvedOAuthRefs[0]?.key).not.toBe(MANAGED_PROVIDER.oauth?.key);
  });

  it('does not generate over a legacy customTitle', async () => {
    metadata.meta = {
      ...metadata.meta,
      lastPrompt: 'hello',
      customTitle: 'legacy title',
    } as SessionMeta;

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('trusts a modern non-custom title over a stale legacy customTitle', async () => {
    metadata.meta = {
      ...metadata.meta,
      title: 'easy title',
      isCustomTitle: false,
      lastPrompt: 'hello',
      customTitle: 'stale legacy title',
    } as SessionMeta;

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBe('生成的标题');
    expect(metadata.meta.title).toBe('生成的标题');
  });

  it('shares an in-flight generation between concurrent requests', async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    fetchMock.mockImplementationOnce(
      async () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    await metadata.update({ lastPrompt: 'hello' });
    const first = ix.get(ISessionTitleService).generateTitle();
    const second = ix.get(ISessionTitleService).generateTitle();
    await waitFor(() => fetchMock.mock.calls.length === 1);

    resolveFetch?.(
      new Response(JSON.stringify({ title: '生成的标题' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(first).resolves.toBe('生成的标题');
    await expect(second).resolves.toBe('生成的标题');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('generateTitle() returns undefined when the flag is off or no prompt was seen', async () => {
    const svc = ix.get(ISessionTitleService);

    flagEnabled = false;
    expect(await svc.generateTitle()).toBeUndefined();

    flagEnabled = true;
    expect(await svc.generateTitle()).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
