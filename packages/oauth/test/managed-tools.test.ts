/**
 * Scenario: the managed `/tools` chat_title request contract, including
 * response validation, API failures, timeouts, and transport errors.
 * Wiring: the real request builder with only the external fetch boundary
 * stubbed. Run with:
 * `pnpm exec vitest run packages/oauth/test/managed-tools.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchChatTitle, kimiCodeToolsUrl } from '../src/managed-tools';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('kimiCodeToolsUrl', () => {
  it('appends /tools to the default base URL', () => {
    expect(kimiCodeToolsUrl()).toBe('https://api.kimi.com/coding/v1/tools');
  });

  it('honours KIMI_CODE_BASE_URL and trims trailing slashes', () => {
    vi.stubEnv('KIMI_CODE_BASE_URL', 'https://example.test/v9///');
    expect(kimiCodeToolsUrl()).toBe('https://example.test/v9/tools');
  });
});

describe('fetchChatTitle', () => {
  it('POSTs the chat_title method with bearer auth and returns the title on 200', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ title: 'Go nil pointer 错误排查' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchChatTitle(
      'https://api.example/tools',
      'access-token',
      'user: nil pointer 报错',
    );

    expect(result).toEqual({ kind: 'ok', title: 'Go nil pointer 错误排查' });

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit?][];
    const [calledUrl, init] = calls[0]!;
    expect(calledUrl).toBe('https://api.example/tools');
    expect(init?.method).toBe('POST');

    const headers = new Headers((init?.headers ?? {}) as Record<string, string>);
    expect(headers.get('authorization')).toBe('Bearer access-token');
    expect(headers.get('content-type')).toBe('application/json');

    expect(JSON.parse(init?.body as string)).toEqual({
      method: 'chat_title',
      params: { chat_content: 'user: nil pointer 报错' },
    });
  });

  it('keeps protocol headers authoritative when custom headers collide', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ title: '标题' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchChatTitle('https://api.example/tools', 'access-token', 'user: hi', {
      headers: {
        Authorization: 'Bearer wrong-token',
        Accept: 'text/plain',
        'Content-Type': 'text/plain',
        'X-Proxy-Header': 'present',
      },
    });

    const [, init] = (fetchMock.mock.calls as unknown as [string, RequestInit?][])[0]!;
    const headers = new Headers(init?.headers as Record<string, string>);
    expect(headers.get('authorization')).toBe('Bearer access-token');
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-proxy-header')).toBe('present');
  });

  it('trims surrounding whitespace from the title', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ title: '  标题  \n' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    const result = await fetchChatTitle('https://api.example/tools', 'tok', 'user: hi');

    expect(result).toEqual({ kind: 'ok', title: '标题' });
  });

  it('returns an error when the server omits the title', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    const result = await fetchChatTitle('https://api.example/tools', 'tok', 'user: hi');

    expect(result).toEqual({
      kind: 'error',
      message: 'Failed to generate session title: missing title.',
    });
  });

  it('returns an error with status when the server responds 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401 })),
    );

    const result = await fetchChatTitle('https://api.example/tools', 'tok', 'user: hi');

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.status).toBe(401);
    expect(result.message).toMatch(/401/);
  });

  it('surfaces API error messages from failed generations', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'title rejected' } }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    const result = await fetchChatTitle('https://api.example/tools', 'tok', 'user: hi');

    expect(result).toEqual({ kind: 'error', status: 400, message: 'title rejected' });
  });

  it('returns a timeout error when the request aborts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      ),
    );

    const result = await fetchChatTitle('https://api.example/tools', 'tok', 'user: hi', {
      timeoutMs: 5,
    });

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.status).toBeUndefined();
    expect(result.message).toMatch(/timed out/);
  });

  it('returns a generic error message on network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );

    const result = await fetchChatTitle('https://api.example/tools', 'tok', 'user: hi');

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toMatch(/network down/);
  });
});
