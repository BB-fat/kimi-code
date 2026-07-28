/**
 * `standaloneMemoryRuntime` domain (L4) — `StandaloneMemoryHostRuntime`, the
 * headless in-memory multi-session host runtime (plan §4.5), and its
 * `ISessionManager` implementation.
 *
 * One runtime instance is a long-lived host for ANY number of sessions
 * (Runtime 1:N Session): `sessions.create` is repeatable and concurrent,
 * every session shares the runtime's `runtimeId` and its in-memory backend,
 * and each session's state, namespaces, locks and lifecycle stay isolated by
 * `session/<sessionId>` namespace tokens. Closing one session — or the last —
 * never closes the runtime; only an explicit `runtime.close(reason)` flips
 * the runtime offline, after which every manager method fails with
 * `session.runtime_unavailable` while the registry entry (and all data) is
 * retained.
 *
 * The runtime is headless: no Workspace OS capabilities and no `os` handles
 * on its leases, while cold read, artifact, export/import and same-runtime
 * fork are fully provided from the in-memory backend. It belongs to no
 * Workspace domain and registers into `ISessionHostRuntimeRegistry` like any
 * other host runtime.
 */

import { randomUUID } from 'node:crypto';

import { Error2 } from '#/_base/errors/errors';

import { SessionHostRuntimeError, SessionHostRuntimeErrors } from '#/app/sessionHostRuntime/errors';
import type {
  ISessionHostRuntime,
  RuntimeCloseReason,
  SessionRuntimeCapability,
  SessionRuntimeStatus,
} from '#/app/sessionHostRuntime/sessionHostRuntime';
import type {
  CreateSessionInput,
  DeleteSessionOptions,
  ISessionManager,
  OpenSessionOptions,
  ResumeSessionOptions,
  SameRuntimeForkInput,
  SessionExportEntry,
  SessionExportOptions,
  SessionImportInput,
  SessionListQuery,
  SessionPage,
  UpdateSessionPatch,
} from '#/app/sessionHostRuntime/sessionManager';
import type {
  ISessionColdReader,
  SessionDescriptor,
  SessionRuntimeContributions,
} from '#/app/sessionHostRuntime/sessionRuntimeContext';
import { ErrorCodes } from '#/errors';

import {
  MemorySessionBackend,
  agentNamespaceOf,
  isValidIdSegment,
  sessionNamespaceOf,
  type MemorySessionEntry,
} from './memoryBackend';
import {
  MemorySessionColdReader,
  MemorySessionLease,
  cloneDescriptor,
} from './memorySessionContext';
import {
  commitStagedImport,
  exportMemorySession,
  stageImportEntries,
} from './memorySessionTransfer';

const DEFAULT_CAPABILITIES: ReadonlySet<SessionRuntimeCapability> = new Set([
  'artifact.model_read',
  'session.cold_read',
  'session.export',
  'session.import',
  'session.fork',
]);

const NO_CONTRIBUTIONS: SessionRuntimeContributions = {
  sessionServices: [],
  agentServices: [],
  tools: [],
};

export interface StandaloneMemoryHostRuntimeOptions {
  /** Stable runtime id; minted when absent. Re-register under the same id to revive refs. */
  readonly id?: string;
  /** Projected capability set; defaults to the headless baseline (no `os.*`). */
  readonly capabilities?: ReadonlySet<SessionRuntimeCapability>;
  /** Contributions projected into leases at open time; defaults to none (M4 wires real ones). */
  readonly contributions?: SessionRuntimeContributions;
}

export class StandaloneMemoryHostRuntime implements ISessionHostRuntime {
  readonly id: string;
  readonly kind = 'standalone-memory';
  readonly sessions: StandaloneMemorySessionManager;

  private currentStatus: SessionRuntimeStatus = 'online';
  private readonly caps: ReadonlySet<SessionRuntimeCapability>;

