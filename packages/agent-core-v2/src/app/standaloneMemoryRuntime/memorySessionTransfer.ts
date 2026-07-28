/**
 * `standaloneMemoryRuntime` domain (L4) — the logical export/import data
 * plane of the standalone memory host runtime (plan §3.5).
 *
 * Export streams the session's full logical inventory — the descriptor, every
 * minted namespace's documents, append-log records and blobs (artifacts live
 * among the blobs under their `artifacts/` keys) — as `SessionExportEntry`
 * items carrying only logical kind/owner/name/content/checksum/schema
 * version. Entry names are the logical store keys; namespace tokens and
 * runtime/session ids never leak into the stream. Record logs travel as one
 * encoded record per line, the same framing the node-fs JSONL layout uses.
 *
 * Session-owned cron entries (M7, plan §7.10) ride the same stream as opaque
 * payloads: this headless runtime has no cron scheduler, so its documented
 * write-back policy is RETENTION, not scheduling — a `cron` entry commits as
 * the `cron/<name>` blob of the session namespace, and export re-projects
 * exactly those blobs back into `cron` entries, so a memory→local transfer
 * lands the tasks again. The runtime never interprets the payload.
 *
 * Import is staged: entries are parsed and validated (kind, schema version,
 * checksum, record framing) into local buffers first, and only then handed to
 * the manager for one atomic commit — a failing stream changes nothing and
 * stays invisible to list/get. Bytes travel verbatim (documents stay
 * codec-encoded, records stay per-line encoded); the target side decodes
 * through its own typed Stores exactly as if the data had been written live.
 */

import { SessionHostRuntimeError, SessionHostRuntimeErrors } from '#/app/sessionHostRuntime/errors';
import type { SessionExportEntry } from '#/app/sessionHostRuntime/sessionManager';
import type { ArtifactOwner, SessionStoredStatus } from '#/app/sessionHostRuntime/sessionRuntimeContext';

import { concatChunks } from './memorySessionContext';
import {
  namespaceForOwner,
  ownerOfNamespace,
  isValidIdSegment,
  sessionNamespaceOf,
  type MemorySessionBackend,
  type MemorySessionEntry,
} from './memoryBackend';

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

const EXPORT_SCHEMA_VERSION = 1;

/**
 * Blob-key prefix under which session-owned cron entries are retained inside
 * the session namespace (the memory runtime's cron write-back policy, M7).
 * Export re-projects exactly these blobs back into `cron` entries.
 */
export const CRON_BLOB_PREFIX = 'cron/';

