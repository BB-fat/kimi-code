/**
 * v1 live-session bridge (multi-runtime refactor, M5c; plan §6.3: "需要 live
 * Session 的 route 在 resolver 得到 SessionRef 后由内部 service 执行
 * open/resume，再继续原逻辑").
 *
 * Every v1 route that needs a LIVE session (prompt, profile POST, status,
 * goal, warnings, children POST, the `:fork`/`:archive`/`:restore`/`:compact`
 * /`:undo`/`:abort`/`:btw` actions, approvals, questions, skills, fs,
 * terminals, messages) resolves its bare `{session_id}` HERE and obtains the
 * live handle in exactly two steps:
 *
 *   1. `IV1SessionRefResolver.resolve` — the single bare-id entry point
 *      (plan §1.3). Failure kinds map onto the FROZEN v1 envelopes through
 *      {@link v1LiveSessionFailureEnvelope} (`40401` / `50001`, no new
 *      fields, no candidates).
 *   2. Live lookup FIRST, runtime resume SECOND: `ISessionLifecycleService`
 *      is the process-wide live lookup — every runtime-activated session
 *      the host publishes through `trackActivated` (M8a: it is the ONLY
 *      source; the facade activates nothing itself). A hit is returned
 *      as-is, so an already-active session is NEVER re-activated (no
 *      double scope). Only a miss goes to
 *      `IRuntimeSessionHostService.resume(ref)`, the runtime `open/resume`
 *      path that cold-loads the session from its owner runtime.
 *
 * Resume outcome mapping (legacy `resume` parity):
 *
 *   - `undefined` (the session vanished between resolve and resume, or its
 *     runtime was unregistered) → `not_found` — the current "does not exist"
 *     40401 envelope;
 *   - `session.runtime_unavailable` (owner runtime registered but offline,
 *     plan §5.3) → `unavailable` — the frozen 50001 mapping, same as the
 *     resolver's;
 *   - anything else (a corrupt payload, a lease conflict) propagates to the
 *     route's existing error mapping, exactly like a legacy resume failure.
 */

import {
  IRuntimeSessionHostService,
  ISessionLifecycleService,
  SessionHostRuntimeErrors,
  isSessionHostRuntimeError,
  type ISessionScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

import { errEnvelope } from '../../envelope';
import {
  createV1SessionRefResolver,
  v1ResolveFailureEnvelope,
  type V1SessionRefResolution,
} from './v1SessionRefResolver';

export type V1LiveSessionResult =
  | {
      readonly kind: 'live';
      readonly handle: ISessionScopeHandle;
      /** The resolver outcome — routes that need the ref/descriptor reuse it. */
      readonly resolution: V1SessionRefResolution;
    }
  | { readonly kind: 'not_found' }
  /** Internal cause `session.identity_ambiguous` — never leaks candidates. */
  | { readonly kind: 'ambiguous' }
  /** Internal cause `session.runtime_unavailable` — "unknown" is not "absent". */
  | { readonly kind: 'unavailable' };

/**
 * Resolve a bare v1 session id AND ensure its session is live: the live
 * lookup wins, a cold session is resumed through its owner runtime.
 */
export async function resolveV1LiveSession(
  core: Scope,
  sessionId: string,
): Promise<V1LiveSessionResult> {
  const resolution = await createV1SessionRefResolver(core).resolve(sessionId);
  if (resolution.kind !== 'resolved') {
    return { kind: resolution.kind };
  }
  return ensureV1LiveSession(core, resolution.resolution);
}

/**
 * The live half of {@link resolveV1LiveSession} for routes that already
 * resolved the ref themselves (e.g. the `:restore` action, which gates on the
 * resolver first for its own wire semantics).
 */
export async function ensureV1LiveSession(
  core: Scope,
  resolution: V1SessionRefResolution,
): Promise<V1LiveSessionResult> {
  const sessionId = resolution.ref.sessionId;
  // The process-wide live lookup is fed by `trackActivated` alone (M8a):
  // every session the runtime session host activated — including the ones
  // the in-process SDK/klient facade and the debug-RPC path activated
  // through it — is published here. A hit means the session is already
  // active — returning it avoids a double activation.
  const live = core.accessor.get(ISessionLifecycleService).get(sessionId);
  if (live !== undefined) {
    return { kind: 'live', handle: live, resolution };
  }
  let scope;
  try {
    scope = await core.accessor.get(IRuntimeSessionHostService).resume(resolution.ref);
  } catch (error) {
    if (
      isSessionHostRuntimeError(
        error,
        SessionHostRuntimeErrors.codes.SESSION_RUNTIME_UNAVAILABLE,
      )
    ) {
      return { kind: 'unavailable' };
    }
    throw error;
  }
  if (scope === undefined) {
    return { kind: 'not_found' };
  }
  return { kind: 'live', handle: scope.handle, resolution };
}

/**
 * Map a failed live-session resolution onto the FROZEN v1 error envelope —
 * identical to the resolver's mapping (`40401` "does not exist" for
 * `not_found`, `50001` for `ambiguous` / `unavailable`).
 */
export function v1LiveSessionFailureEnvelope(
  result: Exclude<V1LiveSessionResult, { readonly kind: 'live' }>,
  sessionId: string,
  requestId: string,
): ReturnType<typeof errEnvelope> {
  return v1ResolveFailureEnvelope(result, sessionId, requestId);
}
