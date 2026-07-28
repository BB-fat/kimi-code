/**
 * `sessionCapabilities` domain (L3) — the Session-scope view of the runtime
 * capabilities a session was activated with (plan §7.4).
 *
 * Session Core's contribution gating has two halves: the scope builder
 * filters the DI collection by each registry entry's `requires` before the
 * scope exists, and anything decided LATER (tool activation on agent
 * creation, runtime-contributed tools) consults this service. The default
 * registration admits everything — the exact behavior of the legacy
 * session-lifecycle path, whose sessions are always backed by the full local
 * host. The runtime-backed activation (`app/runtimeSession`) seeds a
 * lease-driven view instead: capabilities come from the
 * `ISessionRuntimeContext`, and runtime-contributed tools ride along so
 * `AgentToolActivationService` can activate them through the same policy
 * filter as builtin tools.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { SessionRuntimeCapability } from '#/app/sessionHostRuntime/sessionHostRuntime';
import type {
  ScopedServiceContribution,
  ToolContribution,
} from '#/app/sessionHostRuntime/sessionRuntimeContext';

export interface ISessionCapabilities {
  readonly _serviceBrand: undefined;

  /** Whether the session's runtime projects `capability` into this session. */
  has(capability: SessionRuntimeCapability): boolean;

  /** Whether every string in `requires` is projected (DI registry entries carry opaque strings). */
  admitsAll(requires: readonly string[]): boolean;

  /**
   * Runtime-contributed tools admitted for this session (plan §7.4), already
   * capability-filtered. The bound Profile's tool policy still applies at
   * activation time. Empty on the legacy path.
   */
  readonly toolContributions: readonly ToolContribution[];

  /**
   * Runtime-contributed Agent-scope service bindings admitted for this
   * session, already capability-filtered. `AgentLifecycleService` merges them
   * into every Agent collection it builds. Empty on the legacy path.
   */
  readonly agentServiceContributions: readonly ScopedServiceContribution[];
}

export const ISessionCapabilities: ServiceIdentifier<ISessionCapabilities> =
  createDecorator<ISessionCapabilities>('sessionCapabilities');
