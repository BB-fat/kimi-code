/**
 * Test harness — `FakeRemoteWorkspaceProvider` / `FakeRemoteWorkspaceRuntime`,
 * the Remote branch of `IWorkspaceProvider` (plan §4.4).
 *
 * The fake models a LONG-LIVED remote workspace runtime hosting any number of
 * sessions behind ONE shared remote connection:
 *
 *   - `runtime.sessions` implements the full CRUD / open / lease / cold /
 *     artifact / export / import surface on top of an in-memory "provider
 *     backend" (the standalone memory session manager stands in for the
 *     remote store); sessions share the connection identity while their
 *     namespaces, locks and state stay isolated;
 *   - OS capabilities surface as an opaque remote handle on the lease (`os`),
 *     carrying the shared connection id every session lease points at;
 *   - contributions are gated at lease-assembly time: a contribution whose
 *     `requires` names a capability the runtime does not project is excluded
 *     before the Session scope would ever see it (plan §4.4/§7.4);
 *   - `connection.disconnect()` simulates a network cut: the runtime flips
 *     offline, every live child lease is closed with `runtime_lost` (the
 *     suspended/failed signal), and new open/resume (and every other manager
 *     call) fails with `session.runtime_unavailable` until
 *     `connection.reconnect()` flips the same runtime id back online —
 *     previously suspended leases do NOT revive. There is no Local/App
 *     fallback path at all.
 *
 * It doubles as the skeleton a real Remote provider grows from: swap the
 * in-memory delegate for an RPC-bound session manager and keep the
 * connection/lease/capability semantics.
 */

import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';

import type {
  ISessionHostRuntime,
  RuntimeCloseReason,
  SessionRuntimeCapability,
  SessionRuntimeStatus,
} from '#/app/sessionHostRuntime/sessionHostRuntime';
import type {
  ISessionManager,
  OpenSessionOptions,
  ResumeSessionOptions,
} from '#/app/sessionHostRuntime/sessionManager';
import type {
  ISessionRuntimeContext,
  SessionRuntimeContributions,
} from '#/app/sessionHostRuntime/sessionRuntimeContext';
import { StandaloneMemorySessionManager } from '#/app/standaloneMemoryRuntime/standaloneMemoryHostRuntime';
import type {
  IWorkspaceProvider,
  IWorkspaceRuntime,
  IWorkspaceRuntimeRegistration,
  WorkspaceCapability,
  WorkspaceDescriptor,
} from '#/app/workspace/workspaceRuntime';

const DEFAULT_REMOTE_CAPABILITIES: ReadonlySet<SessionRuntimeCapability> = new Set([
  'os.filesystem',
  'os.process',
  'artifact.model_read',
  'session.cold_read',
  'session.export',
  'session.import',
  'session.fork',
]);

const DEFAULT_REMOTE_WORKSPACE_CAPABILITIES: ReadonlySet<WorkspaceCapability> = new Set([
  'workspace.remote',
]);

const NO_CONTRIBUTIONS: SessionRuntimeContributions = {
  sessionServices: [],
  agentServices: [],
  tools: [],
};

/**
 * The shared remote connection (plan §4.4: sessions share the connection and
 * its auth identity). `disconnect`/`reconnect` drive the runtime's online
 * status; listeners let the owning runtime suspend leases on a cut.
 */
export class FakeRemoteConnection {
  readonly id: string;
  private connected = true;
  private readonly disconnectListeners = new Set<() => void>();
  private readonly reconnectListeners = new Set<() => void>();

  constructor(id: string) {
    this.id = id;
  }

  isConnected(): boolean {
    return this.connected;
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    for (const listener of this.disconnectListeners) listener();
  }

  reconnect(): void {
    if (this.connected) return;
    this.connected = true;
    for (const listener of this.reconnectListeners) listener();
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  onReconnect(listener: () => void): () => void {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }
}

export interface FakeRemoteWorkspaceRuntimeOptions {
  readonly workspaceId: string;
  /** Defaults to `remote-workspace_<workspaceId>` (deterministic re-open identity). */
  readonly runtimeId?: string;
  readonly connection?: FakeRemoteConnection;
  readonly capabilities?: ReadonlySet<SessionRuntimeCapability>;
  readonly workspaceCapabilities?: ReadonlySet<WorkspaceCapability>;
  /** Ungated contribution set; the lease view filters it by capability (plan §7.4). */
  readonly contributions?: SessionRuntimeContributions;
}

export class FakeRemoteWorkspaceRuntime implements IWorkspaceRuntime {
  readonly id: string;
  readonly kind = 'remote-workspace';
  readonly sessions: ISessionManager;
  readonly workspaceCapabilities: ReadonlySet<WorkspaceCapability>;
  /** The shared connection every session lease of this runtime points at. */
  readonly connection: FakeRemoteConnection;

  private readonly delegate: StandaloneMemorySessionManager;
  private currentStatus: SessionRuntimeStatus = 'online';
  private disposed = false;
  private readonly caps: ReadonlySet<SessionRuntimeCapability>;
  private readonly ungatedContributions: SessionRuntimeContributions;

