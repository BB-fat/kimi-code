/**
 * `runtimeSession` domain (L6) — the `IRuntimeSessionActivationService`
 * implementation.
 *
 * `activate` assembles the Session child scope from the lease alone:
 *
 *  - `ISessionContext` is seeded pathless by default (plan §7.2): identity
 *    and the persistence scope come from the lease (`ref`, session
 *    namespace), `cwd` from the lease's OS capability when present, and
 *    `workspaceId` from the lease's typed host-files capability when the
 *    runtime owns a session bucket. Physical host paths never land on the
 *    context (plan §1.4): a runtime that genuinely owns a per-session host
 *    directory (the Local workspace runtime) carries them on the lease's
 *    `ISessionHostFiles` capability object, seeded here under its DI token —
 *    so the host-files consumers (sessionLog, the plan-mode tools and their
 *    working documents, MCP media originals, task output display paths,
 *    `agents.<id>.homedir` metadata, cron addressing) behave exactly like
 *    the legacy path on local leases, while a lease without the capability
 *    seeds the absent `NO_SESSION_HOST_FILES` view and those consumers
 *    degrade or stay gated off (plan §7.4).
 *  - The typed Stores (`IAtomicDocumentStore` / `IAppendLogStore` /
 *    `IBlobStore`) and the byte-store façade (`IFileSystemStorageService`)
 *    are bound to the lease's persistence context — the Session scope never
 *    resolves the App container's storage.
 *  - The `os/interface` contracts resolve at SESSION scope: the lease's OS
 *    handles when projected, the empty/unavailable projections otherwise
 *    (never the App container's host services).
 *  - The DI collection is filtered by the lease's capability set: every
 *    registry entry and runtime contribution whose `requires` is not
 *    projected is excluded BEFORE the scope is built (plan §7.4); the
 *    lease-seeded `ISessionCapabilities` view drives the activation-time
 *    half of the same gating (tool activation, agent-scope propagation).
 *
 * Materialization mirrors `sessionLifecycle`: metadata, tool policy and the
 * agent-profile catalog are awaited (the first turn must see file-defined
 * agent types), the skill catalog is kicked fire-and-forget, and MCP is
 * awaited with the caller's servers. App-level create/resume side effects
 * (SessionStart hooks, `session_started` telemetry, the plan-mode
 * auto-enter, failure rollback) are NOT here — they live one layer up in the
 * `runtimeSessionHost` composition service, which mirrors
 * `ISessionLifecycleService` branch by branch.
 */

import { IInstantiationService, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import {
  createScopedChildHandle,
  LifecycleScope,
  ScopeActivation,
  registerScopedService,
  type ISessionScopeHandle,
  type ScopedEntry,
} from '#/_base/di/scope';
import type { DocumentCodec } from '#/persistence/interface/atomicDocumentStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { IHostTerminalService } from '#/os/interface/terminal';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { SessionRuntimeCapability } from '#/app/sessionHostRuntime/sessionHostRuntime';
import {
  ISessionRuntimeLease,
  type ISessionOsCapabilities,
  type ISessionRuntimeContext,
  type PersistenceNamespace,
  type SessionCloseReason,
} from '#/app/sessionHostRuntime/sessionRuntimeContext';
import type { SessionRef } from '#/app/sessionHostRuntime/sessionRef';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionMcpService } from '#/session/mcp/sessionMcp';
import { ISessionCapabilities } from '#/session/sessionCapabilities/sessionCapabilities';
import { LeaseSessionCapabilities } from '#/session/sessionCapabilities/sessionCapabilitiesService';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import {
  ISessionHostFiles,
  NO_SESSION_HOST_FILES,
} from '#/session/sessionHostFiles/sessionHostFiles';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';

import { BlobBackedStorageService } from './blobBackedStorage';
import {
  EMPTY_HOST_ENVIRONMENT,
  EMPTY_HOST_FILE_SYSTEM,
  UNAVAILABLE_HOST_FS_WATCH_SERVICE,
  UNAVAILABLE_HOST_PROCESS_SERVICE,
  UNAVAILABLE_HOST_TERMINAL_SERVICE,
} from './leaseOsProjection';
import {
  type ActivateRuntimeSessionOptions,
  type IRuntimeSessionScope,
  IRuntimeSessionActivationService,
} from './runtimeSessionActivation';

/**
 * The JSON document codec Session Core uses for lease Stores. Byte-compatible
 * with the node-fs backend's `jsonDocumentCodec` (`JSON.stringify` UTF-8, no
 * whitespace) — the local runtime maps it onto the SAME legacy files, and the
 * contract-domain ban on `persistence/backends` keeps this small duplicate
 * here instead of reaching into a backend.
 */
export const sessionJsonDocumentCodec: DocumentCodec = {
  format: 'json',
  encode(value: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(value));
  },
  decode(bytes: Uint8Array): unknown {
    return JSON.parse(new TextDecoder().decode(bytes));
  },
};

/**
 * The pathless `ISessionContext` of a runtime-backed session (plan §7.2).
 * `scope()` composes sub-scopes off the lease's session namespace — for the
 * local runtime that IS the legacy `sessions/<wd_id>/<sessionId>` scope, so
 * every scope-addressed write lands exactly where the old path puts it. The
 * `workspaceId` bucket fact comes from the lease's typed host-files
 * capability (the Local runtime's `wd_id`); a runtime without a session
 * bucket leaves it empty.
 */
