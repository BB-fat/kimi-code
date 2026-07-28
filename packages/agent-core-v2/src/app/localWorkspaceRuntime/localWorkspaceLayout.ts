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

/** The session persistence namespace == the legacy session storage scope. */
export function sessionScopeOf(workspaceId: string, sessionId: string) {
  return toPersistenceNamespace(`sessions/${workspaceId}/${sessionId}`);
}

/** The agent persistence namespace == the legacy per-agent storage scope. */
export function agentScopeOf(workspaceId: string, sessionId: string, agentId: string) {
  return toPersistenceNamespace(`sessions/${workspaceId}/${sessionId}/agents/${agentId}`);
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
  const bytes = await storage.read(scope, SESSION_META_KEY);
  if (bytes === undefined) return undefined;
  const raw = jsonDocumentCodec.decode(bytes) as SessionMeta;
  const meta = normalizeSessionMeta(raw, sessionId);
  return { meta, bytes, revision: fnv1aHex(bytes) };
}

/** Logical metadata projection of `state.json` (plan §3.2: logical only). */
export function metadataOfMeta(meta: SessionMeta): SessionMetadata {
  const metadata: Record<string, unknown> = {};
  if (meta.title !== undefined) metadata['title'] = meta.title;
  if (meta.isCustomTitle !== undefined) metadata['isCustomTitle'] = meta.isCustomTitle;
  if (meta.lastPrompt !== undefined) metadata['lastPrompt'] = meta.lastPrompt;
  if (meta.cwd !== undefined) metadata['cwd'] = meta.cwd;
  if (meta.forkedFrom !== undefined) metadata['forkedFrom'] = meta.forkedFrom;
  if (meta.custom !== undefined) metadata['custom'] = meta.custom;
  return metadata;
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
 * owning runtime, never rewritten per session.
 */
export function applyMetadataPatch(meta: SessionMeta, patch: SessionMetadata): SessionMeta {
  const { title, isCustomTitle, lastPrompt, cwd: _cwd, forkedFrom, custom, ...rest } = patch;
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
