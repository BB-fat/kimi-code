/**
 * `sessionHostRuntime` domain — the cross-runtime transfer contract
 * (plan §3.5). M0 ships types only; the coordinating implementation lands
 * with the transfer milestone.
 *
 * Data plane:
 *
 *   sourceRuntime.sessions.export(source.sessionId)
 *     → validated logical SessionExportEntry stream
 *     → transfer coordinator (checksum / progress / retry)
 *     → targetRuntime.sessions.import(stream)
 *     → target commit
 *     → new SessionRef
 *
 * Invariants the implementation must keep:
 *
 *   - The source stays consistent (snapshot or revision token) across the
 *     whole export window and is re-validated before commit; a change aborts
 *     with `session.transfer_source_changed`.
 *   - The target owns staging/transaction/reconcile; an uncommitted session
 *     is invisible to list/get. Failure never changes the source owner.
 *   - The stream carries logical kind/owner/name/content/checksum/schema
 *     version only — no source physical paths, workspace ids or `wd_id`.
 *   - After success the source is kept by default; a move deletes the source
 *     explicitly, only after target validation completed.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { SameRuntimeForkInput } from './sessionManager';
import type { SessionRef } from './sessionRef';
import type { SessionDescriptor } from './sessionRuntimeContext';

export interface TransferSessionInput {
  readonly source: SessionRef;
  readonly targetRuntimeId: string;
  /** Runtime-local id at the target; minted by the target runtime when absent. */
  readonly targetSessionId?: string;
  /** Delete the source after the target validated its commit (a move). */
  readonly deleteSource?: boolean;
}

export interface SessionTransferResult {
  /** The session's new identity at the target runtime. */
  readonly target: SessionRef;
  /** Whether the source was deleted (move) or kept (copy). */
  readonly sourceDeleted: boolean;
}

/**
 * Cross-runtime fork: export from the source runtime, import into the target
 * runtime, keep the source. Same-runtime forks never go through here — they
 * call `runtime.sessions.fork` directly.
 */
export interface CrossRuntimeForkInput extends SameRuntimeForkInput {
  readonly source: SessionRef;
  readonly targetRuntimeId: string;
}

export interface ISessionTransferService {
  readonly _serviceBrand: undefined;

  transfer(input: TransferSessionInput): Promise<SessionTransferResult>;
  forkAcrossRuntimes(input: CrossRuntimeForkInput): Promise<SessionDescriptor>;
}

export const ISessionTransferService: ServiceIdentifier<ISessionTransferService> =
  createDecorator<ISessionTransferService>('sessionTransferService');