async function* once(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

/** FNV-1a 32-bit, hex-encoded — an integrity checksum, not a MAC. */
export function fnv1aHex(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  const unsigned = hash < 0 ? hash + 2 ** 32 : hash;
  return unsigned.toString(16).padStart(8, '0');
}

function entry(
  kind: SessionExportEntry['kind'],
  owner: ArtifactOwner,
  name: string,
  bytes: Uint8Array,
): SessionExportEntry {
  return {
    kind,
    owner,
    name,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    checksum: fnv1aHex(bytes),
    content: once(bytes),
  };
}

export async function* exportMemorySession(
  backend: MemorySessionBackend,
  sessionEntry: MemorySessionEntry,
): AsyncIterable<SessionExportEntry> {
  const { current } = sessionEntry;
  yield entry(
    'descriptor',
    { kind: 'session' },
    'descriptor',
    textEncoder.encode(
      JSON.stringify({
        createdAt: current.createdAt,
        updatedAt: current.updatedAt,
        status: current.status,
        metadata: current.metadata,
      }),
    ),
  );
  const sessionId = current.ref.sessionId;
  const namespaces = [...sessionEntry.namespaces].toSorted();
  for (const namespace of namespaces) {
    const owner = ownerOfNamespace(sessionId, namespace);
    for (const key of await backend.documentBytes.list(namespace)) {
      const bytes = await backend.documentBytes.read(namespace, key);
      if (bytes !== undefined) yield entry('document', owner, key, bytes);
    }
    for (const key of backend.logs.list(namespace)) {
      const entries = backend.logs.entries(namespace, key);
      const bytes = textEncoder.encode(
        entries.map((record) => `${textDecoder.decode(record)}\n`).join(''),
      );
      yield entry('records', owner, key, bytes);
    }
    for (const key of await backend.blobBytes.list(namespace)) {
      const bytes = await backend.blobBytes.read(namespace, key);
      if (bytes === undefined) continue;
      // Retained cron payloads re-project as `cron` entries (round-trip
      // fidelity for memory→local transfers); everything else is a blob.
      if (owner.kind === 'session' && key.startsWith(CRON_BLOB_PREFIX)) {
        yield entry('cron', owner, key.slice(CRON_BLOB_PREFIX.length), bytes);
        continue;
      }
      yield entry('blob', owner, key, bytes);
    }
  }
}

export interface StagedDescriptor {
  readonly createdAt?: string;
  readonly status?: SessionStoredStatus;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface StagedImport {
  readonly descriptor: StagedDescriptor;
  readonly documents: readonly StagedWrite[];
  readonly records: readonly StagedRecords[];
  readonly blobs: readonly StagedWrite[];
  /** Session-owned cron payloads, retained as opaque `cron/<name>` blobs. */
  readonly crons: readonly StagedWrite[];
}

interface StagedWrite {
  readonly owner: ArtifactOwner;
  readonly name: string;
  readonly bytes: Uint8Array;
}

interface StagedRecords {
  readonly owner: ArtifactOwner;
  readonly name: string;
  readonly records: readonly Uint8Array[];
}

function transferFailed(message: string, cause?: unknown): SessionHostRuntimeError {
  return new SessionHostRuntimeError(
    SessionHostRuntimeErrors.codes.SESSION_TRANSFER_FAILED,
    message,
    { cause },
  );
}

function assertOwner(owner: ArtifactOwner): void {
  if (owner.kind === 'agent' && !isValidIdSegment(owner.agentId)) {
    throw transferFailed('export entry has an agent owner with an invalid agentId');
  }
}

export async function stageImportEntries(
  entries: AsyncIterable<SessionExportEntry>,
): Promise<StagedImport> {
  let descriptor: StagedDescriptor = {};
  const documents: StagedWrite[] = [];
  const records: StagedRecords[] = [];
  const blobs: StagedWrite[] = [];
  const crons: StagedWrite[] = [];
  for await (const item of entries) {
    if (item.schemaVersion !== EXPORT_SCHEMA_VERSION) {
      throw transferFailed(`unsupported export schema version ${item.schemaVersion}`);
    }
    if (item.name.length === 0) throw transferFailed('export entry has an empty name');
    assertOwner(item.owner);
    const bytes = await concatChunks(item.content);
    if (item.checksum !== undefined && fnv1aHex(bytes) !== item.checksum) {
      throw transferFailed(`checksum mismatch on export entry '${item.name}'`);
    }
    switch (item.kind) {
      case 'descriptor': {
        try {
          descriptor = parseDescriptor(JSON.parse(textDecoder.decode(bytes)));
        } catch (error) {
          throw transferFailed('failed to parse the descriptor export entry', error);
        }
        break;
      }
      case 'document':
        documents.push({ owner: item.owner, name: item.name, bytes });
        break;
      case 'records':
        records.push({ owner: item.owner, name: item.name, records: splitRecordLines(bytes) });
        break;
      case 'blob':
        blobs.push({ owner: item.owner, name: item.name, bytes });
        break;
      case 'cron': {
        if (item.owner.kind !== 'session') {
          throw transferFailed('cron export entries must be session-owned');
        }
        crons.push({ owner: item.owner, name: item.name, bytes });
        break;
      }
    }
  }
  return { descriptor, documents, records, blobs, crons };
}

function parseDescriptor(value: unknown): StagedDescriptor {
  if (value === null || typeof value !== 'object') {
    throw transferFailed('descriptor export entry is not an object');
  }
  const raw = value as {
    readonly createdAt?: unknown;
    readonly status?: unknown;
    readonly metadata?: unknown;
  };
  const staged: {
    createdAt?: string;
    status?: SessionStoredStatus;
    metadata?: Readonly<Record<string, unknown>>;
  } = {};
  if (typeof raw.createdAt === 'string') staged.createdAt = raw.createdAt;
  if (raw.status === 'active' || raw.status === 'archived') staged.status = raw.status;
  if (raw.metadata !== null && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)) {
    staged.metadata = raw.metadata as Readonly<Record<string, unknown>>;
  }
  return staged;
}

/**
 * Split a records payload back into one encoded record per entry: records are
 * separated by `\n` (which cannot appear inside a multi-byte UTF-8 sequence,
 * so byte-level splitting is safe); a single trailing separator is framing,
 * while empty lines anywhere else mean the stream is not what it claims.
 */
function splitRecordLines(bytes: Uint8Array): readonly Uint8Array[] {
  const lines: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index < bytes.byteLength; index++) {
    if (bytes[index] !== 0x0a) continue;
    lines.push(bytes.subarray(start, index));
    start = index + 1;
  }
  if (start < bytes.byteLength) lines.push(bytes.subarray(start));
  if (lines.length > 0 && lines.at(-1)!.byteLength === 0) lines.pop();
  if (lines.some((line) => line.byteLength === 0)) {
    throw transferFailed('records export entry contains an empty record line');
  }
  return lines;
}

