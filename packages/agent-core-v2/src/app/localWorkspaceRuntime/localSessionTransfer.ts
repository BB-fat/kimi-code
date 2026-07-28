/**
 * `localWorkspaceRuntime` domain (L6) — the logical export/import data plane
 * of the local workspace runtime (plan §3.5, §5.10, §7.9).
 *
 * Export streams the session's full logical inventory as
 * `SessionExportEntry` items carrying only logical kind/owner/name/content/
 * checksum/schema version — NEVER the host root, physical paths, workspace
 * ids or `wd_id` layout facts. Entry content is the raw stored bytes
 * (byte-passthrough): `state.json` travels as a `document`, each agent's
 * `wire.jsonl` as `records` (the JSONL per-line framing every runtime in
 * this repo shares), the remaining files (plans, tasks, blobs, logs, media)
 * as `blob` entries whose names are stable logical paths relative to their
 * owner root — `plans/x.md`, `blobs/<sha>`, `logs/kimi-code.log` — and the
 * session-tagged cron task documents (which live OUTSIDE the session
 * directory, under the workspace-level `cron/<wd_id>/` scope) as `cron`
 * entries named `<taskId>.json`. Cron reads are read-only: the source tree
 * gains no marker, staging or metadata of any kind (plan §7.10).
 *
 * Import is staged (plan §3.5): entries are parsed and validated (kind,
 * schema version, checksum, record framing, name safety, cron decodability)
 * into local buffers first, then committed in one pass — payload files
 * first, re-scheduled cron tasks next, `state.json` LAST, since a session
 * becomes visible to the index only once its `state.json` exists. A failing
 * stream writes nothing visible; a failed commit removes the partially
 * written session directory AND every cron file already written. Imported
 * cron tasks are re-scheduled with a FRESH task id and the session tag
 * re-anchored to the new session id — the same duplication policy the
 * same-runtime fork applies.
 *
 * cwd adjudication (plan §3.5 gray area, M7 ruling): the descriptor entry
 * keeps `metadata.cwd`. What §3.5 bans is source physical paths as a
 * ROUTING/locating basis; `cwd` is v1 LOGICAL metadata the wire round-trip
 * depends on, so it travels as data. The import side re-anchors it: the
 * local target always stamps its OWN workspace cwd into `state.json`
 * (`applyMetadataPatch` ignores `cwd` patches), and a headless target keeps
 * it as a read-only fact. It is never used to route or locate anything.
 */

import { createReadStream } from 'node:fs';

import { ulid } from 'ulid';

import { SessionHostRuntimeError, SessionHostRuntimeErrors } from '#/app/sessionHostRuntime/errors';
import type { SessionExportEntry } from '#/app/sessionHostRuntime/sessionManager';
import type {
  ArtifactOwner,
  SessionMetadata,
  SessionStoredStatus,
} from '#/app/sessionHostRuntime/sessionRuntimeContext';
import { CRON_SESSION_TAG, type CronTask } from '#/app/cron/cronTask';
import { isValidCronTask } from '#/app/cron/cronTaskPersistenceService';
import { jsonDocumentCodec } from '#/persistence/backends/node-fs/atomicDocumentStore';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';
import {
  SESSION_META_VERSION,
  type SessionMeta,
} from '#/session/sessionMetadata/sessionMetadata';

import {
  agentScopeOf,
  applyMetadataPatch,
  cronScopeOf,
  fnv1aHex,
  forkCustomMetadata,
  metadataOfMeta,
  readMetadataRecord,
  readMetadataString,
  sessionScopeOf,
  SESSION_META_KEY,
} from './localWorkspaceLayout';

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

const EXPORT_SCHEMA_VERSION = 1;

/* ------------------------------------------------------------------------ */
/* Export                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * One file found while walking the session directory, paired with the
 * content hash its export entry carries. Bytes are NOT held in memory: the
 * hash comes from a streaming pre-pass (`hashLocalSessionFile`) and the
 * entry content streams lazily off disk (`streamFileBytes`), so a large
 * session export never buffers the whole directory (M8b).
 */