  constructor(options: StandaloneMemoryHostRuntimeOptions = {}) {
    this.id = options.id ?? `standalone-memory_${randomUUID()}`;
    this.caps = options.capabilities ?? DEFAULT_CAPABILITIES;
    this.sessions = new StandaloneMemorySessionManager(
      this.id,
      () => this.currentStatus,
      (status) => {
        this.currentStatus = status;
      },
      this.caps,
      options.contributions ?? NO_CONTRIBUTIONS,
    );
  }

  status(): SessionRuntimeStatus {
    return this.currentStatus;
  }

  capabilities(): ReadonlySet<SessionRuntimeCapability> {
    return this.caps;
  }

  async close(_reason: RuntimeCloseReason): Promise<void> {
    await this.sessions.closeRuntime();
  }
}

export class StandaloneMemorySessionManager implements ISessionManager {
  private readonly backend = new MemorySessionBackend();
  private readonly catalog = new Map<string, MemorySessionEntry>();

  constructor(
    private readonly runtimeId: string,
    private readonly getStatus: () => SessionRuntimeStatus,
    private readonly setStatus: (status: SessionRuntimeStatus) => void,
    private readonly caps: ReadonlySet<SessionRuntimeCapability>,
    private readonly contributions: SessionRuntimeContributions,
  ) {}

  async create(input: CreateSessionInput): Promise<SessionDescriptor> {
    this.assertOnline();
    const sessionId = input.sessionId ?? `session_${randomUUID()}`;
    assertValidSessionId(sessionId);
    if (this.catalog.has(sessionId)) {
      throw new Error2(
        ErrorCodes.SESSION_ALREADY_EXISTS,
        `session '${sessionId}' already exists in runtime '${this.runtimeId}'`,
      );
    }
    const now = new Date().toISOString();
    const entry: MemorySessionEntry = {
      current: {
        ref: { runtimeId: this.runtimeId, sessionId },
        createdAt: now,
        updatedAt: now,
        status: 'active',
        metadata: structuredClone(input.metadata ?? {}),
        revision: '1',
      },
      revision: 1,
      namespaces: new Set(),
      agents: new Set(),
      artifactVersions: new Map(),
      lease: undefined,
    };
    this.catalog.set(sessionId, entry);
    return cloneDescriptor(entry.current);
  }

  async list(query?: SessionListQuery): Promise<SessionPage> {
    this.assertOnline();
    let entries = [...this.catalog.values()];
    if (query?.status !== undefined) {
      entries = entries.filter((entry) => entry.current.status === query.status);
    }
    const start = query?.cursor === undefined ? 0 : Number.parseInt(query.cursor, 10);
    const limit = query?.limit ?? Number.POSITIVE_INFINITY;
    const page = entries.slice(start, start + limit);
    const next = start + page.length;
    return {
      items: page.map((entry) => cloneDescriptor(entry.current)),
      cursor: next < entries.length ? String(next) : undefined,
    };
  }

  async get(sessionId: string): Promise<SessionDescriptor | undefined> {
    this.assertOnline();
    const entry = this.catalog.get(sessionId);
    return entry === undefined ? undefined : cloneDescriptor(entry.current);
  }

  async update(sessionId: string, patch: UpdateSessionPatch): Promise<SessionDescriptor> {
    this.assertOnline();
    const entry = this.requireEntry(sessionId);
    this.assertRevision(entry, patch.revision);
    const next: SessionDescriptor = {
      ...entry.current,
      metadata:
        patch.metadata === undefined
          ? entry.current.metadata
          : { ...entry.current.metadata, ...structuredClone(patch.metadata) },
      status: patch.status ?? entry.current.status,
      updatedAt: new Date().toISOString(),
      revision: String(entry.revision + 1),
    };
    entry.current = next;
    entry.revision += 1;
    return cloneDescriptor(next);
  }

