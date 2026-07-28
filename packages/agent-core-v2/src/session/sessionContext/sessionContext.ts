/**
 * `sessionContext` domain (L6) — seeded per-session facts.
 *
 * Defines the `ISessionContext` carrying the session's identity (`sessionId`,
 * the internal `runtimeId`, the owning runtime's session-bucket id
 * `workspaceId`), the session's initial working directory (`cwd`), and a
 * `scope(subKey?)` helper that returns the session's persistence namespace
 * (or a child under it, e.g. `scope('agents/main/cron')`). Seeded into the
 * Session scope by the runtime-backed activation from the lease alone.
 *
 * `cwd` is the working directory frozen at session creation (sourced from the
 * lease's OS capability); it is the default root the `process` runner spawns
 * in and the seed `workspaceContext` derives its mutable `workDir` from. The
 * live, runtime-mutable "current cwd" (changed via `chdir`) is owned by
 * `profile` (Agent scope) and `workspaceContext`, not here. `workspaceId` is
 * an opaque bucket fact (the Local runtime's `wd_id`, `''` for headless
 * runtimes) sourced from the lease's typed host-files capability — v1
 * projections and the cron store addressing read it; it never routes anything
 * in Session Core. Physical host paths do NOT live here (plan §1.4/§7.2):
 * they arrive on the lease's `ISessionHostFiles` capability object instead
 * (`session/sessionHostFiles`). Pure facts — no store, no IO. Session-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';

export interface ISessionContext {
  readonly _serviceBrand: undefined;

  readonly sessionId: string;
  /**
   * The owning runtime's id — the internal `SessionRef`'s other half
   * (multi-runtime refactor M6). Every runtime-lease activation seeds it,
   * and M8a made that the only activation path; the field stays optional
   * because the context seed is plain data (tests construct it directly).
   * Internal identity only, never projected onto the v1 wire.
   */
  readonly runtimeId?: string;
  readonly workspaceId: string;
  readonly cwd: string;
  scope(subKey?: string): string;
}

export const ISessionContext: ServiceIdentifier<ISessionContext> =
  createDecorator<ISessionContext>('sessionContext');

export function sessionContextSeed(ctx: ISessionContext): ScopeSeed {
  return [[ISessionContext as ServiceIdentifier<unknown>, ctx]];
}

export function makeSessionContext(input: {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly sessionScope: string;
  readonly cwd: string;
  readonly runtimeId?: string;
}): ISessionContext {
  const { sessionScope } = input;
  return {
    _serviceBrand: undefined,
    sessionId: input.sessionId,
    runtimeId: input.runtimeId,
    workspaceId: input.workspaceId,
    cwd: input.cwd,
    scope: (subKey?: string): string =>
      subKey === undefined || subKey === '' ? sessionScope : `${sessionScope}/${subKey}`,
  };
}