export interface SessionExportSourceFile {
  /** Path relative to the session directory, `/`-joined. */
  readonly rel: string;
  /** Absolute host path — read lazily, only through `streamFileBytes`. */
  readonly abs: string;
  /** FNV-1a hex of the file's content (the export entry's checksum). */
  readonly contentHash: string;
}

/**
 * Stream one file's FNV-1a content hash (bounded memory). The revision chain
 * mixes the same per-file hashes, so the token and the entry checksums
 * always describe the same bytes.
 */
export async function hashLocalSessionFile(abs: string): Promise<string> {
  let hash = 0x811c9dc5;
  for await (const chunk of streamFileBytes(abs)) {
    for (const byte of chunk) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193);
    }
  }
  const unsigned = hash < 0 ? hash + 2 ** 32 : hash;
  return unsigned.toString(16).padStart(8, '0');
}

/** Lazily stream a session file's bytes off disk (bounded memory). */
export async function* streamFileBytes(abs: string): AsyncIterable<Uint8Array> {
  const stream = createReadStream(abs);
  try {
    for await (const chunk of stream) {
      yield chunk as Uint8Array;
    }
  } finally {
    stream.destroy();
  }
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

/** The lazy-content twin of {@link entry} for session-directory files. */
function streamedEntry(
  kind: SessionExportEntry['kind'],
  owner: ArtifactOwner,
  name: string,
  file: SessionExportSourceFile,
): SessionExportEntry {
  return {
    kind,
    owner,
    name,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    checksum: file.contentHash,
    content: streamFileBytes(file.abs),
  };
}

async function* once(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

export interface ExportLocalSessionInput {
  readonly runtimeId: string;
  readonly sessionId: string;
  readonly meta: SessionMeta;
  readonly stateBytes: Uint8Array;
  /** Every regular file under the session directory (symlinks excluded). */
  readonly files: readonly SessionExportSourceFile[];
  /** Session-tagged cron tasks collected from the workspace cron scope. */
  readonly crons: readonly SessionCronTaskFile[];
}

/**
 * One session-tagged cron task document read from the workspace-level cron
 * scope (`cron/<wd_id>/<taskId>.json`).
 */
export interface SessionCronTaskFile {
  readonly taskId: string;
  /** Raw stored bytes — the export streams them verbatim. */
  readonly bytes: Uint8Array;
  readonly task: CronTask;
}

/**
 * Collect the session-tagged cron task documents of one session — READ ONLY
 * (plan §7.10: the Local source gains no marker, staging or metadata during
 * a transfer). Files failing to decode are skipped, the same tolerance the
 * same-runtime fork's cron duplication applies.
 */
export async function collectSessionCronTasks(
  storage: IFileSystemStorageService,
  workspaceId: string,
  sessionId: string,
): Promise<readonly SessionCronTaskFile[]> {
  const scope = cronScopeOf(workspaceId);
  const keys = await storage.list(scope);
  const out: SessionCronTaskFile[] = [];
  for (const key of keys.toSorted()) {
    if (!key.endsWith('.json')) continue;
    const bytes = await storage.read(scope, key);
    if (bytes === undefined) continue;
    let task: CronTask;
    try {
      task = jsonDocumentCodec.decode(bytes) as CronTask;
    } catch {
      continue;
    }
    if (task.tags?.[CRON_SESSION_TAG] !== sessionId) continue;
    out.push({ taskId: task.id, bytes, task });
  }
  return out;
}

/**
 * Build the logical export stream for one session. The descriptor entry
 * leads (same shape as the standalone memory runtime's, so cross-runtime
 * imports share one staging path); the stored `state.json` bytes follow as a
 * `document`; the session-directory files classify by their position in the
 * layout and stream their content lazily; the session-tagged cron tasks
 * close the stream as `cron` entries.
 */
export async function* exportLocalSession(
  input: ExportLocalSessionInput,
): AsyncIterable<SessionExportEntry> {
  const { meta } = input;
  yield entry(
    'descriptor',
    { kind: 'session' },
    'descriptor',
    textEncoder.encode(
      JSON.stringify({
        createdAt: new Date(meta.createdAt).toISOString(),
        updatedAt: new Date(meta.updatedAt).toISOString(),
        status: meta.archived ? 'archived' : 'active',
        metadata: metadataOfMeta(meta),
      }),
    ),
  );
  yield entry('document', { kind: 'session' }, SESSION_META_KEY, input.stateBytes);
  const agentsPrefix = 'agents/';
  for (const file of input.files) {
    if (file.rel === SESSION_META_KEY) continue; // already emitted as a document
    if (file.rel.startsWith(agentsPrefix)) {
      const rest = file.rel.slice(agentsPrefix.length);
      const slash = rest.indexOf('/');
      if (slash <= 0) continue; // not a file inside an agent directory
      const agentId = rest.slice(0, slash);
      const name = rest.slice(slash + 1);
      const owner: ArtifactOwner = { kind: 'agent', agentId };
      yield streamedEntry(name === 'wire.jsonl' ? 'records' : 'blob', owner, name, file);
      continue;
    }
    yield streamedEntry('blob', { kind: 'session' }, file.rel, file);
  }
  for (const cron of input.crons) {
    yield entry('cron', { kind: 'session' }, `${cron.taskId}.json`, cron.bytes);
  }
}

/* ------------------------------------------------------------------------ */
/* Import staging                                                           */
/* ------------------------------------------------------------------------ */

export interface StagedDescriptor {
  readonly createdAt?: string;
  readonly status?: SessionStoredStatus;
  readonly metadata?: SessionMetadata;
}

interface StagedFile {
  readonly owner: ArtifactOwner;
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** A staged cron task: decoded and validated, re-scheduled at commit time. */
export interface StagedCronTask {
  readonly name: string;
  readonly task: CronTask;
}

export interface StagedImport {
  readonly descriptor: StagedDescriptor;
  /** The parsed source `state.json` document entry, when the stream had one. */
  readonly stateDocument?: SessionMeta;
  /** Payload files: documents (other than state.json), records, blobs. */
  readonly files: readonly StagedFile[];
  /** Session-owned cron tasks to re-schedule into the target's cron scope. */
  readonly crons: readonly StagedCronTask[];
}

function transferFailed(message: string, cause?: unknown): SessionHostRuntimeError {
  return new SessionHostRuntimeError(
    SessionHostRuntimeErrors.codes.SESSION_TRANSFER_FAILED,
    message,
    { cause },
  );
}

/**
 * An entry name must be a relative, `/`-joined logical path: no empty
 * segments, no `.`/`..`, no backslashes, no leading separator. Names failing
 * this never reach the filesystem.
 */
function isValidEntryName(name: string): boolean {
  if (name.length === 0 || name.startsWith('/') || name.includes('\\')) return false;
  return name.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function assertValidOwner(owner: ArtifactOwner): void {
  if (owner.kind !== 'agent') {
    if (owner.kind === 'session') return;
    throw transferFailed('export entry has an unknown owner kind');
  }
  if (
    owner.agentId.length === 0 ||
    owner.agentId === '.' ||
    owner.agentId === '..' ||
    owner.agentId.includes('/') ||
    owner.agentId.includes('\\')
  ) {
    throw transferFailed('export entry has an agent owner with an invalid agentId');
  }
}

export async function stageLocalImport(
  entries: AsyncIterable<SessionExportEntry>,
): Promise<StagedImport> {
  let descriptor: StagedDescriptor = {};
  let stateDocument: SessionMeta | undefined;
  const files: StagedFile[] = [];
  const crons: StagedCronTask[] = [];
  for await (const item of entries) {
    if (item.schemaVersion !== EXPORT_SCHEMA_VERSION) {
      throw transferFailed(`unsupported export schema version ${item.schemaVersion}`);
    }
    if (item.kind !== 'descriptor' && !isValidEntryName(item.name)) {
      throw transferFailed(`export entry has an unsafe name '${item.name}'`);
    }
    assertValidOwner(item.owner);
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
      case 'document': {
        if (item.owner.kind === 'session' && item.name === SESSION_META_KEY) {
          try {
            stateDocument = JSON.parse(textDecoder.decode(bytes)) as SessionMeta;
          } catch (error) {
            throw transferFailed('failed to parse the state.json document entry', error);
          }
          break;
        }
        files.push({ owner: item.owner, name: item.name, bytes });
        break;
      }
      case 'records': {
        assertRecordFraming(item.name, bytes);
        files.push({ owner: item.owner, name: item.name, bytes });
        break;
      }
      case 'blob':
        files.push({ owner: item.owner, name: item.name, bytes });
        break;
      case 'cron': {
        if (item.owner.kind !== 'session') {
          throw transferFailed('cron export entries must be session-owned');
        }
        // Decode + validate at STAGING time so the commit pass cannot fail
        // on a malformed task halfway through writing cron files.
        let task: CronTask;
        try {
          task = jsonDocumentCodec.decode(bytes) as CronTask;
        } catch (error) {
          throw transferFailed(`failed to parse the cron export entry '${item.name}'`, error);
        }
        if (!isValidCronTask(task)) {
          throw transferFailed(`cron export entry '${item.name}' is not a valid cron task`);
        }
        crons.push({ name: item.name, task });
        break;
      }
    }
  }
  return stateDocument === undefined
    ? { descriptor, files, crons }
    : { descriptor, stateDocument, files, crons };
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
    metadata?: SessionMetadata;
  } = {};
  if (typeof raw.createdAt === 'string' && !Number.isNaN(Date.parse(raw.createdAt))) {
    staged.createdAt = raw.createdAt;
  }
  if (raw.status === 'active' || raw.status === 'archived') staged.status = raw.status;
  if (raw.metadata !== null && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)) {
    staged.metadata = raw.metadata as SessionMetadata;
  }
  return staged;
}

/**
 * Validate the JSONL record framing: records are separated by `\n`; a single
 * trailing separator is framing, while empty lines anywhere else mean the
 * stream is not what it claims. The bytes themselves travel verbatim.
 */
function assertRecordFraming(name: string, bytes: Uint8Array): void {
  if (bytes.byteLength === 0) return;
  let start = 0;
  for (let index = 0; index < bytes.byteLength; index++) {
    if (bytes[index] !== 0x0a) continue;
    if (index === start && index !== bytes.byteLength - 1) {
      throw transferFailed(`records export entry '${name}' contains an empty record line`);
    }
    start = index + 1;
  }
}

async function concatChunks(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
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

/* ------------------------------------------------------------------------ */
/* Import commit                                                            */
/* ------------------------------------------------------------------------ */

export interface CommitLocalImportInput {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly staged: StagedImport;
  readonly metadata?: SessionMetadata;
  /**
   * Fork provenance (plan §5.8): when present the imported `state.json` gets
   * the SAME rewrite the same-runtime fork performs — fresh timestamps,
   * unarchived, `forkedFrom`, goal state dropped, default fork title —
   * instead of the plain transfer re-anchoring.
   */
  readonly forkFrom?: string;
  readonly now: number;
}

/**
 * The final `state.json` of an imported session: the source document's
 * fields where the stream carried them, the descriptor entry's logical
 * values as overrides, the caller's metadata patch last — and identity
 * (id/cwd/timestamps) always re-anchored to the target runtime.
 */
export function importedStateDocument(input: CommitLocalImportInput): SessionMeta {
  const { staged } = input;
  if (input.forkFrom !== undefined) {
    return forkedStateDocument(input);
  }
  const base: SessionMeta = {
    ...staged.stateDocument,
    id: input.sessionId,
    version: SESSION_META_VERSION,
    cwd: input.cwd,
    createdAt:
      staged.descriptor.createdAt !== undefined
        ? Date.parse(staged.descriptor.createdAt)
        : (staged.stateDocument?.createdAt ?? input.now),
    updatedAt: input.now,
    archived: staged.descriptor.status === 'archived' || staged.stateDocument?.archived === true,
    agents: staged.stateDocument?.agents ?? {},
    custom: staged.stateDocument?.custom ?? {},
  };
  const withDescriptor =
    staged.descriptor.metadata === undefined
      ? base
      : applyMetadataPatch(base, staged.descriptor.metadata);
  return input.metadata === undefined ? withDescriptor : applyMetadataPatch(withDescriptor, input.metadata);
}

/**
 * Fork-semantic `state.json` for a cross-runtime fork (plan §5.8): the same
 * rewrite `LocalWorkspaceSessionManager.fork` performs on a same-runtime
 * fork — the stream's descriptor metadata overlay does NOT apply (a fork is
 * not a verbatim copy), the caller's patch applies last.
 */
function forkedStateDocument(input: CommitLocalImportInput): SessionMeta {
  const { staged } = input;
  const source = staged.stateDocument;
  const forkFrom = input.forkFrom!;
  const forkTitle = readMetadataString(input.metadata, 'title');
  const base: SessionMeta = {
    ...source,
    id: input.sessionId,
    version: SESSION_META_VERSION,
    cwd: input.cwd,
    createdAt: input.now,
    updatedAt: input.now,
    archived: false,
    title: forkTitle ?? `Fork: ${source?.title ?? forkFrom}`,
    isCustomTitle: forkTitle !== undefined ? true : source?.isCustomTitle === true,
    forkedFrom: forkFrom,
    lastPrompt: source?.lastPrompt,
    agents: source?.agents ?? {},
    // Goal state never crosses forks — source and patch customs alike.
    custom: forkCustomMetadata(source?.custom, readMetadataRecord(input.metadata, 'custom')),
  };
  if (input.metadata === undefined) return base;
  // `custom` was already merged with the fork's goal-dropping rule; every
  // other patch field applies through the ordinary funnel.
  const { custom: _handled, ...rest } = input.metadata;
  return applyMetadataPatch(base, rest);
}

/** Scope + key a staged payload file commits to, within the target session. */
export function stagedFileTarget(
  workspaceId: string,
  sessionId: string,
  file: StagedFile,
): { readonly scope: string; readonly key: string } {
  const root =
    file.owner.kind === 'session'
      ? sessionScopeOf(workspaceId, sessionId)
      : agentScopeOf(workspaceId, sessionId, file.owner.agentId);
  return { scope: root, key: file.name };
}

export async function writeStagedFile(
  storage: IFileSystemStorageService,
  workspaceId: string,
  sessionId: string,
  file: StagedFile,
): Promise<void> {
  const { scope, key } = stagedFileTarget(workspaceId, sessionId, file);
  await storage.write(scope, key, file.bytes, { atomic: true });
}

/**
 * Re-schedule one staged cron task into the target workspace's cron scope
 * (`cron/<wd_id>/`): a FRESH task id and the session tag re-anchored to the
 * imported session — the same duplication policy the same-runtime fork
 * applies. Returns the written location so a failed commit can roll the
 * file back (cron lives outside the session directory the `rm -rf` covers).
 */
export async function writeStagedCronTask(
  storage: IFileSystemStorageService,
  workspaceId: string,
  sessionId: string,
  staged: StagedCronTask,
): Promise<{ readonly scope: string; readonly key: string }> {
  const scope = cronScopeOf(workspaceId);
  const clone: CronTask = {
    ...staged.task,
    id: ulid(),
    tags: { ...staged.task.tags, [CRON_SESSION_TAG]: sessionId },
  };
  const key = `${clone.id}.json`;
  await storage.write(scope, key, jsonDocumentCodec.encode(clone), { atomic: true });
  return { scope, key };
}

export function encodeStateDocument(meta: SessionMeta): Uint8Array {
  return jsonDocumentCodec.encode(meta);
}

/**
 * Whole-inventory revision token for the transfer coordinator (plan §3.5):
 * one FNV-1a chain over every session-directory file (path + content hash)
 * and every session-tagged cron task (id + bytes) — anything the export
 * stream could carry, so the token flips whenever any carried byte changes.
 * The per-file hashes are the SAME checksums the export entries carry
 * (`hashLocalSessionFile`), keeping the token and the stream on one byte
 * view; derived from stored content only — no watermark file anywhere
 * (plan §9.5).
 */
export function revisionOfLocalSession(
  files: readonly SessionExportSourceFile[],
  crons: readonly SessionCronTaskFile[],
): string {
  let hash = 0x811c9dc5;
  const mixBytes = (bytes: Uint8Array): void => {
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193);
    }
  };
  const mixText = (text: string): void => mixBytes(textEncoder.encode(text));
  for (const file of files) {
    mixText(file.rel);
    mixText(file.contentHash);
  }
  for (const cron of crons) {
    mixText(cron.taskId);
    mixBytes(cron.bytes);
  }
  const unsigned = hash < 0 ? hash + 2 ** 32 : hash;
  return unsigned.toString(16).padStart(8, '0');
}
