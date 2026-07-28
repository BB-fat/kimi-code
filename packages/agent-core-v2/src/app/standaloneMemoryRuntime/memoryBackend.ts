/**
 * `standaloneMemoryRuntime` domain (L4) — the durable medium and namespace
 * scheme of the standalone memory host runtime (plan §4.5).
 *
 * One `MemorySessionBackend` per runtime holds every session's data:
 * codec-encoded documents and raw blobs in two `InMemoryStorageService` byte
 * maps, append-log records in the shared `InMemoryLogBackend`. Sessions (and
 * agents within a session) are isolated purely by their `PersistenceNamespace`
 * tokens — `session/<sessionId>` and `session/<sessionId>/agents/<agentId>` —
 * which are this runtime's private mapping: business code only ever sees the
 * opaque tokens its lease minted, and the lease validates every token it is
 * handed back against the session's minted set.
 *
 * The catalog entry tracks what the runtime needs for enumeration across
 * fork/delete/export: the live descriptor, every minted namespace, the agent
 * roster, per-artifact version counters and the live child lease (single
 * writer — a second `open`/`resume` fails with `session.lease_conflict`).
 */

import type {
  ArtifactOwner,
  SessionCloseReason,
  SessionDescriptor,
} from '#/app/sessionHostRuntime/sessionRuntimeContext';
import { toPersistenceNamespace } from '#/app/sessionHostRuntime/sessionRuntimeContext';
import { InMemoryLogBackend } from '#/persistence/backends/memory/inMemoryStores';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';

export class MemorySessionBackend {
  /** Codec-encoded document bytes, scope = persistence namespace. */
  readonly documentBytes = new InMemoryStorageService();
  /** Raw blob + artifact bytes, scope = persistence namespace. */
  readonly blobBytes = new InMemoryStorageService();
  /** Durable append-log entries (one encoded record per entry). */
  readonly logs = new InMemoryLogBackend();
}

/**
 * The manager's view of a live child lease, kept on the catalog entry so
 * force-delete and runtime close can drive its lifecycle without importing
 * the lease implementation. `flush` lets same-runtime fork/export snapshot a
 * consistent cut of a session that still has a live writer.
 */
export interface MemoryLeaseHandle {
  flush(): Promise<void>;
  closeFromManager(reason: SessionCloseReason): Promise<void>;
}

export interface MemorySessionEntry {
  /** The current descriptor; replaced wholesale on update. */
  current: SessionDescriptor;
  /** Numeric optimistic-concurrency counter behind `descriptor.revision`. */
  revision: number;
  /** Every namespace minted for this session (session + agents). */
  readonly namespaces: Set<string>;
  /** Agent roster: every agentId ever minted through `agentNamespace`. */
  readonly agents: Set<string>;
  /** `<ownerTag>/<artifactId>` → latest artifact version counter. */
  readonly artifactVersions: Map<string, number>;
  /** The live child lease, when one is open (single writer per session). */
  lease: MemoryLeaseHandle | undefined;
}

export function sessionNamespaceOf(sessionId: string) {
  return toPersistenceNamespace(`session/${sessionId}`);
}

export function agentNamespaceOf(sessionId: string, agentId: string) {
  return toPersistenceNamespace(`session/${sessionId}/agents/${agentId}`);
}

export function namespaceForOwner(
  sessionId: string,
  owner: ArtifactOwner,
) {
  return owner.kind === 'session'
    ? sessionNamespaceOf(sessionId)
    : agentNamespaceOf(sessionId, owner.agentId);
}

export function ownerOfNamespace(sessionId: string, namespace: string): ArtifactOwner {
  const prefix = `${sessionNamespaceOf(sessionId)}/agents/`;
  if (namespace.startsWith(prefix)) {
    return { kind: 'agent', agentId: namespace.slice(prefix.length) };
  }
  return { kind: 'session' };
}

/** Blob key under which an artifact lives inside its owner's namespace. */
export function artifactBlobKey(artifactId: string): string {
  return `artifacts/${artifactId}`;
}

export function artifactOwnerTag(owner: ArtifactOwner): string {
  return owner.kind === 'session' ? 'session' : `agent/${owner.agentId}`;
}

const ID_SEGMENT_PATTERN = /^[^\u0000-\u0020\u007F/\\]+$/u;

/**
 * Session and agent ids land inside this runtime's persistence namespaces,
 * store cache keys and log-id splits, so they must stay free of separators,
 * whitespace and control characters (`.`/`..` included) — otherwise a crafted
 * id could collide with another session's keys or corrupt framing.
 */
export function isValidIdSegment(value: string): boolean {
  return value !== '.' && value !== '..' && ID_SEGMENT_PATTERN.test(value);
}