  async delete(sessionId: string, options?: DeleteSessionOptions): Promise<void> {
    this.assertOnline();
    const entry = this.requireEntry(sessionId);
    if (entry.lease !== undefined) {
      if (options?.force !== true) {
        throw new SessionHostRuntimeError(
          SessionHostRuntimeErrors.codes.SESSION_LEASE_CONFLICT,
          `session '${sessionId}' cannot be deleted while a live lease holds it (pass force to override)`,
          { details: { runtimeId: this.runtimeId, sessionId } },
        );
      }
      await entry.lease.closeFromManager('deleted');
    }
    await this.purge(entry);
    this.catalog.delete(sessionId);
  }

  async open(sessionId: string, _options: OpenSessionOptions): Promise<MemorySessionLease> {
    this.assertOnline();
    const entry = this.requireEntry(sessionId);
    return this.openLease(entry);
  }

  async resume(
    sessionId: string,
    options: ResumeSessionOptions,
  ): Promise<MemorySessionLease> {
    this.assertOnline();
    const entry = this.requireEntry(sessionId);
    this.assertRevision(entry, options.expectedRevision);
    return this.openLease(entry);
  }

  async fork(sourceSessionId: string, input: SameRuntimeForkInput): Promise<SessionDescriptor> {
    this.assertOnline();
    const source = this.requireEntry(sourceSessionId);
    // A live writer may hold unflushed appends: flush its lease first so the
    // fork copies a complete point-in-time cut (the writer may append again
    // afterwards — those later writes belong to the source only).
    if (source.lease !== undefined) await source.lease.flush();
    const sessionId = input.sessionId ?? `session_${randomUUID()}`;
    assertValidSessionId(sessionId);
    if (this.catalog.has(sessionId)) {
      throw new Error2(
        ErrorCodes.SESSION_ALREADY_EXISTS,
        `session '${sessionId}' already exists in runtime '${this.runtimeId}'`,
      );
    }
    const now = new Date().toISOString();
    const forked: MemorySessionEntry = {
      current: {
        ref: { runtimeId: this.runtimeId, sessionId },
        createdAt: now,
        updatedAt: now,
        status: 'active',
        metadata: {
          ...structuredClone(source.current.metadata),
          forkedFrom: sourceSessionId,
          ...(input.metadata === undefined ? {} : structuredClone(input.metadata)),
        },
        revision: '1',
      },
      revision: 1,
      namespaces: new Set(),
      agents: new Set(source.agents),
      artifactVersions: new Map(source.artifactVersions),
      lease: undefined,
    };
    const sourcePrefix = sessionNamespaceOf(sourceSessionId);
    for (const sourceNamespace of source.namespaces) {
      const targetNamespace = sourceNamespace.startsWith(`${sourcePrefix}/agents/`)
        ? agentNamespaceOf(sessionId, sourceNamespace.slice(`${sourcePrefix}/agents/`.length))
        : sessionNamespaceOf(sessionId);
      forked.namespaces.add(targetNamespace);
      await this.copyNamespace(sourceNamespace, targetNamespace);
    }
    await this.reanchorStateDocument(sourceSessionId, sessionId, input);
    this.catalog.set(sessionId, forked);
    return cloneDescriptor(forked.current);
  }

