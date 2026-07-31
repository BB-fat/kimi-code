/**
 * `sessionLifetime` domain (L1) — per-session liveness seed.
 *
 * Defines the `ISessionLifetime` carrying the session scope's liveness
 * `AbortSignal`: the Workspace-scope `workspaceHandler` creates one
 * `AbortController` per materialized session, seeds the signal into the
 * Session scope, and aborts it synchronously when the session's close
 * begins — before any async `onWillCloseSession` hook runs. Session-scope
 * consumers with in-flight async work (e.g. `sessionTitle`) treat an
 * aborted signal as "this scope is being torn down": cancel the work and
 * drop its write-back. Pure contract — no IO, no store. Session-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';

export interface ISessionLifetime {
  readonly _serviceBrand: undefined;

  readonly signal: AbortSignal;
}

export const ISessionLifetime: ServiceIdentifier<ISessionLifetime> =
  createDecorator<ISessionLifetime>('sessionLifetime');

export function sessionLifetimeSeed(lifetime: ISessionLifetime): ScopeSeed {
  return [[ISessionLifetime as ServiceIdentifier<unknown>, lifetime]];
}