/** Commit a staged import into the backend under the target session id. */
export async function commitStagedImport(
  backend: MemorySessionBackend,
  entry: MemorySessionEntry,
  staged: StagedImport,
): Promise<void> {
  const sessionId = entry.current.ref.sessionId;
  const write = async (
    items: readonly StagedWrite[],
    put: (namespace: string, name: string, bytes: Uint8Array) => Promise<void>,
  ): Promise<void> => {
    for (const item of items) {
      const namespace = namespaceForOwner(sessionId, item.owner);
      entry.namespaces.add(namespace);
      if (item.owner.kind === 'agent') entry.agents.add(item.owner.agentId);
      await put(namespace, item.name, item.bytes);
    }
  };
  await write(staged.documents, (namespace, name, bytes) =>
    backend.documentBytes.write(namespace, name, bytes, { atomic: true }),
  );
  await write(staged.blobs, (namespace, name, bytes) =>
    backend.blobBytes.write(namespace, name, bytes, { atomic: true }),
  );
  // Cron write-back policy of this headless runtime (M7): RETENTION as
  // opaque `cron/<name>` blobs of the session namespace — never scheduled,
  // re-exported as `cron` entries so a later transfer lands them again.
  for (const item of staged.crons) {
    const namespace = sessionNamespaceOf(sessionId);
    entry.namespaces.add(namespace);
    await backend.blobBytes.write(namespace, `${CRON_BLOB_PREFIX}${item.name}`, item.bytes, {
      atomic: true,
    });
  }
  for (const item of staged.records) {
    const namespace = namespaceForOwner(sessionId, item.owner);
    entry.namespaces.add(namespace);
    if (item.owner.kind === 'agent') entry.agents.add(item.owner.agentId);
    backend.logs.replace(namespace, item.name, item.records);
  }
}

/**
 * Whole-inventory revision token (plan §3.5): one FNV-1a chain over the
 * descriptor facts and every namespace's documents, log records and blobs —
 * anything the export stream could carry. Derived from storage contents
 * only; no watermark state anywhere.
 */
export async function revisionOfEntry(
  backend: MemorySessionBackend,
  entry: MemorySessionEntry,
): Promise<string> {
  let hash = 0x811c9dc5;
  const mixBytes = (bytes: Uint8Array): void => {
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193);
    }
  };
  const mixText = (text: string): void => mixBytes(textEncoder.encode(text));
  const { current } = entry;
  mixText(String(entry.revision));
  mixText(current.updatedAt);
  mixText(current.status);
  mixText(JSON.stringify(current.metadata));
  for (const namespace of [...entry.namespaces].toSorted()) {
    mixText(namespace);
    for (const key of await backend.documentBytes.list(namespace)) {
      const bytes = await backend.documentBytes.read(namespace, key);
      if (bytes === undefined) continue;
      mixText(key);
      mixBytes(bytes);
    }
    for (const key of backend.logs.list(namespace)) {
      mixText(key);
      for (const record of backend.logs.entries(namespace, key)) mixBytes(record);
    }
    for (const key of await backend.blobBytes.list(namespace)) {
      const bytes = await backend.blobBytes.read(namespace, key);
      if (bytes === undefined) continue;
      mixText(key);
      mixBytes(bytes);
    }
  }
  const unsigned = hash < 0 ? hash + 2 ** 32 : hash;
  return unsigned.toString(16).padStart(8, '0');
}