  /**
   * The same fork rewrite the local runtime performs (plan §5.8): the copied
   * engine metadata document (`state.json` in the session namespace — the
   * engine's metadata key) is re-anchored to the fork — new id, `forkedFrom`
   * provenance, fresh timestamps, unarchived, goal state never crossing
   * forks. Without it the fork would resume with the SOURCE session's
   * identity.
   */
  private async reanchorStateDocument(
    sourceSessionId: string,
    sessionId: string,
    input: SameRuntimeForkInput,
  ): Promise<void> {
    const targetNamespace = sessionNamespaceOf(sessionId);
    const stateBytes = await this.backend.documentBytes.read(targetNamespace, ENGINE_STATE_KEY);
    if (stateBytes === undefined) return;
    const meta = JSON.parse(textDecoder.decode(stateBytes)) as Record<string, unknown>;
    const titleFromInput = readMetadataString(input.metadata, 'title');
    const custom = forkCustomMetadata(
      readMetadataRecord(meta['custom']),
      readMetadataRecord(input.metadata?.['custom']),
    );
    const now = Date.now();
    const reanchored: Record<string, unknown> = {
      ...meta,
      id: sessionId,
      forkedFrom: sourceSessionId,
      createdAt: now,
      updatedAt: now,
      archived: false,
      title: titleFromInput ?? `Fork: ${typeof meta['title'] === 'string' ? meta['title'] : sourceSessionId}`,
      isCustomTitle: titleFromInput !== undefined ? true : meta['isCustomTitle'] === true,
      custom,
    };
    await this.backend.documentBytes.write(
      targetNamespace,
      ENGINE_STATE_KEY,
      textEncoder.encode(JSON.stringify(reanchored)),
      { atomic: true },
    );
  }

  async coldRead(sessionId: string): Promise<ISessionColdReader> {
    this.assertOnline();
    this.requireEntry(sessionId);
    return new MemorySessionColdReader(
      this.backend,
      { runtimeId: this.runtimeId, sessionId },
      (id) => this.catalog.get(id),
    );
  }

  async *export(
    sessionId: string,
    _options?: SessionExportOptions,
  ): AsyncIterable<SessionExportEntry> {
    this.assertOnline();
    const entry = this.requireEntry(sessionId);
    // Same snapshot rule as fork: flush a live lease's pending appends first,
    // so the exported stream is a complete cut at the flush boundary.
    if (entry.lease !== undefined) await entry.lease.flush();
    yield* exportMemorySession(this.backend, entry);
  }

  async import(input: SessionImportInput): Promise<SessionDescriptor> {
    this.assertOnline();
    const sessionId = input.sessionId ?? `session_${randomUUID()}`;
    assertValidSessionId(sessionId);
    if (this.catalog.has(sessionId)) {
      throw new Error2(
        ErrorCodes.SESSION_ALREADY_EXISTS,
        `session '${sessionId}' already exists in runtime '${this.runtimeId}'`,
      );
    }
    const staged = await stageImportEntries(input.entries);
    const now = new Date().toISOString();
    const entry: MemorySessionEntry = {
      current: {
        ref: { runtimeId: this.runtimeId, sessionId },
        createdAt: staged.descriptor.createdAt ?? now,
        updatedAt: now,
        status: staged.descriptor.status ?? 'active',
        metadata: {
          ...structuredClone(staged.descriptor.metadata ?? {}),
          ...(input.metadata === undefined ? {} : structuredClone(input.metadata)),
        },
        revision: '1',
      },
      revision: 1,
      namespaces: new Set(),
      agents: new Set(),
      artifactVersions: new Map(),
      lease: undefined,
    };
    await commitStagedImport(this.backend, entry, staged);
    this.catalog.set(sessionId, entry);
    return cloneDescriptor(entry.current);
  }

  /** Drive the whole runtime offline (plan §5.4): leases lost, data retained. */
  async closeRuntime(): Promise<void> {
    if (this.getStatus() === 'offline') return;
    this.setStatus('offline');
    const closures = [...this.catalog.values()]
      .filter((entry) => entry.lease !== undefined)
      .map((entry) => entry.lease!.closeFromManager('runtime_lost'));
    await Promise.allSettled(closures);
  }