  constructor(options: FakeRemoteWorkspaceRuntimeOptions) {
    this.id = options.runtimeId ?? `remote-workspace_${options.workspaceId}`;
    this.caps = options.capabilities ?? DEFAULT_REMOTE_CAPABILITIES;
    this.workspaceCapabilities =
      options.workspaceCapabilities ?? DEFAULT_REMOTE_WORKSPACE_CAPABILITIES;
    this.ungatedContributions = options.contributions ?? NO_CONTRIBUTIONS;
    this.connection =
      options.connection ?? new FakeRemoteConnection(`${this.id}/connection`);
    this.delegate = new StandaloneMemorySessionManager(
      this.id,
      () => this.currentStatus,
      (status) => {
        this.currentStatus = status;
      },
      this.caps,
      this.ungatedContributions,
    );
    this.sessions = new FakeRemoteSessionManager(this.delegate, (context) =>
      this.gateContext(context),
    );
    this.connection.onDisconnect(() => {
      // Network cut: flip offline and suspend every live child lease with
      // `runtime_lost` — never a Local/App-scope fallback (plan §4.4).
      void this.delegate.closeRuntime();
    });
    this.connection.onReconnect(() => {
      // The same runtime id comes back online; suspended leases stay closed
      // and must be re-opened. A disposed (unregistered) runtime stays down.
      if (!this.disposed) {
        this.currentStatus = 'online';
      }
    });
  }

  status(): SessionRuntimeStatus {
    return this.currentStatus;
  }

  capabilities(): ReadonlySet<SessionRuntimeCapability> {
    return this.caps;
  }

  async close(_reason: RuntimeCloseReason): Promise<void> {
    this.disposed = true;
    await this.delegate.closeRuntime();
  }

  /**
   * Lease assembly (plan §3.3/§4.4): contributions whose `requires` names a
   * capability this runtime does not project are excluded BEFORE the Session
   * scope would be built, and the lease exposes the shared remote connection
   * as its OS capability handle. The wrapper forwards the underlying lease's
   * `closedLease` flag so tests can observe a suspended lease directly.
   */
  private gateContext(context: ISessionRuntimeContext): ISessionRuntimeContext {
    const caps = this.caps;
    const gate = <T extends { readonly requires: readonly SessionRuntimeCapability[] }>(
      entries: readonly T[],
    ): readonly T[] => entries.filter((entry) => entry.requires.every((r) => caps.has(r)));
    const wrapped: ISessionRuntimeContext & { readonly closedLease: boolean } = {
      ref: context.ref,
      descriptor: context.descriptor,
      persistence: context.persistence,
      artifacts: context.artifacts,
      coldReader: context.coldReader,
      capabilities: context.capabilities,
      contributions: {
        sessionServices: gate(context.contributions.sessionServices),
        agentServices: gate(context.contributions.agentServices),
        tools: gate(context.contributions.tools),
      },
      os: { remoteConnectionId: this.connection.id },
      get closedLease() {
        return (context as { readonly closedLease?: boolean }).closedLease ?? false;
      },
      flush: () => context.flush(),
      close: (reason) => context.close(reason),
    };
    return wrapped;
  }
}

/**
 * Delegating manager: every method reaches the "remote backend" through the
 * shared connection — while offline the delegate itself fails every call with
 * `session.runtime_unavailable`. open/resume additionally run the fake's
 * lease-assembly gate (contributions + OS handle).
 */
class FakeRemoteSessionManager implements ISessionManager {
  constructor(
    private readonly delegate: StandaloneMemorySessionManager,
    private readonly gate: (context: ISessionRuntimeContext) => ISessionRuntimeContext,
  ) {}

  create(input: Parameters<ISessionManager['create']>[0]) {
    return this.delegate.create(input);
  }

  list(query?: Parameters<ISessionManager['list']>[0]) {
    return this.delegate.list(query);
  }

  get(sessionId: string) {
    return this.delegate.get(sessionId);
  }

  update(sessionId: string, patch: Parameters<ISessionManager['update']>[1]) {
    return this.delegate.update(sessionId, patch);
  }

  delete(sessionId: string, options?: Parameters<ISessionManager['delete']>[1]) {
    return this.delegate.delete(sessionId, options);
  }

  fork(sourceSessionId: string, input: Parameters<ISessionManager['fork']>[1]) {
    return this.delegate.fork(sourceSessionId, input);
  }

  coldRead(sessionId: string) {
    return this.delegate.coldRead(sessionId);
  }

  export(sessionId: string, options?: Parameters<ISessionManager['export']>[1]) {
    return this.delegate.export(sessionId, options);
  }

  import(input: Parameters<ISessionManager['import']>[0]) {
    return this.delegate.import(input);
  }

  async open(
    sessionId: string,
    options: OpenSessionOptions,
  ): Promise<ISessionRuntimeContext> {
    const context = await this.delegate.open(sessionId, options);
    return this.gate(context);
  }

  async resume(
    sessionId: string,
    options: ResumeSessionOptions,
  ): Promise<ISessionRuntimeContext> {
    const context = await this.delegate.resume(sessionId, options);
    return this.gate(context);
  }
}

export interface FakeRemoteWorkspaceProviderOptions {
  readonly capabilities?: ReadonlySet<SessionRuntimeCapability>;
  readonly contributions?: SessionRuntimeContributions;
}

/**
 * The Remote branch of `IWorkspaceProvider` (plan §4.4): `open` establishes
 * the shared remote connection and returns the complete long-lived runtime in
 * one shot. `openCalls` is the spy counter proving ordinary session CRUD never
 * re-opens the provider (plan §9.4).
 */
export class FakeRemoteWorkspaceProvider implements IWorkspaceProvider {
  private openCount = 0;

  constructor(private readonly options: FakeRemoteWorkspaceProviderOptions = {}) {}

  get openCalls(): number {
    return this.openCount;
  }

  open(descriptor: WorkspaceDescriptor): Promise<IWorkspaceRuntimeRegistration> {
    this.openCount += 1;
    const workspaceId = descriptor.workspaceId ?? encodeWorkDirKey(descriptor.root);
    const runtime = new FakeRemoteWorkspaceRuntime({
      workspaceId,
      capabilities: this.options.capabilities,
      contributions: this.options.contributions,
    });
    return Promise.resolve({
      workspaceId,
      runtime,
      dispose: () => runtime.close('unregistered'),
    });
  }
}
