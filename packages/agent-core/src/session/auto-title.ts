import {
  KIMI_CODE_PROVIDER_NAME,
  fetchChatTitle,
  kimiCodeToolsUrl,
  resolveKimiCodeRuntimeAuth,
} from '@moonshot-ai/kimi-code-oauth';

import type { Logger } from '#/logging/types';

import type { ProviderManager } from './provider-manager';

const MAX_GENERATED_TITLE_LENGTH = 200;

/**
 * Generate a session title through the managed platform `/tools` `chat_title`
 * endpoint, from the session's (already sanitized) first prompt. Returns
 * `undefined` when the managed provider is not OAuth-backed or the request
 * fails — callers keep the easy title in that case.
 */
export async function generateSessionTitle(
  chatContent: string,
  providerManager: ProviderManager | undefined,
  log?: Logger,
): Promise<string | undefined> {
  if (providerManager === undefined) return undefined;
  const provider = providerManager.getProviderConfig(KIMI_CODE_PROVIDER_NAME);
  if (provider?.oauth === undefined) return undefined;
  const runtimeAuth = resolveKimiCodeRuntimeAuth({
    configuredBaseUrl: provider.baseUrl,
    configuredOAuthRef: provider.oauth,
  });
  const tokenProvider = providerManager.resolveOAuthTokenProvider(
    KIMI_CODE_PROVIDER_NAME,
    runtimeAuth.oauthRef,
  );
  if (tokenProvider === undefined) return undefined;
  const result = await fetchChatTitle(
    kimiCodeToolsUrl(runtimeAuth.baseUrl),
    await tokenProvider.getAccessToken(),
    `user: ${chatContent}`,
    { headers: providerManager.resolveManagedRequestHeaders(KIMI_CODE_PROVIDER_NAME) },
  );
  if (result.kind !== 'ok') {
    log?.debug('chat_title request failed', { message: result.message });
    return undefined;
  }
  return result.title.slice(0, MAX_GENERATED_TITLE_LENGTH);
}
