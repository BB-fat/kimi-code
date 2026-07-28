/**
 * `sessionHostRuntime` domain — the multi-session manager contract
 * (plan §3.2).
 *
 * `ISessionManager` is ALWAYS reached as `runtime.sessions` on a concrete
 * `ISessionHostRuntime`: one manager per long-lived runtime, callable
 * repeatedly and concurrently to create and manage any number of sessions.
 * It never returns or implicitly creates another runtime, and it is never a
 * per-session object.
 *
 * Every `sessionId` parameter is runtime-local: callers outside the runtime
 * route through a full `SessionRef` first (typically `ISessionService`), then
 * invoke these methods with `ref.sessionId`.
 */

import type {
  ArtifactOwner,
  ISessionColdReader,
  ISessionRuntimeContext,
  SessionDescriptor,
  SessionMetadata,
  SessionMetadataPatch,
  SessionStoredStatus,
} from './sessionRuntimeContext';

/* ------------------------------------------------------------------------ */
/* CRUD                                                                      */
/* ------------------------------------------------------------------------ */

export interface CreateSessionInput {
  /**
   * Caller-proposed runtime-local id. When absent the runtime mints one
   * (v1-driven creation keeps the current globally-random/UUID strategy so
   * bare-id collisions across runtimes stay unlikely).
   */
  readonly sessionId?: string;
  readonly metadata?: SessionMetadata;
}

export interface SessionListQuery {
  readonly status?: SessionStoredStatus;
  readonly limit?: number;
  /** Opaque per-runtime cursor from a previous `SessionPage`; never a v1 field. */
  readonly cursor?: string;
}

export interface SessionPage {
  readonly items: readonly SessionDescriptor[];
  /** Present when more items are available; opaque to everyone but the runtime. */
  readonly cursor?: string;
}

export interface UpdateSessionPatch {
  readonly metadata?: SessionMetadataPatch;
  readonly status?: SessionStoredStatus;
  /** Optimistic concurrency: apply only when the stored revision still matches. */
  readonly revision?: string;
}

export interface DeleteSessionOptions {
  /** Delete even while a live child lease holds the session. */
  readonly force?: boolean;
}

/* ------------------------------------------------------------------------ */
/* Open / resume                                                             */
/* ------------------------------------------------------------------------ */

export interface OpenSessionOptions {
  /**
   * Request an exclusive child lease for this session. A conflicting live
   * lease fails with `session.lease_conflict`.
   */
  readonly exclusive?: boolean;
}

export interface ResumeSessionOptions extends OpenSessionOptions {
  /** Resume only when the stored revision still matches. */
  readonly expectedRevision?: string;
}

/* ------------------------------------------------------------------------ */
/* Fork                                                                      */
/* ------------------------------------------------------------------------ */

/**
 * Same-runtime fork input (plan §5.8). Cross-runtime copies never reach this
 * method — they go through the export/import transfer data plane.
 */
export interface SameRuntimeForkInput {
  /** Runtime-local id for the forked session; minted by the runtime when absent. */
  readonly sessionId?: string;
  readonly metadata?: SessionMetadataPatch;
}

/* ------------------------------------------------------------------------ */
/* Export / import (transfer data plane, plan §3.5)                          */
/* ------------------------------------------------------------------------ */

/** Logical kinds of entries in a session export stream. */
export type SessionExportEntryKind =
  /** The session descriptor/state document. */
  | 'descriptor'
  /** A typed-Store document (state, config, policy, ...). */
  | 'document'
  /** An append-log record stream (agent wire, session logs, ...). */
  | 'records'
  /** A binary object (blobs, media, attachments, tool results, ...). */
  | 'blob'
  /**
   * A session-owned cron task document (plan §7.10). The payload is the
   * source runtime's stored task record verbatim; the TARGET runtime decides
   * the write-back policy (re-schedule with a fresh task id re-tagged to the
   * new session, retain as an opaque blob, ...). Names are logical task
   * file names — never the source's physical cron directory.
   */
  | 'cron';

