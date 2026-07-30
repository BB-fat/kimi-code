/**
 * `sessionTitle` domain (L6) — session title generation contract.
 *
 * Defines the Session-scoped `ISessionTitleService` that (re)generates a
 * session title from the main Agent's conversation history. A title that was
 * already generated is not regenerated unless `force` is set; a custom title
 * is never overwritten.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISessionTitleService {
  readonly _serviceBrand: undefined;

  generateTitle(options?: { readonly force?: boolean }): Promise<string | undefined>;
}

export const ISessionTitleService: ServiceIdentifier<ISessionTitleService> =
  createDecorator<ISessionTitleService>('sessionTitleService');
