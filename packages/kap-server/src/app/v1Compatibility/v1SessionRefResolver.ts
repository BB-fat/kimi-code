/**
 * `IV1SessionRefResolver` — the SINGLE entry point that resolves a bare v1
 * `{session_id}` into an internal `SessionRef` (multi-runtime refactor, plan
 * §1.3/§6.2/§7.6).
 *
 * Every existing v1 HTTP route (and, from M6 on, the WS adapter) that carries
 * only a bare session id resolves it HERE: the resolver fans a probe out over
 * the currently queryable runtimes of `ISessionHostRuntimeRegistry`
 * (`runtime.sessions.get`), and applies the plan's five rules:
 *
 *   1. NO match        → `not_found` — the route maps it to the CURRENT v1
 *                        not-found numeric code + envelope (`40401`).
 *   2. Exactly ONE     → `resolved`, carrying the full `SessionRef`, the
 *                        owning runtime and its descriptor.
 *   3. MULTIPLE matches→ `ambiguous` — internal cause
 *                        `session.identity_ambiguous`; the edge still answers
 *                        the stable existing envelope (no candidate fields,
 *                        no schema change) and NEVER silently picks the first
 *                        match by registration order, local preference,
 *                        recency or any default (rule 5).
 *   4. A runtime is    → `unavailable` — internal cause
 *      offline/unavail.   `session.runtime_unavailable`; "not queried" is
 *                        never treated as "does not exist".
 *
 * Before concluding `not_found`, the resolver runs ONE discovery catch-up
 * (`ensureDiscovered`, composition-owned): locally persisted buckets whose
 * workspace runtime was never opened in this process get registered, so the
 * resolvable set matches what the legacy session index sees — including
 * buckets of tombstoned or never-cataloged workspaces.
 *
 * The resolver lives ONLY in the kap-server v1 compatibility edge; internal
 * services always pass a full `SessionRef` and never resolve bare ids.
 */

import {
  isSessionHostRuntimeError,
  ISessionHostRuntimeRegistry,
  IWorkspaceRuntimeManager,
  SessionHostRuntimeErrors,
  type ISessionHostRuntime,
  type Scope,
  type SessionDescriptor,
  type SessionRef,
} from '@moonshot-ai/agent-core-v2';

import { errEnvelope } from '../../envelope';
import { ErrorCode } from '../../protocol/error-codes';

/** One successfully resolved bare id: ref + owner runtime + its descriptor. */
export interface V1SessionRefResolution {
  readonly ref: SessionRef;
  readonly runtime: ISessionHostRuntime;
  readonly descriptor: SessionDescriptor;
}

export type V1SessionRefResolveResult =
  | { readonly kind: 'resolved'; readonly resolution: V1SessionRefResolution }
  | { readonly kind: 'not_found' }
  /** Internal cause `session.identity_ambiguous` — never leaks candidates. */
  | { readonly kind: 'ambiguous' }
  /** Internal cause `session.runtime_unavailable` — "unknown" is not "absent". */
  | { readonly kind: 'unavailable' };

export interface IV1SessionRefResolver {
  /**
   * Resolve one bare v1 session id. The five rules of plan §1.3 apply; the
   * result is a discriminated union so routes map each failure onto the
   * frozen v1 error envelope without ever seeing internal causes.
   */
  resolve(sessionId: string): Promise<V1SessionRefResolveResult>;

  /**
   * Every resolvable session across every online runtime (the v1 list data
   * plane, plan §5.5): the adapter merges, sorts and re-projects pagination
   * onto the existing wire semantics. Offline/unavailable runtimes are
   * skipped — a list is best-effort enumeration, never an identity verdict.
   */
  listAll(): Promise<readonly V1SessionRefResolution[]>;
}

export interface V1SessionRefResolverDeps {
  readonly registry: ISessionHostRuntimeRegistry;
  /**
   * Composition catch-up that registers runtimes for locally discoverable
   * buckets (`IWorkspaceRuntimeManager.ensureDiscovered` in production). Runs
   * at most once per `resolve` (only when the first probe round finds no
   * match) and once per `listAll`.
   */
  readonly ensureDiscovered: () => Promise<unknown>;
  readonly logger?: {
    warn(obj: Record<string, unknown>, msg: string): void;
  };
}

/**
 * Map a failed resolution onto the FROZEN v1 error envelope (plan §1.3/§8):
 * the internal causes (`session.identity_ambiguous`,
 * `session.runtime_unavailable`) stay in logs — the wire keeps the existing
 * numeric codes and the existing envelope shape, with no candidate fields.
 *
 *   - `not_found`   → `40401` with the route's current "does not exist" msg;
 *   - `ambiguous` / `unavailable` → `50001`: the session EXISTS (or may
 *     exist) but cannot be routed right now. Answering `40401` would tell
 *     clients to treat the session as gone — a lie for a transient or
 *     conflict state; `50001` is the existing code for "the server could not
 *     serve this request".
 */
