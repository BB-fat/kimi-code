/**
 * `sessionTitle` domain (L6) — `ISessionTitleService` implementation.
 *
 * Watches the global `event` bus for the session's own easy-title moment (a
 * `session.meta.updated` whose patch sets a non-custom title, published by
 * the `rpc` prompt-metadata flow on the first prompt) and, when the
 * `auto-title` experimental flag is on and the managed Kimi Code provider
 * carries an OAuth ref, generates a real title from the already-sanitized
 * `lastPrompt` through the platform `/tools` `chat_title` endpoint, persists
 * it through `sessionMetadata`, and rebroadcasts `session.meta.updated`.
 * Provider config comes from `provider`, the bearer token from `auth`, host
 * identity headers from `model`, gating from `flag`, and logs through `log`.
 * The public `generateTitle()` is the manual entry point (server route); any
 * failure degrades to keeping the current title, and a custom title set by
 * the user is never overwritten. Bound at Session scope.
 */

import {
  KIMI_CODE_PROVIDER_NAME,
  fetchChatTitle,
  kimiCodeToolsUrl,
} from '@moonshot-ai/kimi-code-oauth';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IOAuthService } from '#/app/auth/auth';
import { IEventService, type DomainEvent } from '#/app/event/event';
import { IFlagService } from '#/app/flag/flag';
import { IHostRequestHeaders } from '#/kosong/model/hostRequestHeaders';
import { IProviderService } from '#/kosong/provider/provider';
import { isOAuthCatalogVendor } from '#/kosong/provider/providerDefinition';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import { AUTO_TITLE_FLAG_ID } from './flag';
import { ISessionTitleService } from './sessionTitle';

const MAX_GENERATED_TITLE_LENGTH = 200;

export class SessionTitleService extends Disposable implements ISessionTitleService {
  declare readonly _serviceBrand: undefined;

  private _autoAttempted = false;

  constructor(
    @ISessionContext private readonly ctx: ISessionContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IEventService private readonly eventService: IEventService,
    @IFlagService private readonly flags: IFlagService,
    @IProviderService private readonly providers: IProviderService,
    @IOAuthService private readonly oauth: IOAuthService,
    @IHostRequestHeaders private readonly hostHeaders: IHostRequestHeaders,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this._register(this.eventService.subscribe((event) => this.onMetaUpdated(event)));
  }

  async generateTitle(): Promise<string | undefined> {
    if (!this.flags.enabled(AUTO_TITLE_FLAG_ID)) return undefined;
    const current = await this.metadata.read();
    if (current.lastPrompt === undefined) return undefined;
    return this.generateAndApply(current.lastPrompt);
  }

  private onMetaUpdated(event: DomainEvent): void {
    if (event.type !== 'session.meta.updated' || this._autoAttempted) return;
    const lastPrompt = readEasyTitleLastPrompt(event.payload, this.ctx.sessionId);
    if (lastPrompt === undefined) return;
    if (!this.flags.enabled(AUTO_TITLE_FLAG_ID)) return;
    this._autoAttempted = true;
    void this.generateAndApply(lastPrompt).catch((error: unknown) => {
      this.log.warn(
        `auto session title failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private async generateAndApply(chatContent: string): Promise<string | undefined> {
    const provider = this.providers.get(KIMI_CODE_PROVIDER_NAME);
    if (
      provider === undefined ||
      !isOAuthCatalogVendor(provider.type) ||
      provider.oauth === undefined
    ) {
      return undefined;
    }
    const tokenProvider = this.oauth.resolveTokenProvider(KIMI_CODE_PROVIDER_NAME, provider.oauth);
    if (tokenProvider === undefined) return undefined;
    const token = await tokenProvider.getAccessToken();
    const result = await fetchChatTitle(
      kimiCodeToolsUrl(provider.baseUrl),
      token,
      `user: ${chatContent}`,
      { headers: { ...this.hostHeaders.headers, ...provider.customHeaders } },
    );
    if (result.kind !== 'ok') {
      this.log.debug(`chat_title request failed: ${result.message}`);
      return undefined;
    }
    // The user may have renamed the session while the request was in flight.
    const current = await this.metadata.read();
    if (current.isCustomTitle === true) return undefined;
    const title = result.title.slice(0, MAX_GENERATED_TITLE_LENGTH);
    await this.metadata.update({ title, isCustomTitle: false });
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

function readEasyTitleLastPrompt(payload: unknown, sessionId: string): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  if (record['sessionId'] !== sessionId) return undefined;
  const patch = record['patch'];
  if (typeof patch !== 'object' || patch === null) return undefined;
  const patchRecord = patch as Record<string, unknown>;
  if (patchRecord['isCustomTitle'] !== false || typeof patchRecord['title'] !== 'string') {
    return undefined;
  }
  const lastPrompt = patchRecord['lastPrompt'];
  return typeof lastPrompt === 'string' && lastPrompt.length > 0 ? lastPrompt : undefined;
}

registerScopedService(
  LifecycleScope.Session,
  ISessionTitleService,
  SessionTitleService,
  ScopeActivation.OnScopeCreated,
  'sessionTitle',
);
