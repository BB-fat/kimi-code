/**
 * `localWorkspaceRuntime` domain (L6) — the session-bound views the local
 * workspace runtime hands out: the child lease (`ISessionRuntimeContext`),
 * its persistence context and artifact service, and the cold reader
 * (plan §3.3, §3.6, §4.3).
 *
 * Every view is bound to one runtime + session pair and shares the runtime's
 * `IFileSystemStorageService` (rooted at the app home dir); isolation between
 * sessions (and between agents of a session) comes from the namespace tokens
 * alone, which this runtime mints as the legacy storage scopes
 * `sessions/<wd_id>/<sessionId>[/agents/<agentId>]`. The lease is the
 * session's single writer: `flush` drains every append-log store it created,
 * and `close` flushes then releases the lease registration on the manager —
 * closing a lease never touches the runtime, sibling leases or any on-disk
 * lock (there are no lock files in the legacy layout; the manager's
 * in-process lease map is the concurrency token).
 *
 * Artifact writes land in the existing per-owner `blobs/` convention
 * (`<agentDir>/blobs/` is what `AgentBlobService` already uses; the
 * session-level `<sessionDir>/blobs/` is the same convention one level up).
 * Artifact reads validate the full `ArtifactRef` (runtime, session AND
 * owner) and surface `artifact.owner_mismatch` on any mismatch, through both
 * the lease's service and the cold reader.
 */

import { Error2 } from '#/_base/errors/errors';

import { stat } from 'node:fs/promises';
import { join } from 'pathe';

import { SessionHostRuntimeError, SessionHostRuntimeErrors } from '#/app/sessionHostRuntime/errors';
import type { SessionRuntimeCapability } from '#/app/sessionHostRuntime/sessionHostRuntime';
import type { SessionRef } from '#/app/sessionHostRuntime/sessionRef';
import type {
  AgentDescriptor,
  ArtifactOwner,
  ArtifactRef,
  ColdRecord,
  ColdRecordQuery,
  ISessionArtifactService,
  ISessionColdReader,
  ISessionOsCapabilities,
  ISessionPersistenceContext,
  ISessionRuntimeContext,
  PersistenceNamespace,
  ReadArtifactOptions,
  SessionCloseReason,
  SessionDescriptor,
  SessionRuntimeContributions,
  WriteArtifactOptions,
} from '#/app/sessionHostRuntime/sessionRuntimeContext';
import { ErrorCodes } from '#/errors';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import {
  JsonAtomicDocumentStore,
  TomlAtomicDocumentStore,
} from '#/persistence/backends/node-fs/atomicDocumentStore';
import { BlobStoreService } from '#/persistence/backends/node-fs/blobStoreService';
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import type {
  DocumentCodec,
  IAtomicDocumentStore,
} from '#/persistence/interface/atomicDocumentStore';
import type { IBlobStore } from '#/persistence/interface/blobStore';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';
import {
  makeSessionHostFiles,
  type ISessionHostFiles,
} from '#/session/sessionHostFiles/sessionHostFiles';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import {
  agentScopeOf,
  descriptorOf,
  isValidIdSegment,
  readStateDocument,
  sessionScopeOf,
  type StateDocument,
} from './localWorkspaceLayout';

/* ------------------------------------------------------------------------ */
/* Shared helpers                                                           */
/* ------------------------------------------------------------------------ */

export function readableStreamFromIterable(
  source: AsyncIterable<Uint8Array>,
): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await iterator.next();
      if (done === true) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

/**
 * Blob scope + key addressing of an artifact: the existing per-owner `blobs/`
 * directory (`AgentBlobService` writes `<agentDir>/blobs/<sha256>` through
 * `scope('blobs')`), with the single-segment artifact id as the key.
 */
export function artifactBlobScope(
  workspaceId: string,
  sessionId: string,
  owner: ArtifactOwner,
): string {
  return `${scopeForOwner(workspaceId, sessionId, owner)}/blobs`;
}

