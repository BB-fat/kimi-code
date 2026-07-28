/**
 * `sessionHostRuntime` domain — the native session identity (plan §1.2).
 *
 * Every internal session reference is a full `SessionRef`: the id of the
 * long-lived host runtime that owns the session, plus the runtime-local
 * session id. Several sessions hosted by the same runtime share its
 * `runtimeId`; different runtimes may host sessions with the same `sessionId`.
 *
 * The v1 wire keeps using bare `session_id` strings — mapping between bare
 * ids and full refs happens only at the kap-server compatibility edge. This
 * type never carries workspace identifiers or physical paths.
 */

export interface SessionRef {
  /**
   * Process-unique, stable id of the owning `ISessionHostRuntime`, assigned
   * by composition/provider registration. A runtime that reconnects must
   * re-register under the same id for existing refs to keep routing.
   */
  readonly runtimeId: string;
  /**
   * Runtime-local session identifier. Only the owning runtime validates,
   * mints and parses it; uniqueness is required within that runtime only.
   */
  readonly sessionId: string;
}

/**
 * Canonical string key for internal maps/caches. Both segments are
 * URI-encoded so any pair of ids yields an unambiguous, reversible key.
 * Internal services pass the structured `SessionRef`; this key exists only
 * for map/cache addressing and must never appear on the v1 wire.
 */
export function sessionRefKey(ref: SessionRef): string {
  return `${encodeURIComponent(ref.runtimeId)}:${encodeURIComponent(ref.sessionId)}`;
}

/**
 * `SessionRef` is a value object: equality always compares both fields.
 */
export function sessionRefEquals(a: SessionRef, b: SessionRef): boolean {
  return a.runtimeId === b.runtimeId && a.sessionId === b.sessionId;
}