export function makeLeaseSessionContext(
  lease: ISessionRuntimeContext,
  sessionNamespace: PersistenceNamespace,
): ISessionContext {
  const scope = sessionNamespace as string;
  return {
    _serviceBrand: undefined,
    sessionId: lease.ref.sessionId,
    runtimeId: lease.ref.runtimeId,
    workspaceId: lease.hostFiles?.workspaceId ?? '',
    cwd: lease.os?.cwd ?? '',
    scope: (subKey?: string): string =>
      subKey === undefined || subKey === '' ? scope : `${scope}/${subKey}`,
  };
}

/** The DI collection admission filter for one lease's capability set. */
export function leaseServiceFilter(lease: ISessionRuntimeContext): (entry: ScopedEntry) => boolean {
  return (entry) =>
    entry.requires.every((capability) =>
      lease.capabilities.has(capability as SessionRuntimeCapability),
    );
}

function osSeeds(
  os: ISessionOsCapabilities | undefined,
): Array<readonly [ServiceIdentifier<unknown>, unknown]> {
  return [
    [IHostFileSystem, os?.filesystem ?? EMPTY_HOST_FILE_SYSTEM],
    [IHostProcessService, os?.process ?? UNAVAILABLE_HOST_PROCESS_SERVICE],
    [IHostTerminalService, os?.terminal ?? UNAVAILABLE_HOST_TERMINAL_SERVICE],
    [IHostFsWatchService, os?.watch ?? UNAVAILABLE_HOST_FS_WATCH_SERVICE],
    [IHostEnvironment, os?.environment ?? EMPTY_HOST_ENVIRONMENT],
  ];
}

class RuntimeSessionScope implements IRuntimeSessionScope {
  readonly ref: SessionRef;
  private closed = false;

  constructor(
    readonly lease: ISessionRuntimeContext,
    readonly handle: ISessionScopeHandle,
  ) {
    this.ref = lease.ref;
  }

  async flush(): Promise<void> {
    await this.lease.flush();
  }

  async close(reason: SessionCloseReason): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Drain agents BEFORE disposing the scope (same ordering as the legacy
    // sessionLifecycle close): tasks stop, turns cancel, agent scopes
    // dispose — then the lease's flush drains every appended record.
    const agents = this.handle.accessor.get(IAgentLifecycleService);
    for (const agent of agents.list()) {
      await agents.remove(agent.id);
    }
    this.handle.dispose();
    await this.lease.close(reason);
  }
}

export class RuntimeSessionActivationService
  extends Disposable
  implements IRuntimeSessionActivationService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {
    super();
  }

  async activate(
    lease: ISessionRuntimeContext,
    options?: ActivateRuntimeSessionOptions,
  ): Promise<IRuntimeSessionScope> {
    // A probed host environment (the local runtime's) must settle before any
    // consumer reads the sync fields — same rule as the legacy path.
    await lease.os?.environment?.ready;

    const sessionNamespace = lease.persistence.sessionNamespace();
    const seeds: Array<readonly [ServiceIdentifier<unknown>, unknown]> = [
      [ISessionContext, makeLeaseSessionContext(lease, sessionNamespace)],
      [ISessionRuntimeLease, lease],
      [ISessionCapabilities, new LeaseSessionCapabilities(lease)],
      [ISessionHostFiles, lease.hostFiles ?? NO_SESSION_HOST_FILES],
      [IAtomicDocumentStore, lease.persistence.documents(sessionNamespace, sessionJsonDocumentCodec)],
      [IAppendLogStore, lease.persistence.logs(sessionNamespace, sessionJsonDocumentCodec)],
      [IBlobStore, lease.persistence.blobs(sessionNamespace)],
      [
        IFileSystemStorageService,
        new BlobBackedStorageService(lease.persistence.blobs(sessionNamespace)),
      ],
      ...osSeeds(lease.os),
      [ITelemetryService, this.telemetry.withContext({ sessionId: lease.ref.sessionId })],
    ];
    // Runtime-contributed session services: capability-filtered, and a
    // contribution may REPLACE a baseline registration (same identifier).
    for (const contribution of lease.contributions.sessionServices) {
      const admitted = contribution.requires.every((capability) =>
        lease.capabilities.has(capability),
      );
      if (admitted) seeds.push([contribution.id, contribution.descriptor]);
    }

    const handle = createScopedChildHandle(
      this.instantiation,
      LifecycleScope.Session,
      lease.ref.sessionId,
      { extra: seeds, serviceFilter: leaseServiceFilter(lease) },
    ) as ISessionScopeHandle;
    try {
      await handle.accessor.get(ISessionMetadata).ready;
      await handle.accessor.get(ISessionToolPolicy).ready;
      void handle.accessor.get(ISessionSkillCatalog).ready;
      await handle.accessor.get(ISessionAgentProfileCatalog).ready;
      await handle.accessor.get(ISessionMcpService).ensureMcpReady(options?.mcpServers);
    } catch (error) {
      handle.dispose();
      throw error;
    }

    // Register the persisted roster with the lease so its cold reader can
    // enumerate agents without a live scope.
    const metadata = await handle.accessor.get(ISessionMetadata).read();
    for (const agentId of Object.keys(metadata.agents ?? {})) {
      lease.persistence.agentNamespace(agentId);
    }

    if (options?.mainAgent !== undefined) {
      const agents = handle.accessor.get(IAgentLifecycleService);
      if (agents.get(MAIN_AGENT_ID) === undefined) {
        try {
          await agents.create({ agentId: MAIN_AGENT_ID, binding: options.mainAgent.binding });
        } catch (error) {
          handle.dispose();
          throw error;
        }
        lease.persistence.agentNamespace(MAIN_AGENT_ID);
      }
    }

    return new RuntimeSessionScope(lease, handle);
  }
}

registerScopedService(
  LifecycleScope.App,
  IRuntimeSessionActivationService,
  RuntimeSessionActivationService,
  ScopeActivation.OnDemand,
  'runtimeSession',
);