function scopeForOwner(
  workspaceId: string,
  sessionId: string,
  owner: ArtifactOwner,
): PersistenceNamespace {
  return owner.kind === 'session'
    ? sessionScopeOf(workspaceId, sessionId)
    : agentScopeOf(workspaceId, sessionId, owner.agentId);
}

function assertValidOwner(owner: ArtifactOwner): void {
  if (owner.kind === 'agent' && !isValidIdSegment(owner.agentId)) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `invalid agent id '${owner.agentId}': must be a single segment without separators, whitespace or control characters`,
    );
  }
}

function ownerMismatch(ref: ArtifactRef, bound: SessionRef): SessionHostRuntimeError {
  return new SessionHostRuntimeError(
    SessionHostRuntimeErrors.codes.ARTIFACT_OWNER_MISMATCH,
    `artifact '${ref.artifactId}' does not match an artifact owned by session '${bound.sessionId}' of runtime '${bound.runtimeId}'`,
    { details: { ref, bound } },
  );
}

/**
 * Validates the ref against the bound runtime + session and streams the
 * stored artifact bytes; every miss — wrong runtime, wrong session, wrong
 * owner or unknown artifact — surfaces `artifact.owner_mismatch`, so a ref
 * never routes across sessions, runtimes or owners. Shared by the lease's
 * artifact service and the cold reader.
 */
export async function readLocalArtifact(
  storage: IFileSystemStorageService,
  workspaceId: string,
  bound: SessionRef,
  ref: ArtifactRef,
  options?: ReadArtifactOptions,
): Promise<ReadableStream<Uint8Array>> {
  if (ref.runtimeId !== bound.runtimeId || ref.sessionId !== bound.sessionId) {
    throw ownerMismatch(ref, bound);
  }
  if (ref.owner.kind === 'agent' && !isValidIdSegment(ref.owner.agentId)) {
    throw ownerMismatch(ref, bound);
  }
  const scope = artifactBlobScope(workspaceId, bound.sessionId, ref.owner);
  if (!(await exists(storage, scope, ref.artifactId))) throw ownerMismatch(ref, bound);
  if (options?.range !== undefined && options.range.end <= options.range.start) {
    return readableStreamFromIterable(emptyBytes());
  }
  const range =
    options?.range === undefined
      ? undefined
      : // `IFileSystemStorageService.readStream` ranges are inclusive-end;
        // the contract's range is half-open `[start, end)`.
        { start: Math.max(0, options.range.start), end: options.range.end - 1 };
  return readableStreamFromIterable(storage.readStream(scope, ref.artifactId, range));
}

async function* emptyBytes(): AsyncIterable<Uint8Array> {
  // An empty artifact range yields no chunks.
}

async function exists(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
): Promise<boolean> {
  return (await storage.list(scope, key)).includes(key);
}

/* ------------------------------------------------------------------------ */
/* Persistence context                                                      */
/* ------------------------------------------------------------------------ */

/**
 * The lease's persistence factory. Namespace tokens are minted from the
 * legacy scopes and validated on the way back in; the typed Stores are the
 * existing node-fs adapters over the runtime's shared storage. Documents in
 * the legacy layout are JSON (`state.json`, task records); TOML is accepted
 * for parity with the App-level stores, anything else fails validation
 * instead of silently writing a foreign format into the legacy files.
 * Append logs are JSONL by layout definition (`wire.jsonl` framing).
 */
class LocalPersistenceContext implements ISessionPersistenceContext {
  private readonly minted = new Set<string>();
  private readonly documentStores = new Map<string, IAtomicDocumentStore>();
  private readonly logStores = new Map<string, IAppendLogStore>();

