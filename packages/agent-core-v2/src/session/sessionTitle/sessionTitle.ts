/**
 * `sessionTitle` domain (L6) — session title generation contract.
 *
 * Defines the `ISessionTitleService` that (re)generates the session's title
 * on demand from its first prompt through the managed platform's `chat_title`
 * tool. Bound at Session scope — one instance per session.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISessionTitleService {
  readonly _serviceBrand: undefined;

  generateTitle(): Promise<string | undefined>;
}

export const ISessionTitleService: ServiceIdentifier<ISessionTitleService> =
  createDecorator<ISessionTitleService>('sessionTitleService');