/**
 * One logical entry of the export stream (plan §3.5): logical kind, owner,
 * stable logical name, content, checksum and schema version — NEVER source
 * physical paths, workspace ids or `wd_id` layout facts.
 */
export interface SessionExportEntry {
  readonly kind: SessionExportEntryKind;
  readonly owner: ArtifactOwner;
  /** Stable logical name within its kind+owner (no host roots, no layout segments). */
  readonly name: string;
  /** Schema version of the entry payload, for target-side decoding. */
  readonly schemaVersion: number;
  readonly checksum?: string;
  readonly content: AsyncIterable<Uint8Array>;
}

export interface SessionExportOptions {
  /** Export a consistent snapshot at this revision when the runtime supports it. */
  readonly revision?: string;
}

export interface SessionImportInput {
  /** Runtime-local id for the imported session; minted when absent. */
  readonly sessionId?: string;
  readonly metadata?: SessionMetadataPatch;
  /**
   * Fork provenance (plan §5.8): when present, the import applies the target
   * runtime's SAME-runtime fork identity semantics on top of the transfer
   * data plane — re-anchored identity, `forkedFrom` set to this source
   * session id, fresh timestamps, unarchived status, goal state dropped and
   * the default fork title — instead of the plain transfer semantics (which
   * keep the source's createdAt/status). The value is a provenance string
   * only; it is never used for routing.
   */
  readonly forkFrom?: string;
  /** The logical entry stream produced by the source runtime's `export`. */
  readonly entries: AsyncIterable<SessionExportEntry>;
}

/* ------------------------------------------------------------------------ */
/* The manager                                                               */
/* ------------------------------------------------------------------------ */

export interface ISessionManager {
  /**
   * Create a new session under THIS runtime. Repeatable and concurrent: the
   * same manager creates sessions 1..N, all sharing the runtime's `runtimeId`
   * with isolated per-session namespaces, state, locks and lifecycle.
   */
  create(input: CreateSessionInput): Promise<SessionDescriptor>;
  list(query?: SessionListQuery): Promise<SessionPage>;
  get(sessionId: string): Promise<SessionDescriptor | undefined>;
  update(sessionId: string, patch: UpdateSessionPatch): Promise<SessionDescriptor>;
  delete(sessionId: string, options?: DeleteSessionOptions): Promise<void>;

  /**
   * Open a complete child context/lease for one session (plan §3.3). Does not
   * exclusively claim the host runtime; sibling sessions keep their own
   * leases. Fails with `session.not_found`, `session.lease_conflict` or
   * `session.open_failed`.
   */
  open(sessionId: string, options: OpenSessionOptions): Promise<ISessionRuntimeContext>;
  resume(sessionId: string, options: ResumeSessionOptions): Promise<ISessionRuntimeContext>;

  /** Same-runtime fork only; the target descriptor shares the source's `runtimeId`. */
  fork(sourceSessionId: string, input: SameRuntimeForkInput): Promise<SessionDescriptor>;

  coldRead(sessionId: string): Promise<ISessionColdReader>;
  export(sessionId: string, options?: SessionExportOptions): AsyncIterable<SessionExportEntry>;
  import(input: SessionImportInput): Promise<SessionDescriptor>;

  /**
   * OPTIONAL opaque revision token covering the session's WHOLE exportable
   * inventory — descriptor/state, every namespace's documents, records and
   * blobs, and session-owned cron tasks (plan §3.5: the source stays
   * consistent across the export window and is re-validated before commit).
   * It must change whenever ANY byte the export stream could carry changes.
   * The runtime derives it from its existing storage facts (content hashes,
   * counters), never from an added watermark file, and flushes a live
   * lease's pending appends first so the token and the export stream share
   * one cut. Runtimes without a cheap revision source omit the method —
   * callers (the transfer coordinator) then skip source-consistency
   * validation.
   */
  revision?(sessionId: string): Promise<string | undefined>;
}