  constructor(
    private readonly storage: IFileSystemStorageService,
    private readonly workspaceId: string,
    private readonly sessionId: string,
    private readonly blobStore: IBlobStore,
    /** Every append-log store created here, so the lease can flush them. */
    private readonly createdLogStores: IAppendLogStore[],
  ) {}

  sessionNamespace(): PersistenceNamespace {
    return this.mint(sessionScopeOf(this.workspaceId, this.sessionId));
  }

  agentNamespace(agentId: string): PersistenceNamespace {
    if (!isValidIdSegment(agentId)) {
      throw new Error2(
        ErrorCodes.VALIDATION_FAILED,
        `invalid agent id '${agentId}': must be a single segment without separators, whitespace or control characters`,
      );
    }
    return this.mint(agentScopeOf(this.workspaceId, this.sessionId, agentId));
  }

  documents(namespace: PersistenceNamespace, codec: DocumentCodec): IAtomicDocumentStore {
    this.assertMinted(namespace);
    let store = this.documentStores.get(codec.format);
    if (store === undefined) {
      if (codec.format === 'json') {
        store = new JsonAtomicDocumentStore(this.storage);
      } else if (codec.format === 'toml') {
        store = new TomlAtomicDocumentStore(this.storage);
      } else {
        throw new Error2(
          ErrorCodes.VALIDATION_FAILED,
          `unsupported document codec '${codec.format}': the local session layout stores JSON documents`,
        );
      }
      this.documentStores.set(codec.format, store);
    }
    return store;
  }

  logs(namespace: PersistenceNamespace, codec: DocumentCodec): IAppendLogStore {
    this.assertMinted(namespace);
    if (codec.format !== 'json') {
      throw new Error2(
        ErrorCodes.VALIDATION_FAILED,
        `unsupported log codec '${codec.format}': the local session layout frames records as JSONL`,
      );
    }
    let store = this.logStores.get(namespace);
    if (store === undefined) {
      // One AppendLogStore per lease + namespace: its per-key buffers are the
      // session's write queue, so they must be owned (and flushed) per lease,
      // never shared across sessions.
      store = new AppendLogStore(this.storage);
      this.logStores.set(namespace, store);
      this.createdLogStores.push(store);
    }
    return store;
  }

  blobs(namespace: PersistenceNamespace): IBlobStore {
    this.assertMinted(namespace);
    return this.blobStore;
  }

  private mint(namespace: PersistenceNamespace): PersistenceNamespace {
    this.minted.add(namespace);
    return namespace;
  }

  private assertMinted(namespace: PersistenceNamespace): void {
    if (this.minted.has(namespace)) return;
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `persistence namespace '${namespace}' was not minted by this session's lease`,
    );
  }
}

/* ------------------------------------------------------------------------ */
/* Artifact service                                                         */
/* ------------------------------------------------------------------------ */

class LocalArtifactService implements ISessionArtifactService {
  constructor(
    private readonly storage: IFileSystemStorageService,
    private readonly workspaceId: string,
    private readonly bound: SessionRef,
    private readonly blobs: IBlobStore,
  ) {}

  async write(
    owner: ArtifactOwner,
    artifactId: string,
    source: AsyncIterable<Uint8Array>,
    _options?: WriteArtifactOptions,
  ): Promise<ArtifactRef> {
    assertValidOwner(owner);
    if (!isValidIdSegment(artifactId)) {
      throw new Error2(
        ErrorCodes.VALIDATION_FAILED,
        `invalid artifact id '${artifactId}': must be a single segment without separators, whitespace or control characters`,
      );
    }
    const scope = artifactBlobScope(this.workspaceId, this.bound.sessionId, owner);
    await this.blobs.putStream(scope, artifactId, source);
    // No version is minted: the legacy layout has no per-blob version record
    // and the runtime must not add one (plan §4.3). Readers address the
    // artifact by id; content changes are whole-value replacements.
    return {
      runtimeId: this.bound.runtimeId,
      sessionId: this.bound.sessionId,
      owner,
      artifactId,
    };
  }

