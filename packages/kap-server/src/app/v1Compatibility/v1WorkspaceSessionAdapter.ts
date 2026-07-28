/**
 * v1 Workspace create compatibility adapter (multi-runtime refactor, plan
 * §4.2/§5.1/§5.2/§6.2).
 *
 * This adapter owns the `POST /api/v1/sessions` create flow's Workspace side:
 * it resolves `workspace_id` / `metadata.cwd` with the CURRENT rules
 * (`IWorkspaceService.get` for an explicit id — unknown id is the wire 40410;
 * `createOrTouch` for the registration — a missing/unusable root is the wire
 * 40409 through the route's `Error2` mapping), then obtains the workspace's
 * ALREADY-REGISTERED `IWorkspaceRuntime` from the registration manager
 * (`ensureRegistered` opens and registers it exactly once; every later create
 * for the same workspace reuses that instance — the registry's
 * `session.runtime_id_conflict` stands as the duplicate sentinel).
 *
 * Runtime create/register happens ONLY here: the generic
 * `ISessionService.create` and Session Core never open a provider, and no
 * per-session runtime is ever created (plan §6.2).
 *
 * Session creation itself keeps today's observable behavior exactly:
 *
 *   1. `runtime.sessions.create({ sessionId })` persists the session under the
 *      owner runtime (the M2 byte-identical `state.json` +
 *      `session_index.jsonl` layout — the persistence owner);
 *   2. `ISessionLifecycleService.create({ workDir, sessionId })` then builds
 *      the live Session scope through the EXISTING engine path: its metadata
 *      store tolerant-reads the state.json written in step 1 (same document
 *      version/shape, zero rewrite), and everything else about today's create
 *      — scope materialization, main-agent/plan-mode handling, lifecycle
 *      hooks (`SessionStart` with source `startup`), telemetry
 *      (`session_started { resumed: false }`), the session_index discovery
 *      line and the failure rollback — is preserved verbatim. The session id
 *      keeps the current globally-random `session_<uuid>` strategy, so the
 *      bare-id v1 wire never changes shape.
 *
 * The wire surface stays frozen: the route keeps its path/method/schema, its
 * numeric error codes and envelope, and projects the outcome with the same
 * `toWireSession` + `event.session.created` publication as before.
 */

import { randomUUID } from 'node:crypto';

import {
  ISessionLifecycleService,
  ISessionMetadata,
  IWorkspaceRuntimeManager,
  IWorkspaceService,
  type Scope,
  type SessionMeta,
  type Workspace,
} from '@moonshot-ai/agent-core-v2';

import { errEnvelope } from '../../envelope';
import { ErrorCode } from '../../protocol/error-codes';
import type { CreateSessionRequest } from '../../protocol/rest-session';

/** The adapter outcome the route projects; error envelopes are wire-frozen. */
export type V1CreateSessionOutcome =
  | {
      readonly kind: 'created';
      /** Fresh metadata read from the live session (title already applied). */
      readonly meta: SessionMeta;
      /** The catalog entry the create resolved/touched (id + root). */
      readonly workspace: Workspace;
    }
  | { readonly kind: 'error'; readonly envelope: V1CreateErrorEnvelope };

type V1CreateErrorEnvelope =
  | ReturnType<typeof errEnvelope>
  | ReturnType<typeof buildValidationEnvelope>;

/**
 * Resolve the create's workspace inputs with the current rules, create the
 * session through the registered workspace runtime, and activate it through
 * the existing lifecycle. Validation failures come back as frozen error
 * envelopes; `Error2` failures (`fs.path_not_found`, lifecycle errors)
 * propagate to the route's existing `sendMappedError`.
 */
export async function createV1WorkspaceSession(
  core: Scope,
  body: CreateSessionRequest,
  requestId: string,
): Promise<V1CreateSessionOutcome> {
  const callerCwd = typeof body.metadata?.cwd === 'string' ? body.metadata.cwd : undefined;
  const workspaceId = body.workspace_id;
  if (workspaceId === undefined && callerCwd === undefined) {
    return {
      kind: 'error',
      envelope: buildValidationEnvelope(
        [{ path: 'metadata.cwd', message: 'either workspace_id or metadata.cwd is required' }],
        requestId,
      ),
    };
  }

  const workspaces = core.accessor.get(IWorkspaceService);
  let workDir: string;
  if (workspaceId !== undefined) {
    const workspace = await workspaces.get(workspaceId);
    if (workspace === undefined) {
      return {
        kind: 'error',
        envelope: errEnvelope(
          ErrorCode.WORKSPACE_NOT_FOUND,
          `workspace ${workspaceId} does not exist`,
          requestId,
        ),
      };
    }
    if (callerCwd !== undefined && callerCwd !== workspace.root) {
      return {
        kind: 'error',
        envelope: buildValidationEnvelope(
          [
            {
              path: 'metadata.cwd',
              message: `metadata.cwd (${callerCwd}) must equal workspace root (${workspace.root})`,
            },
          ],
          requestId,
        ),
      };
    }
    workDir = workspace.root;
  } else {
    workDir = callerCwd as string;
  }

  // Ensure the workspace is registered so `metadata.cwd` is resolvable on
  // read (gap G3 — v2 does not store workDir on the session). Throws
  // `fs.path_not_found` for a missing/unusable root (the wire 40409).
  const touched = await workspaces.createOrTouch(workDir);

  // Resolve the workspace's long-lived runtime, opening + registering it only
  // when absent; an existing registration is reused as-is (plan §9.4: two
  // creates must share one runtime). Runtime create/register lives ONLY in
  // this adapter — Session Core and the generic session service never see it.
  const runtime = await core.accessor.get(IWorkspaceRuntimeManager).ensureRegistered({
    workspaceId: touched.id,
    root: touched.root,
  });

  // The owner runtime persists the session (M2 byte-identical layout); the
  // existing lifecycle path then activates it live with today's full behavior.
  const sessionId = `session_${randomUUID()}`;
  await runtime.sessions.create({ sessionId });
  const handle = await core.accessor.get(ISessionLifecycleService).create({ workDir, sessionId });

  if (typeof body.title === 'string') {
    await handle.accessor.get(ISessionMetadata).setTitle(body.title);
  }
  const meta = await handle.accessor.get(ISessionMetadata).read();
  return { kind: 'created', meta, workspace: touched };
}

/** The v1 validation-envelope builder (same shape as the route's local one). */
function buildValidationEnvelope(
  details: { path: string; message: string }[],
  requestId: string,
): {
  code: number;
  msg: string;
  data: null;
  request_id: string;
  details: { path: string; message: string }[];
} {
  const first = details[0];
  const msg =
    first === undefined
      ? 'validation failed'
      : first.path === ''
        ? first.message
        : `${first.path}: ${first.message}`;
  return {
    code: ErrorCode.VALIDATION_FAILED,
    msg,
    data: null,
    request_id: requestId,
    details,
  };
}
