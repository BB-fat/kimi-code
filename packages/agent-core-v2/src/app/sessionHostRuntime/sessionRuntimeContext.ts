/**
 * `sessionHostRuntime` domain — the per-session runtime context / child lease
 * and the pathless descriptor / cold-read / artifact contracts (plan §3.3,
 * §3.6).
 *
 * `runtime.sessions.open/resume` either returns a complete
 * `ISessionRuntimeContext` or fails (`session.open_failed`): persistence
 * namespaces and typed Stores, artifact service, cold reader, capabilities,
 * contributions and the session's flush/close lifecycle all arrive with the
 * lease. Session Core consumes ONLY this injected context — it never looks up
 * storage, cold readers, artifact services or OS providers from the App
 * container afterwards, and it never sees Workspace registrations.
 *
 * Everything here is pathless (plan §1.4): persistence is addressed by opaque
 * `PersistenceNamespace` tokens, artifacts by `ArtifactRef`, and export by
 * logical stream entries. How a namespace or artifact maps to physical
 * storage is the owning runtime's private business.
 */

import { Error2 } from '#/_base/errors/errors';
import { CoreErrors } from '#/_base/errors/codes';
import type {
  DocumentCodec,
  IAtomicDocumentStore,
} from '#/persistence/interface/atomicDocumentStore';
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import type { IBlobStore } from '#/persistence/interface/blobStore';

import type { SessionRuntimeCapability } from './sessionHostRuntime';
import type { SessionRef } from './sessionRef';

/* ------------------------------------------------------------------------ */
/* Persistence namespaces                                                    */
/* ------------------------------------------------------------------------ */

declare const persistenceNamespaceBrand: unique symbol;

/**
 * Opaque, validated persistence addressing token issued by a runtime lease
 * (plan §3.6). Business code can pass it back to the lease's Store factories
 * but cannot derive physical directories (or anything else) from it — the
 * string form is an implementation detail of the issuing runtime.
 */
export type PersistenceNamespace = string & {
  readonly [persistenceNamespaceBrand]: 'PersistenceNamespace';
};

/**
 * Validate raw segments into a `PersistenceNamespace`. This is the ONLY
 * construction site runtimes should use; it exists so a malformed namespace
 * (empty segments, `.`/`..`, backslashes) fails at the boundary instead of
 * deep inside a Store backend. It deliberately expresses no layout semantics.
 */
export function toPersistenceNamespace(value: string): PersistenceNamespace {
  const segments = value.split('/');
  const valid =
    value.length > 0 &&
    !value.includes('\\') &&
    segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
  if (!valid) {
    throw new Error2(
      CoreErrors.codes.VALIDATION_FAILED,
      `invalid persistence namespace '${value}'`,
    );
  }
  return value as PersistenceNamespace;
}

/* ------------------------------------------------------------------------ */
/* Descriptor & metadata                                                     */
/* ------------------------------------------------------------------------ */

/**
 * Logical, runtime-owned session metadata (plan §1.4/§3.2: `get/list` return
 * logical metadata only — never physical storage facts). The generic contract
 * fixes no field set; each runtime family documents the fields it persists
 * and the kap-server v1 edge projects its own wire metadata onto them.
 */
export type SessionMetadata = Readonly<Record<string, unknown>>;

/** Partial logical metadata applied by `ISessionManager.update`. */
export type SessionMetadataPatch = Readonly<Record<string, unknown>>;

/** Stored lifecycle state of a session inside its runtime. */
export type SessionStoredStatus = 'active' | 'archived';

/**
 * The logical identity + metadata record of one session (plan §3.6). Always
 * carries the full `SessionRef`; every session hosted by the same runtime
 * shares its `ref.runtimeId`.
 */
export interface SessionDescriptor {
  readonly ref: SessionRef;
  /** ISO date-time strings. */
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: SessionStoredStatus;
  readonly metadata: SessionMetadata;
  /** Runtime-internal optimistic-concurrency marker, when the runtime has one. */
  readonly revision?: string;
}

/* ------------------------------------------------------------------------ */
/* Artifacts                                                                 */
/* ------------------------------------------------------------------------ */

/** Which namespace of a session owns an artifact. */
export type ArtifactOwner =
  | { readonly kind: 'session' }
  | { readonly kind: 'agent'; readonly agentId: string };

/**
 * Pathless artifact identity (plan §3.6). Routable back to the owning
 * runtime through `runtimeId`; the owning runtime validates runtime, session
 * AND owner on every read (`artifact.owner_mismatch` on mismatch).
 */
export interface ArtifactRef {
  readonly runtimeId: string;
  readonly sessionId: string;
  readonly owner: ArtifactOwner;
  readonly artifactId: string;
  readonly version?: string;
}

export interface ReadArtifactOptions {
  /** Byte range `[start, end)` for partial reads. */
  readonly range?: { readonly start: number; readonly end: number };
}

export interface WriteArtifactOptions {
  readonly contentType?: string;
}

/**
 * The per-session artifact read/write service handed out by the lease
 * (plan §3.3/§5.10). Writes return the `ArtifactRef` callers persist;
 * `readArtifact` on the cold reader is the uniform full-content entry point
 * for models, UI and export.
 */
export interface ISessionArtifactService {
  write(
    owner: ArtifactOwner,
    artifactId: string,
    source: AsyncIterable<Uint8Array>,
    options?: WriteArtifactOptions,
  ): Promise<ArtifactRef>;
  read(ref: ArtifactRef, options?: ReadArtifactOptions): Promise<ReadableStream<Uint8Array>>;
}

/* ------------------------------------------------------------------------ */
/* Cold read                                                                 */
/* ------------------------------------------------------------------------ */