  private openLease(entry: MemorySessionEntry): MemorySessionLease {
    // The check-and-set is synchronous, so concurrent opens of the same
    // session race atomically: the loser sees the live lease and conflicts.
    if (entry.lease !== undefined) {
      throw new SessionHostRuntimeError(
        SessionHostRuntimeErrors.codes.SESSION_LEASE_CONFLICT,
        `session '${entry.current.ref.sessionId}' already has a live lease in runtime '${this.runtimeId}'`,
        { details: { runtimeId: this.runtimeId, sessionId: entry.current.ref.sessionId } },
      );
    }
    const lease = new MemorySessionLease(
      this.backend,
      entry,
      this.runtimeId,
      this.caps,
      this.contributions,
      (id) => this.catalog.get(id),
      (closed) => {
        if (entry.lease === closed) entry.lease = undefined;
      },
    );
    entry.lease = lease;
    return lease;
  }

  private assertOnline(): void {
    if (this.getStatus() === 'online') return;
    throw new SessionHostRuntimeError(
      SessionHostRuntimeErrors.codes.SESSION_RUNTIME_UNAVAILABLE,
      `session host runtime '${this.runtimeId}' is unavailable (${this.getStatus()})`,
      { details: { runtimeId: this.runtimeId, status: this.getStatus() } },
    );
  }

  private requireEntry(sessionId: string): MemorySessionEntry {
    const entry = this.catalog.get(sessionId);
    if (entry === undefined) {
      throw new Error2(
        ErrorCodes.SESSION_NOT_FOUND,
        `session '${sessionId}' does not exist in runtime '${this.runtimeId}'`,
        { details: { runtimeId: this.runtimeId, sessionId } },
      );
    }
    return entry;
  }

  private assertRevision(entry: MemorySessionEntry, expected: string | undefined): void {
    if (expected === undefined) return;
    if (expected === String(entry.revision)) return;
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `session '${entry.current.ref.sessionId}' revision mismatch: expected ${expected}, current ${entry.revision}`,
      { details: { runtimeId: this.runtimeId, expectedRevision: expected, revision: entry.revision } },
    );
  }

  private async purge(entry: MemorySessionEntry): Promise<void> {
    for (const namespace of entry.namespaces) {
      for (const key of await this.backend.documentBytes.list(namespace)) {
        await this.backend.documentBytes.delete(namespace, key);
      }
      for (const key of await this.backend.blobBytes.list(namespace)) {
        await this.backend.blobBytes.delete(namespace, key);
      }
      this.backend.logs.deleteScope(namespace);
    }
  }

  private async copyNamespace(source: string, target: string): Promise<void> {
    for (const key of await this.backend.documentBytes.list(source)) {
      const bytes = await this.backend.documentBytes.read(source, key);
      if (bytes !== undefined) {
        await this.backend.documentBytes.write(target, key, bytes.slice(), { atomic: true });
      }
    }
    for (const key of await this.backend.blobBytes.list(source)) {
      const bytes = await this.backend.blobBytes.read(source, key);
      if (bytes !== undefined) {
        await this.backend.blobBytes.write(target, key, bytes.slice(), { atomic: true });
      }
    }
    this.backend.logs.copyScope(source, target);
  }
}

function assertValidSessionId(sessionId: string): void {
  if (!isValidIdSegment(sessionId)) {
    throw new Error2(
      ErrorCodes.SESSION_ID_INVALID,
      `invalid session id '${sessionId}': must be a single segment without separators, whitespace or control characters`,
      { details: { sessionId } },
    );
  }
}

/** The engine's session-metadata document key inside the session namespace. */
const ENGINE_STATE_KEY = 'state.json';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function readMetadataString(
  metadata: SameRuntimeForkInput['metadata'],
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readMetadataRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Merge custom metadata for a fork, dropping the `goal` key on both sides —
 * the same rule the engine's legacy fork and the local runtime apply (goal
 * state never crosses forks).
 */
function forkCustomMetadata(
  source: Record<string, unknown> | undefined,
  input: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const merged = { ...withoutGoal(source), ...withoutGoal(input) };
  return Object.keys(merged).length === 0 ? undefined : merged;
}

function withoutGoal(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (value === undefined) return {};
  const { goal: _drop, ...rest } = value as { goal?: unknown; [key: string]: unknown };
  return rest;
}
