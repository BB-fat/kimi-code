/**
 * `sessionHostFiles` domain (L1) — the typed host-files capability of a
 * session lease (multi-runtime refactor, plan §7.2/§7.5).
 *
 * The generic runtime contract stays pathless (plan §1.4): `ISessionContext`
 * carries no `sessionDir`/`metaScope`, and nothing in Session Core derives a
 * physical path. But a runtime that genuinely OWNS a per-session host
 * directory — today only the Local workspace runtime
 * (`<homeDir>/sessions/<wd_id>/<sessionId>`) — projects the facts a small set
 * of file-bound consumers legitimately need: the session log file, the plan
 * working documents, the media-originals and attachments directories, the
 * task output display paths, the `agents.<id>.homedir` metadata field and the
 * workspace bucket id the cron store and v1 projections address. Those facts
 * arrive as ONE typed capability object on the lease
 * (`ISessionRuntimeContext.hostFiles`); this module owns the contract, the DI
 * token the activation seeds, the absent value headless leases get, and the
 * factory implementing the frozen within-session layout conventions
 * (`logs/kimi-code.log`, `agents/<id>/plans/<id>.md`, `media-originals/`,
 * `attachments/`). The ABSOLUTE root is always supplied by the owning
 * runtime's adapter — callers never compose it themselves.
 *
 * Consumers degrade by the `null` returns exactly like the pre-M8b
 * empty-`sessionDir` checks: no host directory means no plan file path, no
 * session log file, temp-cache media originals and an omitted `homedir`.
 * Registration-time gating (the `session.host_dir` capability string) keeps
 * the services that cannot degrade — the session log writer and the plan-mode
 * tools — off a host-files-less activation entirely.
 *
 * Pure contract + path composition against a caller-supplied root — no IO, no
 * store. Session-scoped.
 */

import { join } from 'pathe';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { resolveSessionLogPath } from '#/_base/log/logConfig';

/**
 * The host-directory facts of one session lease. Every member is `null` (and
 * `workspaceId` is `''`) on the absent value a headless lease seeds — the
 * same degradation contract the pre-M8b empty-`sessionDir` checks expressed.
 *
 * `workspaceId` is the owning runtime's session-bucket id — the Local
 * runtime's `wd_id`. It is NOT a workspace descriptor and never routes
 * anything in Session Core; the session's cron store addressing
 * (`cron/<wd_id>/`), the metadata read-model row and the v1 `workspace_id`
 * projections all read it as an opaque fact. A runtime without a bucket (the
 * headless hosts) leaves it empty.
 */
export interface ISessionHostFiles {
  readonly _serviceBrand: undefined;

  readonly workspaceId: string;
  /** Absolute path of the session's host directory. */
  readonly sessionDir: string | null;
  /** Absolute path of the session log file (`<sessionDir>/logs/kimi-code.log`). */
  readonly sessionLogPath: string | null;
  /** Absolute path of the pre-compression image originals directory. */
  readonly mediaOriginalsDir: string | null;
  /** Absolute path of the prompt-attachment materialization directory. */
  readonly attachmentsDir: string | null;
  /** Absolute path of one agent's home directory (`homedir` metadata, task display roots). */
  agentDir(agentId: string): string | null;
  /** Absolute path of one plan's working document. */
  planFilePath(agentId: string, planId: string): string | null;
}

export const ISessionHostFiles: ServiceIdentifier<ISessionHostFiles> =
  createDecorator<ISessionHostFiles>('sessionHostFiles');

/**
 * The host-files view of a lease whose runtime owns no per-session host
 * directory (headless runtimes): every fact is absent. Seeded by the
 * runtime-backed activation when `ISessionRuntimeContext.hostFiles` is
 * undefined, so consumers inject the token unconditionally.
 */
export const NO_SESSION_HOST_FILES: ISessionHostFiles = {
  _serviceBrand: undefined,
  workspaceId: '',
  sessionDir: null,
  sessionLogPath: null,
  mediaOriginalsDir: null,
  attachmentsDir: null,
  agentDir: () => null,
  planFilePath: () => null,
};

/**
 * The host-files view over one real session directory. The within-session
 * relative layout (`logs/kimi-code.log`, `agents/<id>/plans/<id>.md`,
 * `media-originals/`, `attachments/`) is the frozen legacy convention the v1
 * engine writes today — the caller (the Local workspace runtime, or a test
 * harness emulating one) supplies the absolute `sessionDir`, so the
 * `sessions/<wd_id>/<sessionId>` bucket addressing itself never leaves the
 * Local adapter. `media-originals` mirrors the media domain's
 * `sessionMediaOriginalsDir` convention (frozen by the on-disk layout; the
 * helper stays with the media domain for its own callers).
 */
export function makeSessionHostFiles(input: {
  readonly workspaceId: string;
  readonly sessionDir: string;
}): ISessionHostFiles {
  const { workspaceId, sessionDir } = input;
  return {
    _serviceBrand: undefined,
    workspaceId,
    sessionDir,
    sessionLogPath: resolveSessionLogPath(sessionDir),
    mediaOriginalsDir: join(sessionDir, 'media-originals'),
    attachmentsDir: join(sessionDir, 'attachments'),
    agentDir: (agentId) => join(sessionDir, 'agents', agentId),
    planFilePath: (agentId, planId) => join(sessionDir, 'agents', agentId, 'plans', `${planId}.md`),
  };
}
