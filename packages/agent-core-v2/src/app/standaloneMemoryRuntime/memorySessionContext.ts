/**
 * `standaloneMemoryRuntime` domain (L4) — the session-bound views the memory
 * host runtime hands out: the child lease (`ISessionRuntimeContext`), its
 * persistence context and artifact service, and the cold reader (plan §3.3,
 * §3.6).
 *
 * Every view is bound to one runtime + session pair and shares the runtime's
 * `MemorySessionBackend`; isolation between sessions (and between agents of a
 * session) comes from the namespace tokens alone. The lease is the session's
 * single writer: `flush` drains every append-log store it created, and
 * `close` flushes then releases the lease registration on the catalog entry —
 * closing a lease never touches the runtime or sibling leases. Artifact reads
 * validate the full `ArtifactRef` (runtime, session AND owner) and surface
 * `artifact.owner_mismatch` on any mismatch, through both the lease's service
 * and the cold reader.
 */

import { Error2 } from '#/_base/errors/errors';

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
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import type {
  DocumentCodec,
  IAtomicDocumentStore,
} from '#/persistence/interface/atomicDocumentStore';
import type { IBlobStore } from '#/persistence/interface/blobStore';
import {
  InMemoryAppendLogStore,
  InMemoryAtomicDocumentStore,
  InMemoryBlobStore,
} from '#/persistence/backends/memory/inMemoryStores';

import {
  agentNamespaceOf,
  artifactBlobKey,
  artifactOwnerTag,
  isValidIdSegment,
  namespaceForOwner,
  sessionNamespaceOf,
  type MemoryLeaseHandle,
  type MemorySessionBackend,
  type MemorySessionEntry,
} from './memoryBackend';

const textDecoder = new TextDecoder();

export async function concatChunks(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of source) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

export function cloneDescriptor(descriptor: SessionDescriptor): SessionDescriptor {
  return { ...descriptor, metadata: structuredClone(descriptor.metadata) };
}

class MemoryPersistenceContext implements ISessionPersistenceContext {
  private readonly documentStores = new Map<string, InMemoryAtomicDocumentStore>();
  private readonly logStoreCache = new Map<string, InMemoryAppendLogStore>();
  private readonly blobStores = new Map<string, InMemoryBlobStore>();

  constructor(
    private readonly backend: MemorySessionBackend,
    private readonly entry: MemorySessionEntry,
    private readonly sessionId: string,
    private readonly logStores: InMemoryAppendLogStore[],
  ) {}

  sessionNamespace(): PersistenceNamespace {
    return this.mint(sessionNamespaceOf(this.sessionId));
  }

  agentNamespace(agentId: string): PersistenceNamespace {
    if (!isValidIdSegment(agentId)) {
      throw new Error2(
        ErrorCodes.VALIDATION_FAILED,
        `invalid agent id '${agentId}': must be a single segment without separators, whitespace or control characters`,
      );
    }
    this.entry.agents.add(agentId);
    return this.mint(agentNamespaceOf(this.sessionId, agentId));
  }

  documents(namespace: PersistenceNamespace, codec: DocumentCodec): IAtomicDocumentStore {
    this.assertMinted(namespace);
    const cacheId = `${namespace} ${codec.format}`;
    let store = this.documentStores.get(cacheId);
    if (store === undefined) {
      store = new InMemoryAtomicDocumentStore(this.backend.documentBytes, codec);
      this.documentStores.set(cacheId, store);
    }
    return store;
  }

  logs(namespace: PersistenceNamespace, codec: DocumentCodec): IAppendLogStore {
    this.assertMinted(namespace);
    const cacheId = `${namespace} ${codec.format}`;
    let store = this.logStoreCache.get(cacheId);
    if (store === undefined) {
      store = new InMemoryAppendLogStore(this.backend.logs, codec);
      this.logStoreCache.set(cacheId, store);
      this.logStores.push(store);
    }
    return store;
  }

