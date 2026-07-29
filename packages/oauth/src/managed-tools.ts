/**
 * Managed-platform `/tools` dispatch: POSTs `{method, params}` to
 * `{kimiCodeBaseUrl}/tools` with a Bearer access token, the same wire
 * shape the backend tool surface expects (see `chat_title` below).
 *
 * `chat_title` generates a short session title from a chat excerpt:
 *
 *   { "method": "chat_title", "params": { "chat_content": "user: ...\nassistant: ..." } }
 *   → { "title": "..." }
 */

import { readApiErrorMessage } from './api-error';
import { kimiCodeBaseUrl } from './managed-usage';
import { isRecord } from './utils';

export interface FetchChatTitleOk {
  readonly kind: 'ok';
  readonly title: string;
}

export interface FetchChatTitleError {
  readonly kind: 'error';
  readonly status?: number;
  readonly message: string;
}

export type FetchChatTitleResult = FetchChatTitleOk | FetchChatTitleError;

export function kimiCodeToolsUrl(baseUrl?: string): string {
  return `${(baseUrl ?? kimiCodeBaseUrl()).replace(/\/+$/, '')}/tools`;
}

export async function fetchChatTitle(
  url: string,
  accessToken: string,
  chatContent: string,
  opts: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<FetchChatTitleResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, opts.timeoutMs ?? 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...opts.headers,
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        method: 'chat_title',
        params: { chat_content: chatContent },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        kind: 'error',
        status: res.status,
        message: await readApiErrorMessage(
          res,
          `Failed to generate session title: HTTP ${String(res.status)}`,
        ),
      };
    }
    const title = parseChatTitle(await res.json());
    if (title === undefined) {
      return { kind: 'error', message: 'Failed to generate session title: missing title.' };
    }
    return { kind: 'ok', title };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { kind: 'error', message: 'Failed to generate session title: request timed out.' };
    }
    const msg = error instanceof Error ? error.message : String(error);
    return { kind: 'error', message: `Failed to generate session title: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

function parseChatTitle(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const value = payload['title'];
  if (typeof value !== 'string') return undefined;
  const title = value.trim();
  return title.length > 0 ? title : undefined;
}
