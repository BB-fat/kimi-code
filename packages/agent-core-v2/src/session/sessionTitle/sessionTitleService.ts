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
 * regenerated unless forced, and the write-back is dropped when this scope
 * is no longer the live session in `sessionLifecycle`. Provider config comes
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
import { ISessionLifecycleService } from '#/app/sessionLifecycle/sessionLifecycle';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { IHostRequestHeaders } from '#/kosong/model/hostRequestHeaders';
import { IProviderService } from '#/kosong/provider/provider';
import { isOAuthCatalogVendor } from '#/kosong/provider/providerDefinition';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import { IAgentTitlePromptSource } from './agentTitlePromptSource';
import { ISessionTitleService } from './sessionTitle';

const MAX_GENERATED_TITLE_LENGTH = 200;

const MAX_TITLE_INPUT_LENGTH = 1000;

const MAX_TITLE_PROMPTS = 3;

export class SessionTitleService implements ISessionTitleService {
  declare readonly _serviceBrand: undefined;

  private _generation: Promise<string | undefined> | undefined;

  constructor(
    @ISessionContext private readonly ctx: ISessionContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @IEventService private readonly eventService: IEventService,
    @ISessionLifecycleService private readonly sessionLifecycle: ISessionLifecycleService,
    @IProviderService private readonly providers: IProviderService,
    @IOAuthService private readonly oauth: IOAuthService,
    @IHostRequestHeaders private readonly hostHeaders: IHostRequestHeaders,
    @ILogService private readonly log: ILogService,
  ) {}

  async generateTitle(options?: { readonly force?: boolean }): Promise<string | undefined> {
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
    const inFlight = this._generation;
    if (inFlight !== undefined) return inFlight;
    const settled = this.generateAndApplyOnce(chatContent).finally(() => {
      if (this._generation === settled) this._generation = undefined;
    });
    this._generation = settled;
    return settled;
  }

  private async generateAndApplyOnce(chatContent: string): Promise<string | undefined> {
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
      });
    let result = await requestTitle(token);
    if (result.kind === 'error' && result.status === 401) {
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
    const live = this.sessionLifecycle.get(this.ctx.sessionId);
    if (live === undefined || live.accessor.get(ISessionMetadata) !== this.metadata) {
      return undefined;
    }
    const title = result.title.slice(0, MAX_GENERATED_TITLE_LENGTH);
    const applied = await this.metadata.setGeneratedTitleIfUncustomized(title);
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
