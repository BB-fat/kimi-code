/**
 * `localWorkspaceRuntime` domain (L6) — the lease contribution that seeds the
 * LOCAL per-session host facts into a runtime-backed Session scope.
 *
 * The generic runtime contract stays pathless (plan §1.4): nothing in
 * `ISessionRuntimeContext` exposes a physical directory. But a LOCAL runtime
 * genuinely owns the legacy per-session host directory
 * (`<homeDir>/sessions/<wd_id>/<sessionId>`), and a set of transitional
 * Session/Agent consumers — the session log file (`logs/`), the plan working
 * documents (`agents/<id>/plans/`), MCP media originals (`media-originals/`),
 * task output display paths, the `agents.<id>.homedir` metadata field and the
 * cron store's `cron/<wd_id>` addressing — still read those facts off the
 * legacy `ISessionContext` seed. The runtime-backed activation seeds a
 * pathless `ISessionContext` (empty `sessionDir`/`workspaceId`); this
 * contribution REPLACES that seed through the standard contribution channel
 * (plan §7.4: a contribution whose `id` matches a baseline registration
 * replaces it), so on a local lease every one of those consumers behaves
 * byte-for-byte like the legacy `sessionLifecycle` path.
 *
 * The contribution is gated on the transitional `session.host_files`
 * capability the local runtime projects: a lease without the capability keeps
 * the pathless seed (headless runtimes never see a host directory). All path
 * knowledge stays inside this Local adapter — Session Core only ever resolves
 * the `ISessionContext` contract.
 */

import { join } from 'pathe';

import { SyncDescriptor } from '#/_base/di/descriptors';
import type { ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopedServiceContribution } from '#/app/sessionHostRuntime/sessionRuntimeContext';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { sessionScopeOf } from './localWorkspaceLayout';

/**
 * A plain `ISessionContext` value as a DI-instantiable class (contributions
 * carry `SyncDescriptor`s, so the seeded value needs a constructor). Every
 * field mirrors what `sessionLifecycle.materializeSession` seeds for the same
 * session on the legacy path.
 */
export class LocalSessionContextSeed implements ISessionContext {
  declare readonly _serviceBrand: undefined;

  constructor(
    readonly sessionId: string,
    readonly workspaceId: string,
    readonly sessionDir: string,
    readonly metaScope: string,
    readonly cwd: string,
    readonly runtimeId?: string,
  ) {}

  scope(subKey?: string): string {
    return subKey === undefined || subKey === '' ? this.metaScope : `${this.metaScope}/${subKey}`;
  }
}

/**
 * Build the per-session `ISessionContext` replacement contribution for one
 * local lease. `scope()`/`metaScope` reproduce the lease's session namespace
 * exactly (the local runtime mints namespaces as the legacy storage scopes),
 * so persistence addressing is unchanged by the replacement. `runtimeId`
 * carries the internal `SessionRef`'s other half (M6) — never projected onto
 * the v1 wire.
 */
export function localSessionContextContribution(
  workspaceId: string,
  sessionId: string,
  homeDir: string,
  cwd: string,
  runtimeId?: string,
): ScopedServiceContribution {
  const sessionScope = sessionScopeOf(workspaceId, sessionId);
  return {
    id: ISessionContext as ServiceIdentifier<unknown>,
    descriptor: new SyncDescriptor(LocalSessionContextSeed, [
      sessionId,
      workspaceId,
      join(homeDir, sessionScope),
      sessionScope,
      cwd,
      runtimeId,
    ]),
    requires: ['session.host_files'],
  };
}
