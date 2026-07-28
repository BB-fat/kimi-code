/**
 * `sessionHostRuntime` domain — internal coded causes for the multi-runtime
 * session architecture (plan §8).
 *
 * These codes are internal causes used by services, logs and diagnostics. They
 * are NOT new v1 wire error codes: the kap-server v1 compatibility edge maps
 * them onto the existing numeric error codes/envelope and never leaks them as
 * new response fields.
 *
 * `session.not_found` is deliberately absent here — it is already owned by the
 * `session` domain (`SessionErrors`, shared by the session layer), and the
 * error-code registry rejects two domains claiming the same code. Throw sites
 * in this domain reuse `ErrorCodes.SESSION_NOT_FOUND` from the `#/errors`
 * facade.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';
import { Error2, type Error2Options } from '#/_base/errors/errors';

export const SessionHostRuntimeErrors = {
  codes: {
    /** An internal caller referenced a runtime id that was never registered. */
    SESSION_RUNTIME_NOT_FOUND: 'session.runtime_not_found',
    /** The runtime is registered but offline, disconnected, or cannot open. */
    SESSION_RUNTIME_UNAVAILABLE: 'session.runtime_unavailable',
    /** A second runtime instance registered under an already-taken runtime id. */
    SESSION_RUNTIME_ID_CONFLICT: 'session.runtime_id_conflict',
    /** A bare (v1) session id matched sessions in more than one runtime. */
    SESSION_IDENTITY_AMBIGUOUS: 'session.identity_ambiguous',
    /** open/resume lost the per-session lease arbitration (concurrent lease). */
    SESSION_LEASE_CONFLICT: 'session.lease_conflict',
    /** The caller explicitly required a capability the runtime does not project. */
    SESSION_CAPABILITY_UNAVAILABLE: 'session.capability_unavailable',
    /** The runtime could not build a complete session context/lease. */
    SESSION_OPEN_FAILED: 'session.open_failed',
    /** Cross-runtime export/import/commit failed. */
    SESSION_TRANSFER_FAILED: 'session.transfer_failed',
    /** The source revision changed while a transfer was exporting it. */
    SESSION_TRANSFER_SOURCE_CHANGED: 'session.transfer_source_changed',
    /** An `ArtifactRef` did not match the runtime/session/owner it was read through. */
    ARTIFACT_OWNER_MISMATCH: 'artifact.owner_mismatch',
  },
  retryable: ['session.runtime_unavailable', 'session.lease_conflict'],
} as const satisfies ErrorDomain;

registerErrorDomain(SessionHostRuntimeErrors);

export type SessionHostRuntimeErrorCode =
  (typeof SessionHostRuntimeErrors.codes)[keyof typeof SessionHostRuntimeErrors.codes];

export class SessionHostRuntimeError extends Error2 {
  constructor(code: SessionHostRuntimeErrorCode, message: string, options?: Error2Options) {
    super(code, message, options);
    this.name = 'SessionHostRuntimeError';
  }
}

export function isSessionHostRuntimeError(
  error: unknown,
  code: SessionHostRuntimeErrorCode,
): boolean {
  return error instanceof SessionHostRuntimeError && error.code === code;
}