/** Logical descriptor of one agent of a stored session. */
export interface AgentDescriptor {
  readonly agentId: string;
  readonly role?: string;
  readonly metadata: SessionMetadata;
}

export interface ColdRecordQuery {
  /** Restrict to one agent's records; absent reads session-level records. */
  readonly agentId?: string;
  /** Restrict to one logical record kind. */
  readonly kind?: string;
  readonly limit?: number;
}

/** One logical stored record, projected by the owning runtime. */
export interface ColdRecord {
  readonly kind: string;
  /** ISO date-time string. */
  readonly timestamp: string;
  readonly data: unknown;
}

/**
 * Read-only access to a session without opening a live lease (plan §3.6).
 * Always obtained from the owning runtime (`runtime.sessions.coldRead`) or an
 * active lease — never assembled by the edge. After a live lease flushes, the
 * cold reader must observe the same or a higher revision.
 */
export interface ISessionColdReader {
  descriptor(): Promise<SessionDescriptor>;
  listAgents(): Promise<readonly AgentDescriptor[]>;
  readRecords(query: ColdRecordQuery): AsyncIterable<ColdRecord>;
  readArtifact(ref: ArtifactRef, options?: ReadArtifactOptions): Promise<ReadableStream<Uint8Array>>;
}

/* ------------------------------------------------------------------------ */
/* Contributions                                                             */
/* ------------------------------------------------------------------------ */

/**
 * M0 contribution descriptor: a Session/Agent service a runtime wants
 * projected into sessions it hosts. `requires` gates activation on the
 * runtime capability set (plan §7.4). The concrete binding to the DI service
 * registry (identifiers + constructors) is defined when the scope-assembly
 * milestone lands; until then contributions are opaque to Session Core.
 */
export interface ScopedServiceContribution {
  readonly id: string;
  readonly requires: readonly SessionRuntimeCapability[];
}

/** M0 tool contribution descriptor — same gating contract as services. */
export interface ToolContribution {
  readonly name: string;
  readonly requires: readonly SessionRuntimeCapability[];
}

/** What a runtime projects into one session at lease time (plan §3.3). */
export interface SessionRuntimeContributions {
  readonly sessionServices: readonly ScopedServiceContribution[];
  readonly agentServices: readonly ScopedServiceContribution[];
  readonly tools: readonly ToolContribution[];
}

/**
 * Optional OS capability handles a runtime may expose on a session lease
 * (plan §3.3). Headless runtimes leave `ISessionRuntimeContext.os` undefined.
 * The concrete handle set (filesystem/process/terminal/watch/stdio) is
 * defined with the OS-contribution milestone; M0 keeps it opaque so the
 * generic contract stays free of host-OS types.
 */
export type ISessionOsCapabilities = Readonly<Record<string, unknown>>;

/* ------------------------------------------------------------------------ */
/* Persistence context                                                       */
/* ------------------------------------------------------------------------ */

/**
 * The per-session persistence factory handed out by the lease (plan §3.3).
 * Namespaces isolate sessions (and agents within a session) from each other;
 * the returned Stores are bound to the requested namespace by the runtime.
 * The typed Store contracts are the existing `persistence/interface` ones —
 * runtimes adapt their backends to them, business code never addresses
 * physical storage.
 */
export interface ISessionPersistenceContext {
  sessionNamespace(): PersistenceNamespace;
  agentNamespace(agentId: string): PersistenceNamespace;
  documents(namespace: PersistenceNamespace, codec: DocumentCodec): IAtomicDocumentStore;
  logs(namespace: PersistenceNamespace, codec: DocumentCodec): IAppendLogStore;
  blobs(namespace: PersistenceNamespace): IBlobStore;
}

/* ------------------------------------------------------------------------ */
/* Session runtime context / child lease                                     */
/* ------------------------------------------------------------------------ */

/** Why a session child lease is closing (plan §5.4). Never closes the runtime. */
export type SessionCloseReason =
  /** The caller explicitly closed the session handle. */
  | 'explicit'
  /** The hosting process is shutting down (ordered before runtime close). */
  | 'shutdown'
  /** The session is being deleted from its runtime. */
  | 'deleted'
  /** The owning runtime went away; the session enters suspended/failed. */
  | 'runtime_lost';

/**
 * The complete per-session context a runtime opens (plan §3.3). Closing the
 * lease releases only this session's locks, tokens and namespace handles —
 * sibling sessions and the shared runtime keep running, and closing the LAST
 * session still does not unregister the runtime.
 *
 * The plan's `extends AsyncDisposable` is intentionally dropped at M0: the
 * repo tsconfig targets `lib: ES2023`, where the `AsyncDisposable` type does
 * not exist. `close(reason)` carries the lifecycle for now; revisit when the
 * toolchain ships the esnext.disposable lib.
 */
export interface ISessionRuntimeContext {
  readonly ref: SessionRef;
  readonly descriptor: SessionDescriptor;
  readonly persistence: ISessionPersistenceContext;
  readonly artifacts: ISessionArtifactService;
  readonly coldReader: ISessionColdReader;
  readonly capabilities: ReadonlySet<SessionRuntimeCapability>;
  readonly contributions: SessionRuntimeContributions;
  readonly os?: ISessionOsCapabilities;

  flush(): Promise<void>;
  close(reason: SessionCloseReason): Promise<void>;
}

/**
 * The child-lease view of the same object (plan §1.5): one type, two names —
 * `context` when the emphasis is the injected capability bundle, `lease` when
 * the emphasis is the held per-session concurrency/lifecycle token.
 */
export type ISessionRuntimeLease = ISessionRuntimeContext;