export function v1ResolveFailureEnvelope(
  result: Exclude<V1SessionRefResolveResult, { readonly kind: 'resolved' }>,
  sessionId: string,
  requestId: string,
): ReturnType<typeof errEnvelope> {
  switch (result.kind) {
    case 'not_found':
      return errEnvelope(
        ErrorCode.SESSION_NOT_FOUND,
        `session ${sessionId} does not exist`,
        requestId,
      );
    case 'ambiguous':
      return errEnvelope(
        ErrorCode.INTERNAL_ERROR,
        `session ${sessionId} is ambiguous across runtimes`,
        requestId,
      );
    case 'unavailable':
      return errEnvelope(
        ErrorCode.INTERNAL_ERROR,
        `session ${sessionId} is temporarily unavailable`,
        requestId,
      );
  }
}

/**
 * Wire the resolver onto the live core scope: the registry and the discovery
 * catch-up (`IWorkspaceRuntimeManager.ensureDiscovered`) come straight from
 * the App container. The resolver itself is stateless — one instance per
 * route module is fine, and tests substitute both deps.
 */
export function createV1SessionRefResolver(
  core: Scope,
  logger?: V1SessionRefResolverDeps['logger'],
): V1SessionRefResolver {
  return new V1SessionRefResolver({
    registry: core.accessor.get(ISessionHostRuntimeRegistry),
    ensureDiscovered: () => core.accessor.get(IWorkspaceRuntimeManager).ensureDiscovered(),
    logger,
  });
}

export class V1SessionRefResolver implements IV1SessionRefResolver {
  constructor(private readonly deps: V1SessionRefResolverDeps) {}

  async resolve(sessionId: string): Promise<V1SessionRefResolveResult> {
    let probe = await this.probe(sessionId);
    if (probe.matches.length === 0) {
      // The session may live in a bucket whose runtime was never opened in
      // this process: run the composition catch-up once, then probe again.
      await this.deps.ensureDiscovered();
      probe = await this.probe(sessionId);
    }
    if (probe.matches.length === 1) {
      return { kind: 'resolved', resolution: probe.matches[0]! };
    }
    if (probe.matches.length > 1) {
      // Rule 3 + 5: report ambiguity, NEVER pick a candidate silently.
      this.deps.logger?.warn(
        {
          sessionId,
          runtimeIds: probe.matches.map((match) => match.ref.runtimeId),
          cause: SessionHostRuntimeErrors.codes.SESSION_IDENTITY_AMBIGUOUS,
        },
        'v1 session id matched more than one runtime',
      );
      return { kind: 'ambiguous' };
    }
    if (probe.unavailableSeen) {
      // Rule 4: an unreachable runtime could own the session — absence is
      // not proven.
      this.deps.logger?.warn(
        { sessionId, cause: SessionHostRuntimeErrors.codes.SESSION_RUNTIME_UNAVAILABLE },
        'v1 session id could not be probed on every runtime',
      );
      return { kind: 'unavailable' };
    }
    return { kind: 'not_found' };
  }

  async listAll(): Promise<readonly V1SessionRefResolution[]> {
    await this.deps.ensureDiscovered();
    const summaries = this.deps.registry.list();
    const online = summaries.filter((summary) => summary.status !== 'offline');
    const pages = await Promise.all(
      online.map(async (summary) => {
        const runtime = this.deps.registry.get(summary.id);
        if (runtime === undefined) return [];
        try {
          const page = await runtime.sessions.list();
          return page.items.map((descriptor) => ({
            ref: descriptor.ref,
            runtime,
            descriptor,
          }));
        } catch (error) {
          // A runtime that went unavailable mid-list contributes nothing (the
          // legacy index tolerates an unreadable bucket the same way); every
          // other runtime still answers.
          this.deps.logger?.warn(
            { runtimeId: summary.id, err: error instanceof Error ? error.message : error },
            'v1 session list skipped an unavailable runtime',
          );
          return [];
        }
      }),
    );
    return pages.flat();
  }

  /**
   * Fan the bare id over every online runtime. Offline registry entries (and
   * runtimes that flip unavailable mid-probe) count as `unavailableSeen`:
   * they cannot answer, so "no match anywhere" must not become "not found".
   */
  private async probe(
    sessionId: string,
  ): Promise<{ matches: V1SessionRefResolution[]; unavailableSeen: boolean }> {
    const summaries = this.deps.registry.list();
    let unavailableSeen = summaries.some((summary) => summary.status === 'offline');
    const matches = await Promise.all(
      summaries
        .filter((summary) => summary.status !== 'offline')
        .map(async (summary): Promise<V1SessionRefResolution | undefined> => {
          const runtime = this.deps.registry.get(summary.id);
          if (runtime === undefined) return undefined;
          try {
            const descriptor = await runtime.sessions.get(sessionId);
            return descriptor === undefined
              ? undefined
              : { ref: descriptor.ref, runtime, descriptor };
          } catch (error) {
            if (
              isSessionHostRuntimeError(
                error,
                SessionHostRuntimeErrors.codes.SESSION_RUNTIME_UNAVAILABLE,
              )
            ) {
              unavailableSeen = true;
              return undefined;
            }
            throw error;
          }
        }),
    );
    return {
      matches: matches.filter((match) => match !== undefined),
      unavailableSeen,
    };
  }
}
