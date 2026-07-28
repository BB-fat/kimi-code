/**
 * `sessionCapabilities` domain (L3) — the two `ISessionCapabilities` views.
 *
 * `SessionCapabilitiesService` is the default registration: admit everything,
 * no runtime-contributed tools. That is exactly the legacy session-lifecycle
 * behavior — sessions created through `sessionLifecycle` are always backed by
 * the full local host, and no lease exists to gate anything.
 *
 * `LeaseSessionCapabilities` is the runtime-backed view the
 * `app/runtimeSession` activation seeds over the default: the projected set
 * is the lease's own capability set, and `toolContributions` exposes the
 * lease's runtime-contributed tools already filtered by that set (plan §7.4:
 * contributions whose `requires` is not projected are excluded before
 * activation).
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import type { SessionRuntimeCapability } from '#/app/sessionHostRuntime/sessionHostRuntime';
import type {
  ISessionRuntimeContext,
  ScopedServiceContribution,
  ToolContribution,
} from '#/app/sessionHostRuntime/sessionRuntimeContext';

import { ISessionCapabilities } from './sessionCapabilities';

export class SessionCapabilitiesService implements ISessionCapabilities {
  declare readonly _serviceBrand: undefined;

  has(_capability: SessionRuntimeCapability): boolean {
    return true;
  }

  admitsAll(_requires: readonly string[]): boolean {
    return true;
  }

  readonly toolContributions: readonly ToolContribution[] = [];
  readonly agentServiceContributions: readonly ScopedServiceContribution[] = [];
}

export class LeaseSessionCapabilities implements ISessionCapabilities {
  declare readonly _serviceBrand: undefined;
  readonly toolContributions: readonly ToolContribution[];
  readonly agentServiceContributions: readonly ScopedServiceContribution[];

  constructor(private readonly lease: ISessionRuntimeContext) {
    this.toolContributions = lease.contributions.tools.filter((tool) =>
      this.admitsAll(tool.requires),
    );
    this.agentServiceContributions = lease.contributions.agentServices.filter((service) =>
      this.admitsAll(service.requires),
    );
  }

  has(capability: SessionRuntimeCapability): boolean {
    return this.lease.capabilities.has(capability);
  }

  admitsAll(requires: readonly string[]): boolean {
    return requires.every((capability) =>
      this.lease.capabilities.has(capability as SessionRuntimeCapability),
    );
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionCapabilities,
  SessionCapabilitiesService,
  ScopeActivation.OnDemand,
  'sessionCapabilities',
);