  blobs(namespace: PersistenceNamespace): IBlobStore {
    this.assertMinted(namespace);
    let store = this.blobStores.get(namespace);
    if (store === undefined) {
      store = new InMemoryBlobStore(this.backend.blobBytes);
      this.blobStores.set(namespace, store);
    }
    return store;
  }

  private mint(namespace: PersistenceNamespace): PersistenceNamespace {
    this.entry.namespaces.add(namespace);
    return namespace;
  }

  private assertMinted(namespace: PersistenceNamespace): void {
    if (this.entry.namespaces.has(namespace)) return;
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `persistence namespace '${namespace}' was not minted by this session's lease`,
    );
  }
}

/**
 * Validates the ref against the bound runtime + session and returns the
 * stored artifact bytes; every miss — wrong runtime, wrong session, wrong
 * owner or unknown artifact — surfaces `artifact.owner_mismatch`, so a ref
 * never routes across sessions, runtimes or owners.
 */
export async function readArtifactBytes(
  backend: MemorySessionBackend,
  ref: ArtifactRef,
  bound: SessionRef,
  options?: ReadArtifactOptions,
): Promise<Uint8Array> {
  const mismatch = (): SessionHostRuntimeError =>
    new SessionHostRuntimeError(
      SessionHostRuntimeErrors.codes.ARTIFACT_OWNER_MISMATCH,
      `artifact '${ref.artifactId}' does not match an artifact owned by session '${bound.sessionId}' of runtime '${bound.runtimeId}'`,
      { details: { ref, bound } },
    );
  if (ref.runtimeId !== bound.runtimeId || ref.sessionId !== bound.sessionId) throw mismatch();
  const namespace = namespaceForOwner(bound.sessionId, ref.owner);
  const bytes = await backend.blobBytes.read(namespace, artifactBlobKey(ref.artifactId));
  if (bytes === undefined) throw mismatch();
  if (options?.range === undefined) return bytes;
  const start = Math.max(0, options.range.start);
  const end = Math.min(bytes.byteLength, options.range.end);
  return bytes.subarray(start, Math.max(start, end));
}

class MemoryArtifactService implements ISessionArtifactService {
  constructor(
    private readonly backend: MemorySessionBackend,
    private readonly entry: MemorySessionEntry,
    private readonly bound: SessionRef,
  ) {}

  async write(
    owner: ArtifactOwner,
    artifactId: string,
    source: AsyncIterable<Uint8Array>,
    _options?: WriteArtifactOptions,
  ): Promise<ArtifactRef> {
    if (owner.kind === 'agent' && !isValidIdSegment(owner.agentId)) {
      throw new Error2(
        ErrorCodes.VALIDATION_FAILED,
        `invalid agent id '${owner.agentId}': must be a single segment without separators, whitespace or control characters`,
      );
    }
    const bytes = await concatChunks(source);
    const namespace = namespaceForOwner(this.bound.sessionId, owner);
    this.entry.namespaces.add(namespace);
    if (owner.kind === 'agent') this.entry.agents.add(owner.agentId);
    await this.backend.blobBytes.write(namespace, artifactBlobKey(artifactId), bytes, {
      atomic: true,
    });
    const tag = `${artifactOwnerTag(owner)}/${artifactId}`;
    const version = (this.entry.artifactVersions.get(tag) ?? 0) + 1;
    this.entry.artifactVersions.set(tag, version);
    return {
      runtimeId: this.bound.runtimeId,
      sessionId: this.bound.sessionId,
      owner,
      artifactId,
      version: String(version),
    };
  }

  async read(ref: ArtifactRef, options?: ReadArtifactOptions): Promise<ReadableStream<Uint8Array>> {
    return streamFromBytes(await readArtifactBytes(this.backend, ref, this.bound, options));
  }
}

export class MemorySessionColdReader implements ISessionColdReader {
  constructor(
    private readonly backend: MemorySessionBackend,
    private readonly bound: SessionRef,
    private readonly lookup: (sessionId: string) => MemorySessionEntry | undefined,
  ) {}

