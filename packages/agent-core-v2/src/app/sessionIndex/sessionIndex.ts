/**
 * `sessionIndex` domain (L2) — session index contract.
 *
 * `ISessionIndex` is a domain-specific persistence Store: a backend-neutral
 * query facade over the set of persisted sessions (open or closed). It
 * enumerates sessions and derives session identity (`workspaceId`), returning
 * data (`SessionSummary`) or counts — never filesystem paths or live handles.
 * The summary mirrors `sessionMetadata`'s title state (`title` / `titleKind`);
 * the kind union is re-declared inline because this L2 contract cannot
 * import the L6 metadata domain that canonically owns it. Entries cached in
 * the derived read model carry `READ_MODEL_SUMMARY_VERSION`; older-stamped
 * (or un-stamped) entries are treated as cold misses and backfilled from
 * disk, so upgraded readers never serve a stale-shape summary.
 * Writes (create / archive) live in `workspaceHandler` / `session`; the index
 * is a read model. Backends are deployment-specific (local filesystem today;
 * database / query store on a server).
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Page } from '#/persistence/interface/queryStore';

export const READ_MODEL_SUMMARY_VERSION = 2;

export const PARENT_SESSION_ID_KEY = 'parent_session_id';

export const CHILD_SESSION_KIND_KEY = 'child_session_kind';

export const CHILD_SESSION_KIND = 'child';

export interface SessionSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly cwd?: string;
  readonly title?: string;
  readonly titleKind?: 'replaceable' | 'generated' | 'custom';
  readonly lastPrompt?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
  readonly custom?: Record<string, unknown>;
}

export interface SessionListQuery {
  /**
   * Restrict to sessions persisted under any of these workspace ids. A single
   * workspace is `[id]`; callers resolving a legacy split bucket (one
   * directory, several id spellings — see `IWorkspaceAliases.resolveAliasIds`)
   * pass the whole alias set and get one merged listing. Absent lists every
   * bucket.
   */
  readonly workspaceIds?: readonly string[];
  readonly sessionId?: string;
  readonly includeArchived?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
  readonly childOf?: string;
}

export interface ISessionIndex {
  readonly _serviceBrand: undefined;

  /** List persisted sessions, optionally filtered by a set of workspace ids. */
  list(query: SessionListQuery): Promise<Page<SessionSummary>>;
  get(id: string): Promise<SessionSummary | undefined>;
  /** Count non-archived sessions across the given set of workspace ids. */
  countActive(workspaceIds: readonly string[]): Promise<number>;
}

export const ISessionIndex: ServiceIdentifier<ISessionIndex> =
  createDecorator<ISessionIndex>('sessionIndex');
