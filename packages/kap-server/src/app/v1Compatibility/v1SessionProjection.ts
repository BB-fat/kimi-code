/**
 * v1 session projection (multi-runtime refactor, plan §6.2/§5.5): internal
 * `SessionDescriptor`s resolved by `IV1SessionRefResolver` are projected onto
 * the same summary shape the legacy `ISessionIndex` produced, so the existing
 * wire builders (`toWireSession` and friends) keep working byte-identically.
 *
 * Downstream NEVER exposes `runtimeId`, `SessionRef` or internal diagnostics:
 * the projection only carries the fields the current wire `Session` already
 * has (`id`, `workspace_id`, `metadata.cwd`, title, timestamps, archived,
 * custom metadata).
 *
 * Field provenance, mirroring the pre-migration reads one-to-one:
 *
 *   - `workspaceId` — the owning runtime's workspace registration (the
 *     legacy bucket id). A runtime without a workspace registration is not
 *     projectable (the v1 world has no workspace-less sessions).
 *   - `cwd` — the session's own persisted `metadata.cwd` first (the gap-G3
 *     fact on `state.json`); the workspace catalog root is only the
 *     back-compat fallback for sessions written before `cwd` was persisted.
 *     Neither recoverable → not projectable (the route keeps its current
 *     "no recoverable cwd" 40401 branch).
 */

import {
  IWorkspaceRuntimeManager,
  IWorkspaceService,
  type Scope,
  type SessionDescriptor,
} from '@moonshot-ai/agent-core-v2';

import { errEnvelope } from '../../envelope';
import { ErrorCode } from '../../protocol/error-codes';
import {
  createV1SessionRefResolver,
  v1ResolveFailureEnvelope,
  type V1SessionRefResolution,
} from './v1SessionRefResolver';

/** The index-shaped summary the wire builders already consume. */
export interface V1SessionSummaryFields {
  readonly id: string;
  readonly workspaceId: string;
  readonly cwd?: string;
  readonly title?: string;
  readonly lastPrompt?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
  readonly custom?: Record<string, unknown>;
}

/** One resolved session with everything the v1 wire needs to project it. */
export interface V1SessionView {
  readonly resolution: V1SessionRefResolution;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly summary: V1SessionSummaryFields;
}

/** Runtime/workspace lookups the projection resolves ids and roots through. */
export interface V1ProjectionLookups {
  readonly workspaceIdByRuntimeId: ReadonlyMap<string, string>;
  readonly rootByWorkspaceId: ReadonlyMap<string, string>;
}

/**
 * Build the lookup maps from the live core: workspace registrations (runtime
 * id → workspace id) and the workspace catalog (workspace id → root). The
 * catalog `list()` is root-deduped — alias id spellings fall through to the
 * descriptor's own `cwd`, exactly like the pre-migration `roots` fallback.
 */
export async function buildV1ProjectionLookups(core: Scope): Promise<V1ProjectionLookups> {
  const registrations = core.accessor.get(IWorkspaceRuntimeManager).list();
  const workspaces = await core.accessor.get(IWorkspaceService).list();
  return {
    workspaceIdByRuntimeId: new Map(
      registrations.map((entry) => [entry.runtimeId, entry.workspaceId]),
    ),
    rootByWorkspaceId: new Map(workspaces.map((workspace) => [workspace.id, workspace.root])),
  };
}

function metadataString(descriptor: SessionDescriptor, key: string): string | undefined {
  const value = descriptor.metadata[key];
  return typeof value === 'string' ? value : undefined;
}

function metadataRecord(descriptor: SessionDescriptor, key: string): Record<string, unknown> | undefined {
  const value = descriptor.metadata[key];
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Project one resolved session. `undefined` means the session is not
 * projectable onto the v1 wire (no workspace registration for its runtime,
 * or no recoverable cwd) — the caller maps that onto the SAME response it
 * gave before the migration (skip in lists; the "no recoverable cwd" 40401
 * branch in get).
 */
export function projectV1Session(
  resolution: V1SessionRefResolution,
  lookups: V1ProjectionLookups,
): V1SessionView | undefined {
  const { descriptor } = resolution;
  const workspaceId = lookups.workspaceIdByRuntimeId.get(resolution.ref.runtimeId);
  if (workspaceId === undefined) return undefined;
  const cwd = metadataString(descriptor, 'cwd') ?? lookups.rootByWorkspaceId.get(workspaceId);
  if (cwd === undefined) return undefined;
  return {
    resolution,
    workspaceId,
    cwd,
    summary: {
      id: resolution.ref.sessionId,
      workspaceId,
      cwd: metadataString(descriptor, 'cwd'),
      title: metadataString(descriptor, 'title'),
      lastPrompt: metadataString(descriptor, 'lastPrompt'),
      createdAt: Date.parse(descriptor.createdAt),
      updatedAt: Date.parse(descriptor.updatedAt),
      archived: descriptor.status === 'archived',
      custom: metadataRecord(descriptor, 'custom'),
    },
  };
}

/**
 * Resolve + project in one step for the id-targeted routes. The resolve
 * result passes through untouched on failure (`not_found` / `ambiguous` /
 * `unavailable`); a resolved-but-unprojectable session reports as
 * `unprojectable` so the route can keep its legacy "no recoverable cwd"
 * branch.
 */
export type V1SessionViewResult =
  | { readonly kind: 'view'; readonly view: V1SessionView }
  | { readonly kind: 'unprojectable' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'ambiguous' }
  | { readonly kind: 'unavailable' };

/**
 * Resolve a bare v1 session id through the ref resolver and project the
 * result in one step — the shared prelude of every id-targeted cold/descriptor
 * route. Failure kinds pass through untouched so the caller maps them onto
 * the frozen envelopes with {@link v1SessionViewFailureEnvelope}.
 */
export async function resolveV1SessionView(
  core: Scope,
  sessionId: string,
): Promise<V1SessionViewResult> {
  const resolved = await createV1SessionRefResolver(core).resolve(sessionId);
  if (resolved.kind !== 'resolved') {
    return { kind: resolved.kind };
  }
  const view = projectV1Session(resolved.resolution, await buildV1ProjectionLookups(core));
  return view === undefined ? { kind: 'unprojectable' } : { kind: 'view', view };
}

/**
 * Map a failed {@link resolveV1SessionView} onto the route's CURRENT error
 * envelopes: `not_found` keeps the "does not exist" 40401, an unprojectable
 * session keeps the legacy "has no recoverable cwd" 40401 branch, and the
 * multi-runtime failure kinds defer to the frozen resolver mapping (plan
 * §1.3 — no candidates, no new fields).
 */
export function v1SessionViewFailureEnvelope(
  result: Exclude<V1SessionViewResult, { readonly kind: 'view' }>,
  sessionId: string,
  requestId: string,
): ReturnType<typeof errEnvelope> {
  if (result.kind === 'unprojectable') {
    return errEnvelope(
      ErrorCode.SESSION_NOT_FOUND,
      `session ${sessionId} has no recoverable cwd`,
      requestId,
    );
  }
  return v1ResolveFailureEnvelope(result, sessionId, requestId);
}