  async read(ref: ArtifactRef, options?: ReadArtifactOptions): Promise<ReadableStream<Uint8Array>> {
    return readLocalArtifact(this.storage, this.workspaceId, this.bound, ref, options);
  }
}

/* ------------------------------------------------------------------------ */
/* Cold reader                                                              */
/* ------------------------------------------------------------------------ */

export class LocalSessionColdReader implements ISessionColdReader {
  constructor(
    private readonly storage: IFileSystemStorageService,
    private readonly workspaceId: string,
    private readonly bound: SessionRef,
    /** App home dir the legacy layout is rooted at (stat facts for revisions). */
    private readonly homeDir?: string,
  ) {}

  async descriptor(): Promise<SessionDescriptor> {
    const state = await this.requireState();
    return descriptorOf(this.bound.runtimeId, state.meta, state.revision);
  }

  async listAgents(): Promise<readonly AgentDescriptor[]> {
    const state = await this.requireState();
    const fromMeta = Object.entries(state.meta.agents ?? {}).map(([agentId, meta]) => ({
      agentId,
      role: meta.type,
      metadata: (meta.labels ?? {}) as Record<string, unknown>,
    }));
    if (fromMeta.length > 0) return fromMeta;
    // Legacy documents written before the roster was seeded: fall back to the
    // agents/ directory enumeration — a read-only tolerance, not an importer.
    const entries = await this.storage.list(
      `${sessionScopeOf(this.workspaceId, this.bound.sessionId)}/agents`,
    );
    return entries
      .filter((entry) => isValidIdSegment(entry))
      .map((agentId) => ({ agentId, metadata: {} }));
  }

  async *readRecords(query: ColdRecordQuery): AsyncIterable<ColdRecord> {
    const state = await this.requireState();
    // The legacy layout keeps JSONL record logs at the AGENT level
    // (`wire.jsonl`); there is no session-level record log — session-level
    // facts are the `state.json` document and the plain-text `logs/` files,
    // which the export carries as blobs instead.
    if (query.agentId === undefined) return;
    const scope = agentScopeOf(this.workspaceId, this.bound.sessionId, query.agentId);
    // A fresh store over the shared storage reads with the engine's own
    // crash-tolerant JSONL framing (torn final line dropped).
    const logs = new AppendLogStore(this.storage);
    let yielded = 0;
    for await (const record of logs.read<WireRecord>(scope, AGENT_WIRE_RECORD_KEY)) {
      const kind = record.type;
      if (query.kind !== undefined && kind !== query.kind) continue;
      const timestamp =
        typeof record.time === 'number' && Number.isFinite(record.time)
          ? new Date(record.time).toISOString()
          : new Date(state.meta.createdAt).toISOString();
      yield { kind, timestamp, data: record };
      yielded++;
      if (query.limit !== undefined && yielded >= query.limit) return;
    }
  }

  async readArtifact(
    ref: ArtifactRef,
    options?: ReadArtifactOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    return readLocalArtifact(this.storage, this.workspaceId, this.bound, ref, options);
  }

  /**
   * The wire journal's revision token, derived from the existing file facts
   * (`size:mtimeMs`) — no watermark file is added (plan §5.9). `undefined`
   * when the agent has no journal yet or the cold reader was built without a
   * home dir.
   */
  async recordsRevision(agentId: string): Promise<string | undefined> {
    if (this.homeDir === undefined || !isValidIdSegment(agentId)) return undefined;
    try {
      const info = await stat(
        join(
          this.homeDir,
          agentScopeOf(this.workspaceId, this.bound.sessionId, agentId),
          AGENT_WIRE_RECORD_KEY,
        ),
      );
      return `${info.size}:${info.mtimeMs}`;
    } catch {
      return undefined;
    }
  }

