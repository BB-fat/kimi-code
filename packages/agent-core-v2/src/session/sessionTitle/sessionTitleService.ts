/**
 * `sessionTitle` domain (L6) — `ISessionTitleService` implementation.
 *
 * Generates the session's title from the first active prompts projected by
 * the main Agent's authoritative conversation journal through the managed
 * platform `/tools` `chat_title` endpoint, persists it through
 * `sessionMetadata`, and rebroadcasts `session.meta.updated`.
 * Generation is on demand only: `generateTitle()` is the single entry point
 * (the kap-server route), gated by the `auto-title` experimental flag and a
 * managed Kimi Code OAuth login; any failure degrades to keeping the current
 * title, and a custom title set by the user is never overwritten. Provider
 * config comes from `provider`, the bearer token from `auth`, host identity
 * headers from `model`, gating from `flag`, prompt history from
 * `agentLifecycle`/`sessionTitle`, and logs through `log`. Bound at Session
 * scope.
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
import { IFlagService } from '#/app/flag/flag';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { IHostRequestHeaders } from '#/kosong/model/hostRequestHeaders';
import { IProviderService } from '#/kosong/provider/provider';
import { isOAuthCatalogVendor } from '#/kosong/provider/providerDefinition';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import { IAgentTitlePromptSource } from './agentTitlePromptSource';
import { AUTO_TITLE_FLAG_ID } from './flag';
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
    @IFlagService private readonly flags: IFlagService,
    @IProviderService private readonly providers: IProviderService,
    @IOAuthService private readonly oauth: IOAuthService,
    @IHostRequestHeaders private readonly hostHeaders: IHostRequestHeaders,
    @ILogService private readonly log: ILogService,
  ) {}

  async generateTitle(): Promise<string | undefined> {
    if (!this.flags.enabled(AUTO_TITLE_FLAG_ID)) return undefined;
    const current = await this.metadata.read();
    if (hasCustomTitle(current)) return undefined;
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
    if (hasCustomTitle(current)) return undefined;
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
    const result = await fetchChatTitle(
      kimiCodeToolsUrl(runtimeAuth.baseUrl),
      token,
      chatContent,
      {
        headers: {
          ...parseKimiCodeCustomHeaders(),
          ...this.hostHeaders.headers,
          ...provider.customHeaders,
        },
      },
    );
    if (result.kind !== 'ok') {
      this.log.debug(`chat_title request failed: ${result.message}`);
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

function hasCustomTitle(metadata: {
  readonly title?: unknown;
  readonly isCustomTitle?: unknown;
  readonly customTitle?: unknown;
}): boolean {
  if (typeof metadata.title === 'string' && typeof metadata.isCustomTitle === 'boolean') {
    return metadata.isCustomTitle;
  }
  return metadata.isCustomTitle === true || typeof metadata.customTitle === 'string';
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