  async descriptor(): Promise<SessionDescriptor> {
    return cloneDescriptor(this.requireEntry().current);
  }

  async listAgents(): Promise<readonly AgentDescriptor[]> {
    return [...this.requireEntry().agents].map((agentId) => ({ agentId, metadata: {} }));
  }

  async *readRecords(query: ColdRecordQuery): AsyncIterable<ColdRecord> {
    const entry = this.requireEntry();
    const namespaces = [
      query.agentId === undefined
        ? sessionNamespaceOf(this.bound.sessionId)
        : agentNamespaceOf(this.bound.sessionId, query.agentId),
    ];
    let yielded = 0;
    for (const namespace of namespaces) {
      for (const key of this.backend.logs.list(namespace)) {
        for (const recordBytes of this.backend.logs.entries(namespace, key)) {
          // Cold-read convention of THIS runtime: stored records are projected
          // through the JSON codec — every store this runtime hands out for
          // record logs is used with JSON-compatible values (wire records),
          // and the export/import data plane keeps the same bytes. Records
          // written through another codec family are not cold-readable here.
          // `kind`/`timestamp` project the conventional `type`/`time` fields.
          const record: unknown = JSON.parse(textDecoder.decode(recordBytes));
          const data = record as { readonly type?: unknown; readonly time?: unknown };
          const kind = typeof data?.type === 'string' ? data.type : 'record';
          if (query.kind !== undefined && kind !== query.kind) continue;
          const timestamp =
            typeof data?.time === 'number' && Number.isFinite(data.time)
              ? new Date(data.time).toISOString()
              : entry.current.createdAt;
          yield { kind, timestamp, data: record };
          yielded++;
          if (query.limit !== undefined && yielded >= query.limit) return;
        }
      }
    }
  }

  async readArtifact(
    ref: ArtifactRef,
    options?: ReadArtifactOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    return streamFromBytes(await readArtifactBytes(this.backend, ref, this.bound, options));
  }

  private requireEntry(): MemorySessionEntry {
    const entry = this.lookup(this.bound.sessionId);
    if (entry === undefined) {
      throw new Error2(
        ErrorCodes.SESSION_NOT_FOUND,
        `session '${this.bound.sessionId}' does not exist in runtime '${this.bound.runtimeId}'`,
      );
    }
    return entry;
  }
}

/**
 * The memory child lease. `close` flushes the lease's append-log stores before
 * releasing the registration, so a failed flush keeps the lease open and the
 * close can be retried (plan §9.3). The closing paths of the manager
 * (force-delete, runtime close) go through `closeFromManager`, which shares
 * the same flush-first ordering.
 */
export class MemorySessionLease implements ISessionRuntimeContext, MemoryLeaseHandle {
  readonly ref: SessionRef;
  readonly descriptor: SessionDescriptor;
  readonly persistence: MemoryPersistenceContext;
  readonly artifacts: MemoryArtifactService;
  readonly coldReader: MemorySessionColdReader;
  readonly capabilities: ReadonlySet<SessionRuntimeCapability>;
  readonly contributions: SessionRuntimeContributions;

  private readonly logStores: InMemoryAppendLogStore[] = [];
  private closed = false;

  constructor(
    backend: MemorySessionBackend,
    entry: MemorySessionEntry,
    runtimeId: string,
    capabilities: ReadonlySet<SessionRuntimeCapability>,
    contributions: SessionRuntimeContributions,
    lookup: (sessionId: string) => MemorySessionEntry | undefined,
    private readonly onClosed: (lease: MemorySessionLease) => void,
  ) {
    this.ref = { runtimeId, sessionId: entry.current.ref.sessionId };
    this.descriptor = cloneDescriptor(entry.current);
    this.persistence = new MemoryPersistenceContext(backend, entry, this.ref.sessionId, this.logStores);
    this.artifacts = new MemoryArtifactService(backend, entry, this.ref);
    this.coldReader = new MemorySessionColdReader(backend, this.ref, lookup);
    this.capabilities = capabilities;
    this.contributions = contributions;
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
