/**
 * `sessionTitle` domain (L6) — `ISessionTitleService` implementation.
 *
 * Generates the session's title from the first active prompts in the main
 * Agent's live conversation context through the managed platform `/tools`
 * `chat_title` endpoint, persists it through
 * `sessionMetadata`, and rebroadcasts `session.meta.updated`.
 * Generation is on demand only: `generateTitle()` is the single entry point
 * (the kap-server route), gated by a managed Kimi Code OAuth login; any
 * failure degrades to keeping the current title, and a custom title set by
 * the user is never overwritten. An already-generated title is not
 * regenerated unless forced. Plain calls coalesce onto one shared
 * in-flight generation while a forced regeneration always runs on its
 * own; every active generation is drained through the
 * `sessionLifecycleHooks` `onWillCloseSession` slot before the scope is
 * disposed, and the write-back is dropped once
 * this scope's `sessionLifetime` signal fires — the in-flight request
 * carries the signal, and the metadata update re-checks it inside the
 * serialized write so an abort landing while the update sits queued still
 * vetoes the write. Provider config comes
 * from `provider`, the bearer token from `auth`, host identity headers from
 * `model`, prompt history from `agentLifecycle`/`sessionTitle`, and logs
 * through `log`. Bound at Session scope.
 */

import {
  KIMI_CODE_PROVIDER_NAME,
  OAuthError,
  fetchChatTitle,
  kimiCodeToolsUrl,
  parseKimiCodeCustomHeaders,
  resolveKimiCodeRuntimeAuth,
} from '@moonshot-ai/kimi-code-oauth';

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IOAuthService } from '#/app/auth/auth';
import { IEventService } from '#/app/event/event';
import type { Hooks } from '#/hooks';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { IHostRequestHeaders } from '#/kosong/model/hostRequestHeaders';
import { IProviderService } from '#/kosong/provider/provider';
import { isOAuthCatalogVendor } from '#/kosong/provider/providerDefinition';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import {
  ISessionLifecycleHooks,
  type SessionLifecycleHookSlots,
} from '#/session/sessionLifecycleHooks/sessionLifecycleHooks';
import { ISessionLifetime } from '#/session/sessionLifetime/sessionLifetime';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import { IAgentTitlePromptSource } from './agentTitlePromptSource';
import { ISessionTitleService } from './sessionTitle';

const MAX_GENERATED_TITLE_LENGTH = 200;

const MAX_TITLE_INPUT_LENGTH = 1000;

const MAX_TITLE_PROMPTS = 3;

export class SessionTitleService implements ISessionTitleService {
  declare readonly _serviceBrand: undefined;

  private _shared: Promise<string | undefined> | undefined;
  private readonly _active = new Set<Promise<string | undefined>>();

  constructor(
    @ISessionContext private readonly ctx: ISessionContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @ISessionLifetime private readonly lifetime: ISessionLifetime,
    @ISessionLifecycleHooks
    lifecycleHooks: Hooks<SessionLifecycleHookSlots>,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @IEventService private readonly eventService: IEventService,
    @IProviderService private readonly providers: IProviderService,
    @IOAuthService private readonly oauth: IOAuthService,
    @IHostRequestHeaders private readonly hostHeaders: IHostRequestHeaders,
    @ILogService private readonly log: ILogService,
  ) {
    lifecycleHooks.onWillCloseSession.register('sessionTitle', async (_event, next) => {
      await Promise.allSettled([...this._active]);
      await next();
    });
  }

  async generateTitle(options?: { readonly force?: boolean }): Promise<string | undefined> {
    if (this.lifetime.signal.aborted) return undefined;
    // Plain calls coalesce onto the shared in-flight slot; a forced
    // regeneration always runs on its own so it is neither swallowed by a
    // plain call's early exit nor shares its result with one.
    if (options?.force !== true && this._shared !== undefined) return this._shared;
    const tracked = this.generateTitleOnce(options).finally(() => {
      this._active.delete(tracked);
      if (this._shared === tracked) this._shared = undefined;
    });
    this._active.add(tracked);
    if (options?.force !== true) this._shared = tracked;
    return tracked;
  }

  private async generateTitleOnce(options?: {
    readonly force?: boolean;
  }): Promise<string | undefined> {
    const current = await this.metadata.read();
    if (current.titleKind === 'custom') return undefined;
    if (current.titleKind === 'generated' && options?.force !== true) return undefined;
    const main = this.agentLifecycle.get(MAIN_AGENT_ID);
    const prompts =
      main === undefined
        ? []
        : await main.accessor.get(IAgentTitlePromptSource).firstUserPrompts(MAX_TITLE_PROMPTS);
    const input = titleInputFromPrompts(prompts);
    if (input === undefined) return undefined;
    return this.generateAndApply(input);
  }

  private async generateAndApply(chatContent: string): Promise<string | undefined> {
    const current = await this.metadata.read();
    if (current.titleKind === 'custom') return undefined;
    const provider = this.providers.get(KIMI_CODE_PROVIDER_NAME);
    if (
      provider === undefined ||
      !isOAuthCatalogVendor(provider.type) ||
      provider.oauth === undefined
    ) {
      return undefined;
    }
    const runtimeAuth = resolveKimiCodeRuntimeAuth({
      configuredBaseUrl: provider.baseUrl,
      configuredOAuthRef: provider.oauth,
    });
    const tokenProvider = this.oauth.resolveTokenProvider(
      KIMI_CODE_PROVIDER_NAME,
      runtimeAuth.oauthRef,
    );
    if (tokenProvider === undefined) return undefined;
    let token: string;
    try {
      token = await tokenProvider.getAccessToken();
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
      this.log.debug(`chat_title request unavailable: ${error.message}`);
      return undefined;
    }
    const requestTitle = (accessToken: string) =>
      fetchChatTitle(kimiCodeToolsUrl(runtimeAuth.baseUrl), accessToken, chatContent, {
        headers: {
          ...parseKimiCodeCustomHeaders(),
          ...this.hostHeaders.headers,
          ...provider.customHeaders,
        },
        signal: this.lifetime.signal,
      });
    let result = await requestTitle(token);
    if (result.kind === 'error' && result.status === 401 && !this.lifetime.signal.aborted) {
      try {
        token = await tokenProvider.getAccessToken({ force: true });
      } catch (error) {
        if (!(error instanceof OAuthError)) throw error;
        this.log.debug(`chat_title request unavailable: ${error.message}`);
        return undefined;
      }
      result = await requestTitle(token);
    }
    if (result.kind !== 'ok') {
      this.log.debug(`chat_title request failed: ${result.message}`);
      return undefined;
    }
    if (this.lifetime.signal.aborted) return undefined;
    const title = result.title.slice(0, MAX_GENERATED_TITLE_LENGTH);
    const applied = await this.metadata.setGeneratedTitleIfUncustomized(
      title,
      () => !this.lifetime.signal.aborted,
    );
    if (!applied) return undefined;
    this.eventService.publish({
      type: 'session.meta.updated',
      payload: {
        agentId: 'main',
        sessionId: this.ctx.sessionId,
        title,
        patch: { title, isCustomTitle: false },
      },
    });
    return title;
  }
}

function titleInputFromPrompts(prompts: readonly string[]): string | undefined {
  if (prompts.length === 0) return undefined;
  return prompts
    .map((prompt, index) => `user ${index + 1}: ${prompt}`)
    .join('\n')
    .slice(0, MAX_TITLE_INPUT_LENGTH);
}

registerScopedService(
  LifecycleScope.Session,
  ISessionTitleService,
  SessionTitleService,
  ScopeActivation.OnScopeCreated,
  'sessionTitle',
);
