/**
 * `localWorkspaceRuntime` domain (L6) — the private legacy-layout helpers of
 * the local workspace runtime (plan §4.3, §7.9).
 *
 * Everything here maps the pathless host-runtime contracts onto the EXISTING
 * on-disk layout — the same bytes the current engine already reads and
 * writes:
 *
 *   <homeDir>/sessions/<wd_id>/<sessionId>/state.json      (SessionMeta, v2)
 *   <homeDir>/sessions/<wd_id>/<sessionId>/agents/<agentId>/wire.jsonl
 *   <homeDir>/session_index.jsonl                          (v1 discovery log)
 *   <homeDir>/cron/<wd_id>/<id>.json                       (session-tagged cron)
 *
 * There is no second repository, no locator, no `.session-store`, no staging
 * or routing marker and no duplicate metadata: the directory tree remains the
 * index (`FileSessionIndex` semantics) and `state.json` the single metadata
 * document. The persistence namespace tokens this runtime mints ARE the
 * legacy storage scopes — an opaque-token consumer cannot tell, and must not
 * rely on, that fact (plan §3.6).
 *
 * These helpers are private to the local workspace runtime and its tests
 * (plan §10.1): no other runtime, business domain or edge route may import
 * them — the import guard in `scripts/check-domain-layers.mjs` enforces it.
 */

import { Error2 } from '#/_base/errors/errors';

import type {
  SessionDescriptor,
  SessionMetadata,
} from '#/app/sessionHostRuntime/sessionRuntimeContext';
import { toPersistenceNamespace } from '#/app/sessionHostRuntime/sessionRuntimeContext';
import { ErrorCodes } from '#/errors';
import { jsonDocumentCodec } from '#/persistence/backends/node-fs/atomicDocumentStore';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';
import {
  SESSION_META_VERSION,
  type SessionMeta,
} from '#/session/sessionMetadata/sessionMetadata';
import { normalizeSessionMeta } from '#/session/sessionMetadata/sessionMetadataService';

export const SESSION_META_KEY = 'state.json';
export const SESSION_INDEX_KEY = 'session_index.jsonl';

/**
 * Pre-unification v2 sessions kept their metadata document one level down
 * (`<sessionDir>/session-meta/state.json`); the session index reads through
 * that fallback, and so does this runtime (plan §9.5: old session
 * directories open directly, no importer runs).
 */
export const LEGACY_SESSION_META_SCOPE = 'session-meta';

/** The session persistence namespace == the legacy session storage scope. */
export function sessionScopeOf(workspaceId: string, sessionId: string) {
  return toPersistenceNamespace(`sessions/${workspaceId}/${sessionId}`);
}

/** The agent persistence namespace == the legacy per-agent storage scope. */
export function agentScopeOf(workspaceId: string, sessionId: string, agentId: string) {
  return toPersistenceNamespace(`sessions/${workspaceId}/${sessionId}/agents/${agentId}`);
}

/**
 * The workspace-level cron scope (`cron/<wd_id>/<taskId>.json`) holding the
 * session-tagged cron task documents. Cron lives OUTSIDE the session
 * directory: exports read it (read-only), imports/forks write it with fresh
 * task ids re-tagged to the new session (plan §7.10).
 */
export function cronScopeOf(workspaceId: string) {
  return toPersistenceNamespace(`cron/${workspaceId}`);
}

/* ------------------------------------------------------------------------ */
/* Id validation                                                            */
/* ------------------------------------------------------------------------ */

const ID_SEGMENT_PATTERN = /^[^\u0000-\u0020\u007F/\\]+$/u;

/**
 * Session and agent ids land inside storage scopes and file paths, so they
 * must stay free of separators, whitespace and control characters
 * (`.`/`..` included). Same rule as the standalone memory runtime's
 * `isValidIdSegment` — kept private per runtime domain so neither runtime
 * depends on the other's internals.
 */
export function isValidIdSegment(value: string): boolean {
  return value !== '.' && value !== '..' && ID_SEGMENT_PATTERN.test(value);
}

export function assertValidSessionId(sessionId: string): void {
  if (!isValidIdSegment(sessionId)) {
    throw new Error2(
      ErrorCodes.SESSION_ID_INVALID,
      `invalid session id '${sessionId}': must be a single segment without separators, whitespace or control characters`,
      { details: { sessionId } },
    );
  }
}

/* ------------------------------------------------------------------------ */
/* state.json reads and the descriptor projection                            */
/* ------------------------------------------------------------------------ */

export interface StateDocument {
  readonly meta: SessionMeta;
  /** Raw stored bytes — the export streams them verbatim. */
  readonly bytes: Uint8Array;
  /** Optimistic-concurrency marker derived from the stored bytes (no watermark file). */
  readonly revision: string;
}

/**
 * Read and normalize the session's `state.json`. Missing file → `undefined`
 * (the session does not exist in this bucket); corrupted bytes surface the
 * storage decode error (callers decide between tolerant skipping — list/get —
 * and `session.open_failed`).
 *
 * v1 documents (no `version`, ISO timestamps, `workDir`) are normalized
 * in-memory through the same `normalizeSessionMeta` the live engine uses —
 * opening an old directory is a plain read, never an importer run.
 */