  private async requireState(): Promise<StateDocument> {
    const state = await readStateDocument(
      this.storage,
      sessionScopeOf(this.workspaceId, this.bound.sessionId),
      this.bound.sessionId,
    );
    if (state === undefined) {
      throw new Error2(
        ErrorCodes.SESSION_NOT_FOUND,
        `session '${this.bound.sessionId}' does not exist in runtime '${this.bound.runtimeId}'`,
      );
    }
    return state;
  }
}

/* ------------------------------------------------------------------------ */
/* The lease                                                                */
/* ------------------------------------------------------------------------ */

/**
 * The manager's view of a live child lease, so force-delete and runtime close
 * can drive its lifecycle. `flush` lets same-runtime fork/export snapshot a
 * consistent cut of a session that still has a live writer.
 */
export interface LocalLeaseHandle {
  flush(): Promise<void>;
  closeFromManager(reason: SessionCloseReason): Promise<void>;
}

/**
 * The local child lease. `close` flushes the lease's append-log stores before
 * releasing the registration, so a failed flush keeps the lease open and the
 * close can be retried (plan §9.3). The closing paths of the manager
 * (force-delete, runtime close) go through `closeFromManager`, which shares
 * the same flush-first ordering.
 */
export class LocalSessionLease implements ISessionRuntimeContext, LocalLeaseHandle {
  readonly ref: SessionRef;
  readonly descriptor: SessionDescriptor;
  readonly persistence: LocalPersistenceContext;
  readonly artifacts: LocalArtifactService;
  readonly coldReader: LocalSessionColdReader;
  readonly capabilities: ReadonlySet<SessionRuntimeCapability>;
  readonly contributions: SessionRuntimeContributions;
  readonly os?: ISessionOsCapabilities;
  readonly hostFiles: ISessionHostFiles;

  private readonly logStores: IAppendLogStore[] = [];
  private closed = false;

  constructor(
    storage: IFileSystemStorageService,
    workspaceId: string,
    cwd: string,
    state: StateDocument,
    runtimeId: string,
    capabilities: ReadonlySet<SessionRuntimeCapability>,
    contributions: SessionRuntimeContributions,
    osHandles: Omit<ISessionOsCapabilities, 'cwd'>,
    homeDir: string,
    private readonly onClosed: (lease: LocalSessionLease) => void,
  ) {
    this.ref = { runtimeId, sessionId: state.meta.id };
    this.descriptor = descriptorOf(runtimeId, state.meta, state.revision);
    const blobs = new BlobStoreService(storage);
    this.persistence = new LocalPersistenceContext(
      storage,
      workspaceId,
      this.ref.sessionId,
      blobs,
      this.logStores,
    );
    this.artifacts = new LocalArtifactService(storage, workspaceId, this.ref, blobs);
    this.coldReader = new LocalSessionColdReader(storage, workspaceId, this.ref, homeDir);
    this.capabilities = capabilities;
    this.contributions = contributions;
    // The workspace root plus the runtime's shared node-local host services
    // (plan §7.4): runtime-level resources, shared by every session lease and
    // never disposed per session.
    this.os = { cwd, ...osHandles };
    // The typed host-files capability (plan §7.2): the local runtime genuinely
    // owns this session's legacy host directory, so the lease carries the real
    // paths for the file-bound consumers (session log, plan working documents,
    // media originals, task display paths, the `homedir` metadata field).
    this.hostFiles = makeSessionHostFiles({
      workspaceId,
      sessionDir: join(homeDir, sessionScopeOf(workspaceId, this.ref.sessionId)),
    });
  }

  get closedLease(): boolean {
    return this.closed;
  }

  async flush(): Promise<void> {
    if (this.closed) return;
    for (const store of this.logStores) {
      await store.flush();
    }
  }

  async close(_reason: SessionCloseReason): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
    this.onClosed(this);
  }

  closeFromManager(reason: SessionCloseReason): Promise<void> {
    return this.close(reason);
  }
}