export async function readStateDocument(
  storage: IFileSystemStorageService,
  scope: string,
  sessionId: string,
): Promise<StateDocument | undefined> {
  const bytes =
    (await storage.read(scope, SESSION_META_KEY)) ??
    (await storage.read(`${scope}/${LEGACY_SESSION_META_SCOPE}`, SESSION_META_KEY));
  if (bytes === undefined) return undefined;
  const raw = jsonDocumentCodec.decode(bytes) as SessionMeta;
  const normalized = normalizeSessionMeta(raw, sessionId);
  // The DIRECTORY name is the authoritative session id (the same semantics
  // `FileSessionIndex` applies — it never reads `meta.id`): a v2 document
  // with a missing or drifting id is re-anchored to its bucket, while
  // `normalizeSessionMeta` only backfills the id for legacy documents.
  const meta = normalized.id === sessionId ? normalized : { ...normalized, id: sessionId };
  return { meta, bytes, revision: fnv1aHex(bytes) };
}

/** Logical metadata projection of `state.json` (plan §3.2: logical only). */
export function metadataOfMeta(meta: SessionMeta): SessionMetadata {
  const metadata: Record<string, unknown> = {};
  if (meta.title !== undefined) metadata['title'] = meta.title;
  if (meta.isCustomTitle !== undefined) metadata['isCustomTitle'] = meta.isCustomTitle;
  if (meta.lastPrompt !== undefined) metadata['lastPrompt'] = meta.lastPrompt;
  // The cwd fact follows the session index's full `recoverCwd` chain:
  // normalized `cwd` (itself `cwd ?? workDir`) first, then the pre-G3
  // `custom.cwd` spelling as the last resort.
  const cwd = meta.cwd ?? recoverCustomCwd(meta);
  if (cwd !== undefined) metadata['cwd'] = cwd;
  if (meta.forkedFrom !== undefined) metadata['forkedFrom'] = meta.forkedFrom;
  if (meta.custom !== undefined) metadata['custom'] = meta.custom;
  // The persisted agent roster travels as logical metadata too: cold readers
  // (e.g. the v1 transcript edge) rebuild their roster view from it without
  // touching the layout. It stays OUT of `applyMetadataPatch`'s known fields —
  // the roster is engine-owned and never patched through metadata updates.
  if (meta.agents !== undefined) metadata['agents'] = meta.agents;
  return metadata;
}

/** The session index's third-level cwd recovery: a non-empty `custom.cwd`. */
function recoverCustomCwd(meta: SessionMeta): string | undefined {
  const custom = meta.custom;
  if (custom === null || typeof custom !== 'object' || Array.isArray(custom)) return undefined;
  const fromCustom = custom['cwd'];
  return typeof fromCustom === 'string' && fromCustom.length > 0 ? fromCustom : undefined;
}

export function descriptorOf(
  runtimeId: string,
  meta: SessionMeta,
  revision: string,
): SessionDescriptor {
  return {
    ref: { runtimeId, sessionId: meta.id },
    createdAt: new Date(meta.createdAt).toISOString(),
    updatedAt: new Date(meta.updatedAt).toISOString(),
    status: meta.archived ? 'archived' : 'active',
    metadata: metadataOfMeta(meta),
    revision,
  };
}

/**
 * Apply a logical metadata patch to a stored `SessionMeta`. The known
 * top-level fields map back one-to-one; unknown keys merge into `custom` —
 * the same funnel the v1 `updateProfile` flow uses for arbitrary metadata.
 * `cwd` in a patch is ignored: the session's workspace root is fixed by the
 * owning runtime, never rewritten per session. `agents` is ignored too: the
 * roster is engine-owned state (patched by agent lifecycle, never by a
 * metadata update) — it rides `metadataOfMeta` so cold readers can rebuild
 * their roster view, and must not funnel back into `custom` on patch/import.
 */
export function applyMetadataPatch(meta: SessionMeta, patch: SessionMetadata): SessionMeta {
  const { title, isCustomTitle, lastPrompt, cwd: _cwd, forkedFrom, custom, agents: _agents, ...rest } = patch;
  const extraCustom = rest as Record<string, unknown>;
  const customPatch =
    custom !== null && typeof custom === 'object' && !Array.isArray(custom)
      ? (custom as Record<string, unknown>)
      : undefined;
  const mergeCustom = customPatch !== undefined || Object.keys(extraCustom).length > 0;
  return {
    ...meta,
    title: title === undefined ? meta.title : (title as string),
    isCustomTitle: isCustomTitle === undefined ? meta.isCustomTitle : (isCustomTitle as boolean),
    lastPrompt: lastPrompt === undefined ? meta.lastPrompt : (lastPrompt as string),
    forkedFrom: forkedFrom === undefined ? meta.forkedFrom : (forkedFrom as string),
    custom: mergeCustom ? { ...meta.custom, ...customPatch, ...extraCustom } : meta.custom,
  };
}

/** Initial `state.json` document for a freshly created session (v2 shape). */
export function initialStateDocument(
  sessionId: string,
  cwd: string,
  metadata: SessionMetadata | undefined,
  now: number,
): SessionMeta {
  const base: SessionMeta = {
    id: sessionId,
    version: SESSION_META_VERSION,
    cwd,
    createdAt: now,
    updatedAt: now,
    archived: false,
    agents: {},
    custom: {},
  };
  return metadata === undefined ? base : applyMetadataPatch(base, metadata);
}

/* ------------------------------------------------------------------------ */
/* Fork metadata helpers (shared by same-runtime fork and transfer import)   */
/* ------------------------------------------------------------------------ */

export function readMetadataString(
  metadata: SessionMetadata | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function readMetadataRecord(
  metadata: SessionMetadata | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = metadata?.[key];
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Merge custom metadata for a fork, dropping the `goal` key on both sides —
 * the same rule `sessionLifecycle` applies (goal state never crosses forks).
 */
export function forkCustomMetadata(
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

/* ------------------------------------------------------------------------ */
/* Integrity checksum (shared by revision derivation and export entries)     */
/* ------------------------------------------------------------------------ */

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
