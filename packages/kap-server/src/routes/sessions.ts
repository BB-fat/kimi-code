/**
 * `/sessions` route handlers — server-v2 port.
 *
 * Implements the v1 `/api/v1/sessions` wire contract on top of
 * `agent-core-v2` services:
 *   POST   /sessions                  create
 *   GET    /sessions                  list
 *   GET    /sessions/{session_id}     get
 *   GET    /sessions/{session_id}/profile
 *   POST   /sessions/{session_id}/profile      update title / metadata / agent_config
 *   POST   /sessions/{tail}                    action: fork / compact / undo /
 *                                              abort / btw / archive / restore
 *   GET    /sessions/{session_id}/children     list child sessions
 *   POST   /sessions/{session_id}/children     create child session (fork+tag)
 *   GET    /sessions/{session_id}/status       best-effort
 *   GET    /sessions/{session_id}/goal         current goal (null when none)
 *   GET    /sessions/{session_id}/warnings     session-level notices
 *
 * The `POST /sessions/{tail}` actions split into two groups. The thin
 * pass-throughs — `fork` / `compact` / `abort` / `archive` / `restore` —
 * resolve the bare id through the v1 ref resolver and delegate to the runtime
 * session host (M5c, plan §6.3): `IRuntimeSessionHostService.fork` /
 * `archive`, a resolver-gated ensure-live + un-archive for `restore` (the
 * legacy `restore` recipe, ownership-agnostic),
 * `IAgentFullCompactionService.begin`,
 * `IAgentRPCService.cancel`; there is no v1-only projection to centralize, so
 * no adapter is involved. `undo` likewise calls
 * `IAgentConversationUndoService.undo` directly (it throws
 * `session.undo_unavailable` with a structured reason) and only borrows
 * `ISessionLegacyService.status` for the cross-domain status rollup. The
 * `/sessions/{id}/children` endpoints fork through the runtime session host
 * with the child markers and parent-title default applied at the edge (the
 * legacy `createChild` recipe) and filter the resolver's cross-runtime list
 * by the same markers. Only `POST /sessions/{id}/profile` (`updateProfile`),
 * `GET /sessions/{id}/status`, and `GET /sessions/{id}/goal` go through
 * `ISessionLegacyService` (the `agent_config` patch, the status rollup, and the
 * current-goal read hold real cross-domain adaptation) — after the route has
 * ensured the session is live through the resolver + runtime open/resume, so
 * the legacy service's internal lookup always hits the active handle;
 * the route forwards each adapter result verbatim, mirroring v1's thin handler.
 * `create`, `fork`, and child creation publish `event.session.created` on the
 * core event bus, matching v1.
 *
 * `GET /sessions/{id}/warnings` surfaces session-level notices in the v1
 * `{ code, message, severity }` wire shape: the `agents-md-oversized` warning
 * (projected from the main agent's `IAgentProfileService.getAgentsMdWarning()`
 * — computed and cached when the agent binds a profile) and the
 * secondary-model early-validation warning (projected from the Session-scope
 * `ISessionSecondaryModelWarningService` — computed and cached when the main
 * agent is created). An unbound main agent or a valid/unset secondary model
 * yields an empty list, matching v1's "no warning" case.
 *
 * **Wire fidelity**: mirrors v1's `toProtocolSession`
 * (`packages/agent-core/src/services/session/session.ts`), which populates
 * only the index/metadata fields and returns placeholders for the heavy ones
 * (`agent_config:{model:''}`, `usage:zeros`, `permission_rules:[]`,
 * `message_count:0`, `last_seq:0`). v2 produces the same placeholder shape
 * from `ISessionIndex` (with `cwd` persisted on the session itself), and now
 * also surfaces `last_prompt` and the merged custom `metadata`.
 *
 * **Busy / last turn**: v1's `SessionService` overwrites the placeholder
 * `status` with the live value before projecting (`_patchSessionStatus`). v2
 * projects the orthogonal facts instead: `toWireSession` takes
 * `resolveSessionFacts` — `busy` from the session lifecycle's authoritative
 * drain registry and `last_turn_reason` from the main agent's activity view (a
 * cold session is not busy and carries no reason) — so both are real on every
 * session-producing endpoint here. `GET /sessions` and
 * `GET /sessions/{id}/children` filter their projected page by the `busy`
 * query param (post-page, matching v1 — `has_more` reflects the pre-filter
 * page), except `archived_only` lists filter busy before route pagination so
 * they can drain archived pages the same way v1 does.
 *
 * **cwd resolution (gap G3 closed)**: the session's frozen work dir is
 * persisted on its metadata document (`ISessionMetadata`) and surfaced on the
 * `ISessionIndex` summary, so `metadata.cwd` comes from the session itself —
 * not from `IWorkspaceService`. Sessions whose workspace was unregistered keep
 * their original cwd and stay listed / gettable (matching v1, which stores
 * `workDir` on the session). `IWorkspaceService` is consulted only as a
 * back-compat fallback for sessions written before `cwd` was persisted.
 */

import {
  CHILD_SESSION_KIND,
  CHILD_SESSION_KIND_KEY,
  ErrorCodes,
  IAgentContextMemoryService,
  IAgentProfileService,
  IAgentConversationUndoService,
  IAgentFullCompactionService,
  IAgentRPCService,
  IAuthSummaryService,
  IRuntimeSessionHostService,
  ISessionActivityView,
  ISessionBtwService,
  ISessionContext,
  ISessionLifecycleService,
  ISessionMetadata,
  ISessionLegacyService,
  ISessionSecondaryModelWarningService,
  IEventService,
  IWorkspaceAliases,
  PARENT_SESSION_ID_KEY,
  isError2,
  toProtocolMessage,
  type ContextMessage,
  type Scope,
  type SessionDescriptor,
} from '@moonshot-ai/agent-core-v2';
import { ErrorCode } from '../protocol/error-codes';
import { pageResponseSchema } from '../protocol/pagination';
import {
  archiveSessionResponseSchema,
  compactSessionRequestSchema,
  compactSessionResponseSchema,
  createSessionChildRequestSchema,
  createSessionRequestSchema,
  forkSessionRequestSchema,
  getSessionGoalResponseSchema,
  listSessionChildrenResponseSchema,
  sessionAbortResponseSchema,
  sessionStatusResponseSchema,
  sessionWarningsResponseSchema,
  startBtwSessionResponseSchema,
  undoSessionRequestSchema,
  undoSessionResponseSchema,
  updateSessionProfileRequestSchema,
} from '../protocol/rest-session';
import {
  emptySessionUsage,
  sessionSchema,
  type Session,
  type SessionPendingInteraction,
} from '../protocol/session';
import { workspaceIdSchema } from '../protocol/workspace';
import { z } from 'zod';

import {
  ensureV1LiveSession,
  resolveV1LiveSession,
  v1LiveSessionFailureEnvelope,
} from '../app/v1Compatibility/v1LiveSession';
import { createV1WorkspaceSession } from '../app/v1Compatibility/v1WorkspaceSessionAdapter';
import {
  createV1SessionRefResolver,
  v1ResolveFailureEnvelope,
} from '../app/v1Compatibility/v1SessionRefResolver';
import {
  buildV1ProjectionLookups,
  projectV1Session,
  resolveV1SessionView,
  v1SessionViewFailureEnvelope,
  type V1SessionSummaryFields,
} from '../app/v1Compatibility/v1SessionProjection';
import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ensureMainAgent } from '../transport/mainAgent';
import { parseActionSuffix } from './action-suffix';

interface SessionRouteHost {
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown; headers: Record<string, unknown> },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const booleanQueryParam = z.preprocess((value) => {
  if (value === 'true' || value === '1' || value === 1 || value === true) return true;
  if (value === 'false' || value === '0' || value === 0 || value === false) return false;
  return value;
}, z.boolean().optional());

const DEFAULT_SESSION_LIST_PAGE_SIZE = 20;

// NOTE: mirrors v1's `GET /sessions` query. `before_id`/`after_id` id-cursors
// and `page_size` ARE applied in the route handler (the `FileSessionIndex` does
// not implement `cursor`, so we page over its recency-sorted result); `status`
// filters the projected page (post-page, matching v1). `include_archive` →
// `includeArchived`; `archived_only` forces `includeArchived` and then keeps
// only archived sessions; `workspace_id` → `workspaceIds` after
// `resolveAliasIds` expands the alias set of the directory (legacy split
// buckets list as one workspace); `exclude_empty` drops sessions with no
// prompt.
const sessionsListQueryCoercion = z
  .object({
    before_id: z.string().min(1).optional(),
    after_id: z.string().min(1).optional(),
    page_size: z.coerce.number().int().min(1).max(100).optional(),
    busy: booleanQueryParam,
    include_archive: booleanQueryParam,
    exclude_empty: booleanQueryParam,
    archived_only: booleanQueryParam,
    workspace_id: workspaceIdSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.before_id !== undefined && value.after_id !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'before_id and after_id are mutually exclusive',
        path: ['before_id'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
    if (value.archived_only === true && value.include_archive === true) {
      ctx.addIssue({
        code: 'custom',
        message: 'archived_only and include_archive are mutually exclusive',
        path: ['archived_only'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
  });

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

// Mirrors v1's children query: id-cursors + page_size + busy. The route
// projects the live busy fact onto each child and filters the page by it
// (post-page, matching v1); the child-marker filtering runs over the
// resolver's cross-runtime list (same markers the index matched), the busy
// filter stays at the edge.
const sessionChildrenListQueryCoercion = z
  .object({
    before_id: z.string().min(1).optional(),
    after_id: z.string().min(1).optional(),
    page_size: z.coerce.number().int().min(1).max(100).optional(),
    busy: booleanQueryParam,
  })
  .superRefine((value, ctx) => {
    if (value.before_id !== undefined && value.after_id !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'before_id and after_id are mutually exclusive',
        path: ['before_id'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
  });

const sessionActionTailParamSchema = z.object({
  tail: z.string().min(1),
});

/**
 * Combined body schema for `POST /sessions/{tail}`. Each action parses its own
 * fields from this superset (mirrors v1's `sessionActionRequestSchema`, which is
 * also a server-side superset — the per-action wire schemas live in protocol).
 */
const sessionActionRequestSchema = z.preprocess(
  (value) => (value === undefined ? {} : value),
  z.object({
    title: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    instruction: z.string().optional(),
    count: z.number().int().positive().optional(),
    page_size: z.number().int().min(1).max(100).optional(),
  }),
);

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

export function registerSessionsRoutes(app: SessionRouteHost, core: Scope): void {
  const createRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions',
      body: createSessionRequestSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
        [ErrorCode.FS_PATH_NOT_FOUND]: {},
      },
      description: 'Create a new session',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        // The Workspace side of create (workspace_id/cwd resolution,
        // createOrTouch registration, runtime resolution/reuse and the
        // runtime-owned persistence create) lives in the v1 compatibility
        // adapter (plan §6.2); the projection and `event.session.created`
        // publication below keep today's wire behavior verbatim.
        const outcome = await createV1WorkspaceSession(core, req.body, req.id);
        if (outcome.kind === 'error') {
          reply.send(outcome.envelope);
          return;
        }
        const session = toWireSession(
          { ...outcome.meta, workspaceId: outcome.workspace.id },
          outcome.workspace.root,
          { busy: false, mainTurnActive: false, pendingInteraction: 'none' },
        );
        core.accessor.get(IEventService).publish({
          type: 'event.session.created',
          payload: {
            agentId: 'main',
            sessionId: session.id,
            runtimeId: outcome.ref.runtimeId,
            session,
          },
        });
        reply.send(okEnvelope(session, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(
    createRoute.path,
    createRoute.options,
    createRoute.handler as Parameters<SessionRouteHost['post']>[2],
  );

  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions',
      querystring: sessionsListQueryCoercion,
      success: { data: pageResponseSchema(sessionSchema) },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
      },
      description: 'List sessions',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const raw = req.query;
      const pageSize = raw.page_size;
      const archivedOnly = raw.archived_only === true;

      // M5a: the session set comes from the v1 ref resolver's cross-runtime
      // fan-out (plan §5.5) instead of `ISessionIndex`. `listAll` runs the
      // discovery catch-up FIRST — the projection lookups built after it see
      // the registrations a cold process had not opened yet, and its catalog
      // read doubles as the `roots` map below (one catalog query per request).
      const resolver = createV1SessionRefResolver(core);
      const resolutions = await resolver.listAll();
      const lookups = await buildV1ProjectionLookups(core);
      const roots = lookups.rootByWorkspaceId;

      // v1 resolves `workspace_id` to its root and 40410s when it is unknown;
      // the existence check stays on the listed (root-deduped) registry so an
      // unknown id fails byte-identically, and only then is a known id
      // expanded to every id spelling of the same directory — legacy split
      // buckets list as one workspace.
      if (raw.workspace_id !== undefined && !roots.has(raw.workspace_id)) {
        reply.send(
          errEnvelope(
            ErrorCode.WORKSPACE_NOT_FOUND,
            `workspace ${raw.workspace_id} does not exist`,
            req.id,
          ),
        );
        return;
      }

      // Each runtime's page is projected onto the same summary shape the index
      // produced, merged and re-sorted here; the id-cursor/page-size semantics
      // below are untouched, so `before_id`/`after_id`/`page_size`/`items`/
      // `has_more` behave the same. `archived_only` forces archived rows into
      // the set, then the filter below keeps only them.
      const workspaceIds =
        raw.workspace_id === undefined
          ? undefined
          : await core.accessor.get(IWorkspaceAliases).resolveAliasIds(raw.workspace_id);
      const includeArchived = archivedOnly ? true : raw.include_archive;
      const summaries: V1SessionSummaryFields[] = [];
      for (const resolution of resolutions) {
        const view = projectV1Session(resolution, lookups);
        if (view === undefined) continue;
        if (workspaceIds !== undefined && !workspaceIds.includes(view.workspaceId)) continue;
        if (includeArchived !== true && view.summary.archived) continue;
        summaries.push(view.summary);
      }
      // Cross-runtime merge: one global recency ordering over all runtimes'
      // pages (stable sort; identical `updatedAt` keeps fan-out order).
      const sortedSummaries = summaries.toSorted((a, b) => b.updatedAt - a.updatedAt);

      // Filter down to the sequence the client can page over BEFORE computing
      // the cursor position. `cwd` is read from the session's own summary first
      // (gap G3 closed — an unregistered workspace no longer drops the session);
      // the registry `roots` map is only a back-compat fallback for sessions
      // written before `cwd` was persisted. A session with no recoverable cwd is
      // still skipped.
      const eligible: {
        readonly summary: V1SessionSummaryFields;
        readonly cwd: string;
        readonly facts?: SessionFacts;
      }[] = [];
      for (const summary of sortedSummaries) {
        const cwd = summary.cwd ?? roots.get(summary.workspaceId);
        if (cwd === undefined) continue;
        if (raw.exclude_empty === true && (summary.lastPrompt ?? '').length === 0) continue;
        eligible.push({ summary, cwd });
      }

      // `before_id` = strictly older than this id (forward / default paging);
      // `after_id` = strictly newer. An unknown cursor resolves to an empty,
      // terminal page (`has_more: false`) so a client cannot spin on a cursor
      // the server cannot advance (this was the boot-time request storm).
      let start = 0;
      let end = eligible.length;
      const cursorId = raw.before_id ?? raw.after_id;
      if (cursorId !== undefined) {
        const idx = eligible.findIndex((e) => e.summary.id === cursorId);
        if (idx === -1) {
          reply.send(okEnvelope({ items: [], has_more: false }, req.id));
          return;
        }
        if (raw.before_id !== undefined) start = idx + 1;
        else end = idx;
      }

      const window = eligible.slice(start, end);
      let visible = window;
      if (archivedOnly) {
        visible =
          raw.busy === undefined
            ? window.filter((entry) => entry.summary.archived === true)
            : window.flatMap((entry) => {
                if (entry.summary.archived !== true) return [];
                const facts = resolveSessionFacts(core, entry.summary.id);
                return facts.busy === raw.busy ? [{ ...entry, facts }] : [];
              });
      }
      const limit = archivedOnly
        ? (pageSize ?? DEFAULT_SESSION_LIST_PAGE_SIZE)
        : (pageSize ?? visible.length);
      const hasMore = visible.length > limit;
      const projected: Session[] = visible
        .slice(0, limit)
        .map(({ summary, cwd, facts }) =>
          toWireSession(summary, cwd, facts ?? resolveSessionFacts(core, summary.id)),
        );
      // v1 filters ordinary lists by the busy fact post-page; `archived_only`
      // already applied it before pagination above so it can drain to a full page.
      const items =
        raw.busy !== undefined && !archivedOnly
          ? projected.filter((session) => session.busy === raw.busy)
          : projected;
      reply.send(okEnvelope({ items, has_more: hasMore }, req.id));
    },
  );
  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );

  const getRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}',
      params: sessionIdParamSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Get a session by ID',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      // M5a: bare-id resolution goes through the v1 ref resolver (plan §1.3);
      // the descriptor read is delegated to the owner runtime and projected
      // back onto the same summary the index produced (plan §6.2).
      const view = await resolveV1SessionView(core, session_id);
      if (view.kind !== 'view') {
        reply.send(v1SessionViewFailureEnvelope(view, session_id, req.id));
        return;
      }
      reply.send(
        okEnvelope(
          toWireSession(view.view.summary, view.view.cwd, resolveSessionFacts(core, session_id)),
          req.id,
        ),
      );
    },
  );
  app.get(
    getRoute.path,
    getRoute.options,
    getRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );

  const getProfileRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/profile',
      params: sessionIdParamSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Get session profile',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const view = await resolveV1SessionView(core, session_id);
      if (view.kind !== 'view') {
        reply.send(v1SessionViewFailureEnvelope(view, session_id, req.id));
        return;
      }
      reply.send(
        okEnvelope(
          toWireSession(view.view.summary, view.view.cwd, resolveSessionFacts(core, session_id)),
          req.id,
        ),
      );
    },
  );
  app.get(
    getProfileRoute.path,
    getProfileRoute.options,
    getProfileRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );

  const updateProfileRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/profile',
      params: sessionIdParamSchema,
      body: updateSessionProfileRequestSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Update session profile (title, metadata, agent_config)',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        // M5c: ensure the session is live through the resolver + runtime
        // open/resume FIRST (plan §6.3); the legacy service's internal
        // `lifecycle.resume` below then hits the already-active handle, so
        // the cross-domain `agent_config` patch and its wire projection run
        // unchanged.
        const live = await resolveV1LiveSession(core, session_id);
        if (live.kind !== 'live') {
          reply.send(v1LiveSessionFailureEnvelope(live, session_id, req.id));
          return;
        }
        const fields = await core.accessor
          .get(ISessionLegacyService)
          .updateProfile(session_id, req.body);
        const session = toWireSession(fields, fields.root, resolveSessionFacts(core, fields.id));
        // Broadcast the title change to every connection (including clients not
        // subscribed to this session, and covering inactive sessions), so session
        // lists stay in sync — mirrors v1's `session.meta.updated` publish.
        if (typeof req.body.title === 'string' && req.body.title.trim().length > 0) {
          core.accessor.get(IEventService).publish({
            type: 'session.meta.updated',
            payload: {
              agentId: 'main',
              sessionId: session_id,
              runtimeId: live.resolution.ref.runtimeId,
              title: session.title,
              patch: { title: session.title, isCustomTitle: true },
            },
          });
        }
        reply.send(okEnvelope(session, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(
    updateProfileRoute.path,
    updateProfileRoute.options,
    updateProfileRoute.handler as Parameters<SessionRouteHost['post']>[2],
  );

  const sessionActionRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{tail}',
      params: sessionActionTailParamSchema,
      body: sessionActionRequestSchema,
      success: {
        data: z.union([
          sessionSchema,
          compactSessionResponseSchema,
          undoSessionResponseSchema,
          sessionAbortResponseSchema,
          startBtwSessionResponseSchema,
          archiveSessionResponseSchema,
        ]),
      },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.SESSION_BUSY]: {},
        [ErrorCode.COMPACTION_UNABLE]: {},
        [ErrorCode.SESSION_UNDO_UNAVAILABLE]: {},
      },
      description: 'Run a session action',
      tags: ['sessions'],
      operationId: 'runSessionAction',
    },
    async (req, reply) => {
      try {
        const { tail } = req.params;
        const parsed = parseActionSuffix({
          tail,
          allowedActions: ['fork', 'compact', 'undo', 'abort', 'btw', 'archive', 'restore'] as const,
          resourceLabel: 'session',
        });
        if (parsed.kind !== 'action') {
          const message = parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${tail}`;
          reply.send(buildValidationEnvelope([{ path: 'session_id', message }], req.id));
          return;
        }

        const legacy = core.accessor.get(ISessionLegacyService);

        if (parsed.action === 'fork') {
          const body = forkSessionRequestSchema.parse(req.body);
          // M5c: the bare id resolves through the v1 ref resolver, then the
          // runtime session host owns the same-runtime fork + target
          // activation (plan §6.3). An unknown source keeps the current
          // 40401 ("does not exist") via the resolver mapping — the legacy
          // `lifecycle.fork` threw `session.not_found` to the same envelope.
          const source = await createV1SessionRefResolver(core).resolve(parsed.id);
          if (source.kind !== 'resolved') {
            reply.send(v1ResolveFailureEnvelope(source, parsed.id, req.id));
            return;
          }
          const forked = await core.accessor.get(IRuntimeSessionHostService).fork(
            source.resolution.ref,
            { title: body.title, metadata: body.metadata },
          );
          const handle = forked.handle;
          const meta = await handle.accessor.get(ISessionMetadata).read();
          const ctx = handle.accessor.get(ISessionContext);
          const session = toWireSession(
            { ...meta, workspaceId: ctx.workspaceId },
            ctx.cwd,
            resolveSessionFacts(core, meta.id),
          );
          core.accessor.get(IEventService).publish({
            type: 'event.session.created',
            payload: {
              agentId: 'main',
              sessionId: session.id,
              runtimeId: forked.ref.runtimeId,
              session,
            },
          });
          requestLog(req)?.info(
            { session_id: parsed.id, action: 'fork', new_session_id: session.id },
            'session action completed',
          );
          reply.send(okEnvelope(session, req.id));
          return;
        }

        if (parsed.action === 'compact') {
          const body = compactSessionRequestSchema.parse(req.body);
          const live = await resolveV1LiveSession(core, parsed.id);
          if (live.kind !== 'live') {
            reply.send(v1LiveSessionFailureEnvelope(live, parsed.id, req.id));
            return;
          }
          const agent = await ensureMainAgent(live.handle);
          // `begin` returns false when busy / over the per-turn limit — v1
          // treats that as a silent success. It throws `compaction.unable`
          // when there is no compactable prefix, which propagates.
          agent.accessor
            .get(IAgentFullCompactionService)
            .begin({ source: 'manual', instruction: normalizeOptional(body.instruction) });
          requestLog(req)?.info({ session_id: parsed.id, action: 'compact' }, 'session action completed');
          reply.send(okEnvelope({}, req.id));
          return;
        }

        if (parsed.action === 'undo') {
          const body = undoSessionRequestSchema.parse(req.body);
          // M5c: live through the resolver + runtime open/resume (plan §6.3).
          const live = await resolveV1LiveSession(core, parsed.id);
          if (live.kind !== 'live') {
            reply.send(v1LiveSessionFailureEnvelope(live, parsed.id, req.id));
            return;
          }
          const agent = await ensureMainAgent(live.handle);
          // The conversation undo service throws `session.undo_unavailable` (with a
          // structured `reason`) when fewer than `count` turns may be cut;
          // it quiesces the loop/compaction first, so the post-undo read
          // below always sees the cut applied.
          await agent.accessor.get(IAgentConversationUndoService).undo(body.count);
          const history = agent.accessor.get(IAgentContextMemoryService).get();
          requestLog(req)?.info({ session_id: parsed.id, action: 'undo' }, 'session action completed');
          // `createdAt` comes from the live session's own metadata document
          // (the same `state.json` the index summary read pre-migration); the
          // status rollup hits the already-active handle.
          const [meta, status] = await Promise.all([
            live.handle.accessor.get(ISessionMetadata).read(),
            legacy.status(parsed.id),
          ]);
          reply.send(
            okEnvelope(
              {
                messages: pageUndoMessages(
                  parsed.id,
                  meta.createdAt,
                  history,
                  body.page_size,
                ),
                status,
              },
              req.id,
            ),
          );
          return;
        }

        if (parsed.action === 'abort') {
          const live = await resolveV1LiveSession(core, parsed.id);
          if (live.kind !== 'live') {
            reply.send(v1LiveSessionFailureEnvelope(live, parsed.id, req.id));
            return;
          }
          const agent = await ensureMainAgent(live.handle);
          // No turnId → cancel whatever turn is active; a safe no-op when idle.
          // v1 always reports success once the session exists.
          await agent.accessor.get(IAgentRPCService).cancel({});
          requestLog(req)?.info({ session_id: parsed.id, action: 'abort' }, 'session action completed');
          reply.send(okEnvelope({ aborted: true }, req.id));
          return;
        }

        if (parsed.action === 'btw') {
          // Live through the resolver + runtime open/resume (M5c, plan §6.3):
          // a freshly-opened cold session can start a side-channel agent;
          // matches v1's `startBtw` which resumes first.
          const live = await resolveV1LiveSession(core, parsed.id);
          if (live.kind !== 'live') {
            reply.send(v1LiveSessionFailureEnvelope(live, parsed.id, req.id));
            return;
          }
          await core.accessor.get(IAuthSummaryService).ensureReady();
          const agentId = await live.handle.accessor.get(ISessionBtwService).start();
          reply.send(okEnvelope({ agent_id: agentId }, req.id));
          return;
        }

        if (parsed.action === 'restore') {
          // M5c (plan §6.3/§0.3): the path and the live restore behavior
          // stay; the bare id is resolved through the v1 ref resolver first
          // so an ambiguous or unreachable session fails with the frozen
          // mapping, then the session is ensured live through the RUNTIME
          // open/resume and un-archived — the legacy `restore` recipe
          // (resume + clear the flag), ownership-agnostic so an already-live
          // session is never double-activated. No new restore action.
          const resolution = await createV1SessionRefResolver(core).resolve(parsed.id);
          if (resolution.kind !== 'resolved') {
            reply.send(v1ResolveFailureEnvelope(resolution, parsed.id, req.id));
            return;
          }
          const live = await ensureV1LiveSession(core, resolution.resolution);
          if (live.kind !== 'live') {
            reply.send(v1LiveSessionFailureEnvelope(live, parsed.id, req.id));
            return;
          }
          await live.handle.accessor.get(ISessionMetadata).setArchived(false);
          const meta = await live.handle.accessor.get(ISessionMetadata).read();
          const ctx = live.handle.accessor.get(ISessionContext);
          const session = toWireSession(
            { ...meta, workspaceId: ctx.workspaceId },
            ctx.cwd,
            resolveSessionFacts(core, meta.id),
          );
          requestLog(req)?.info({ session_id: parsed.id, action: 'restore' }, 'session action completed');
          reply.send(okEnvelope(session, req.id));
          return;
        }

        // archive — ensure live through the resolver + runtime open/resume
        // (M5c, plan §6.3) so archiving a freshly-opened cold session still
        // works, then let the runtime session host archive (live-only, same
        // as the legacy archive).
        const live = await resolveV1LiveSession(core, parsed.id);
        if (live.kind !== 'live') {
          reply.send(v1LiveSessionFailureEnvelope(live, parsed.id, req.id));
          return;
        }
        await core.accessor.get(IRuntimeSessionHostService).archive(live.resolution.ref);
        requestLog(req)?.info({ session_id: parsed.id, action: 'archive' }, 'session action completed');
        reply.send(okEnvelope({ archived: true }, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(
    sessionActionRoute.path,
    sessionActionRoute.options,
    sessionActionRoute.handler as Parameters<SessionRouteHost['post']>[2],
  );

  const listChildrenRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/children',
      params: sessionIdParamSchema,
      querystring: sessionChildrenListQueryCoercion,
      success: { data: listSessionChildrenResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'List child sessions',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        // 404 when the parent is unknown — the v1 ref resolver's
        // cross-runtime probe (a closed parent can still list children, like
        // v1). Ambiguous/unavailable parents map onto the frozen resolver
        // envelopes instead of a false "does not exist".
        const parent = await createV1SessionRefResolver(core).resolve(session_id);
        if (parent.kind !== 'resolved') {
          reply.send(v1ResolveFailureEnvelope(parent, session_id, req.id));
          return;
        }

        // M5a: the child set comes from the resolver's cross-runtime fan-out,
        // filtered by the same child markers the index matched
        // (`parent_session_id` + `child_session_kind`) and the same archived
        // exclusion the index applied without `includeArchived` (an archived
        // child disappears from the list, like the pre-migration read). The
        // id-cursor, page-size, and status projection/filter stay at the edge
        // (v1 wire concerns; status needs live handles).
        const resolver = createV1SessionRefResolver(core);
        // Same ordering as the list route: `listAll` discovers first.
        const resolutions = await resolver.listAll();
        const lookups = await buildV1ProjectionLookups(core);
        const children: V1SessionSummaryFields[] = [];
        for (const resolution of resolutions) {
          const view = projectV1Session(resolution, lookups);
          if (view === undefined) continue;
          if (view.summary.archived) continue;
          const custom = view.summary.custom;
          if (
            custom?.['parent_session_id'] !== session_id ||
            custom?.['child_session_kind'] !== 'child'
          ) {
            continue;
          }
          children.push(view.summary);
        }
        const sortedChildren = children.toSorted((a, b) => b.updatedAt - a.updatedAt);

        let pivotIndex = -1;
        if (req.query.before_id !== undefined) {
          pivotIndex = sortedChildren.findIndex((s) => s.id === req.query.before_id);
        } else if (req.query.after_id !== undefined) {
          pivotIndex = sortedChildren.findIndex((s) => s.id === req.query.after_id);
        }
        let slice: typeof children;
        if (req.query.before_id !== undefined && pivotIndex >= 0) {
          slice = sortedChildren.slice(pivotIndex + 1);
        } else if (req.query.after_id !== undefined && pivotIndex >= 0) {
          slice = sortedChildren.slice(0, pivotIndex);
        } else {
          slice = sortedChildren;
        }
        // `page_size` is already clamped to [1, 100] by the query coercion; 100
        // is the v1 default when omitted.
        const pageSize = req.query.page_size ?? 100;
        const window = slice.slice(0, pageSize);

        // `cwd` is read from the child's own summary first (gap G3 closed);
        // the projection lookups' catalog map is only a back-compat fallback
        // for sessions written before `cwd` was persisted, defaulting to ''
        // (matches the prior adapter).
        const roots = lookups.rootByWorkspaceId;
        const projected = window.map((summary) =>
          toWireSession(
            summary,
            summary.cwd ?? roots.get(summary.workspaceId) ?? '',
            resolveSessionFacts(core, summary.id),
          ),
        );
        // v1 filters the projected page by the busy fact (post-page); `has_more`
        // reflects the pre-filter page.
        const items =
          req.query.busy !== undefined
            ? projected.filter((session) => session.busy === req.query.busy)
            : projected;
        reply.send(okEnvelope({ items, has_more: slice.length > pageSize }, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.get(
    listChildrenRoute.path,
    listChildrenRoute.options,
    listChildrenRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );

  const createChildRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/children',
      params: sessionIdParamSchema,
      body: createSessionChildRequestSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.SESSION_BUSY]: {},
      },
      description: 'Create a child session',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        // M5c: resolve the bare id first (an unknown source keeps the
        // current 40401 — `createChild` threw `session.not_found` via `fork`
        // to the same envelope), then the runtime session host forks and
        // activates the child. The child markers (`parent_session_id` /
        // `child_session_kind`) and the default `Child: <parent>` title are
        // applied HERE exactly like the legacy `createChild` did.
        const source = await createV1SessionRefResolver(core).resolve(session_id);
        if (source.kind !== 'resolved') {
          reply.send(v1ResolveFailureEnvelope(source, session_id, req.id));
          return;
        }
        // Title default mirrors the legacy priority: the live parent's fresh
        // metadata first, the persisted descriptor otherwise.
        const liveParent = core.accessor.get(ISessionLifecycleService).get(session_id);
        const parentTitle =
          liveParent !== undefined
            ? (await liveParent.accessor.get(ISessionMetadata).read()).title
            : descriptorTitle(source.resolution.descriptor);
        const forked = await core.accessor.get(IRuntimeSessionHostService).fork(
          source.resolution.ref,
          {
            title: req.body.title ?? `Child: ${parentTitle ?? session_id}`,
            metadata: {
              ...req.body.metadata,
              [PARENT_SESSION_ID_KEY]: session_id,
              [CHILD_SESSION_KIND_KEY]: CHILD_SESSION_KIND,
            },
          },
        );
        const handle = forked.handle;
        const meta = await handle.accessor.get(ISessionMetadata).read();
        const ctx = handle.accessor.get(ISessionContext);
        const session = toWireSession(
          { ...meta, workspaceId: ctx.workspaceId },
          ctx.cwd,
          resolveSessionFacts(core, meta.id),
        );
        core.accessor.get(IEventService).publish({
          type: 'event.session.created',
          payload: {
            agentId: 'main',
            sessionId: session.id,
            runtimeId: forked.ref.runtimeId,
            session,
          },
        });
        reply.send(okEnvelope(session, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(
    createChildRoute.path,
    createChildRoute.options,
    createChildRoute.handler as Parameters<SessionRouteHost['post']>[2],
  );

  const statusRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/status',
      params: sessionIdParamSchema,
      success: { data: sessionStatusResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Get realtime session status (best-effort in this slice)',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        // M5c: live through the resolver + runtime open/resume (plan §6.3);
        // the legacy rollup below then reads the already-active handle.
        const live = await resolveV1LiveSession(core, session_id);
        if (live.kind !== 'live') {
          reply.send(v1LiveSessionFailureEnvelope(live, session_id, req.id));
          return;
        }
        const status = await core.accessor.get(ISessionLegacyService).status(session_id);
        reply.send(okEnvelope(status, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.get(
    statusRoute.path,
    statusRoute.options,
    statusRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );

  const goalRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/goal',
      params: sessionIdParamSchema,
      success: { data: getSessionGoalResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Get the current session goal (null when none is active)',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        // M5c: live through the resolver + runtime open/resume (plan §6.3).
        const live = await resolveV1LiveSession(core, session_id);
        if (live.kind !== 'live') {
          reply.send(v1LiveSessionFailureEnvelope(live, session_id, req.id));
          return;
        }
        const goal = await core.accessor.get(ISessionLegacyService).goal(session_id);
        reply.send(okEnvelope(goal, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.get(
    goalRoute.path,
    goalRoute.options,
    goalRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );

  const sessionWarningsRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/warnings',
      params: sessionIdParamSchema,
      success: { data: sessionWarningsResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Get session-level warnings (e.g. oversized AGENTS.md)',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      // Live through the resolver + runtime open/resume (M5c, plan §6.3) so a
      // freshly-opened cold session still computes its warnings; matches v1's
      // best-effort `resumeSession` before reading them.
      const live = await resolveV1LiveSession(core, session_id);
      if (live.kind !== 'live') {
        reply.send(v1LiveSessionFailureEnvelope(live, session_id, req.id));
        return;
      }
      const session = live.handle;
      try {
        // Surface v2 notices in the v1 wire shape. The agents-md warning is
        // computed (and cached) by `IAgentProfileService` when the main agent
        // binds a profile; the secondary-model warning is computed (and
        // cached) by `ISessionSecondaryModelWarningService` when the main
        // agent is created. An unbound main agent / unset secondary model
        // yields `undefined` → that entry drops out, matching v1's "no
        // warning" case.
        const agent = await ensureMainAgent(session);
        const agentsMdWarning = agent.accessor.get(IAgentProfileService).getAgentsMdWarning();
        const secondaryModelWarning = session.accessor
          .get(ISessionSecondaryModelWarningService)
          .getSecondaryModelWarning();
        const warnings = [
          ...(agentsMdWarning === undefined
            ? []
            : [
                {
                  code: 'agents-md-oversized',
                  message: agentsMdWarning,
                  severity: 'warning' as const,
                },
              ]),
          ...(secondaryModelWarning === undefined
            ? []
            : [
                {
                  code: secondaryModelWarning.code,
                  message: secondaryModelWarning.message,
                  severity: 'warning' as const,
                },
              ]),
        ];
        reply.send(okEnvelope({ warnings }, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.get(
    sessionWarningsRoute.path,
    sessionWarningsRoute.options,
    sessionWarningsRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );
}

// ---------------------------------------------------------------------------
// API body wrapper — pure field projection from a service return value to the
// wire `Session` shape. No service calls, no control flow: handlers pull data
// through `ServiceAccessor.get` and pass it straight here.
// ---------------------------------------------------------------------------

export interface SessionWireFields {
  readonly id: string;
  readonly workspaceId: string;
  readonly title?: string;
  readonly lastPrompt?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
  readonly custom?: Record<string, unknown>;
}

export function toWireSession(
  fields: SessionWireFields,
  cwd: string,
  facts: SessionFacts,
): Session {
  return {
    id: fields.id,
    workspace_id: fields.workspaceId,
    title: fields.title ?? '',
    created_at: new Date(fields.createdAt).toISOString(),
    updated_at: new Date(fields.updatedAt).toISOString(),
    busy: facts.busy,
    main_turn_active: facts.mainTurnActive,
    pending_interaction: facts.pendingInteraction,
    last_turn_reason: facts.lastTurnReason,
    archived: fields.archived,
    last_prompt: fields.lastPrompt,
    metadata: buildWireMetadata(fields.custom, cwd),
    agent_config: { model: '' },
    usage: emptySessionUsage(),
    permission_rules: [],
    message_count: 0,
    last_seq: 0,
  };
}

/** Live activity and interaction facts projected onto the wire `Session`. */
export interface SessionFacts {
  readonly busy: boolean;
  readonly mainTurnActive: boolean;
  readonly pendingInteraction: SessionPendingInteraction;
  readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
}

/**
 * Resolve a session's live wire facts from the core `ISessionActivityView`
 * aggregate (`busy` = any agent with an active turn or background task; the
 * reason is the main agent's latest turn outcome, `blocked` folds into
 * `failed`). A cold session (no live handle) is not busy and carries no
 * outcome.
 *
 * The lookup goes through `ISessionLifecycleService` — the process-wide live
 * view that ALSO observes runtime-activated sessions (M5c
 * `trackActivated`), so facts stay accurate whichever path activated the
 * session.
 */
export function resolveSessionFacts(core: Scope, sessionId: string): SessionFacts {
  const handle = core.accessor.get(ISessionLifecycleService).get(sessionId);
  if (handle === undefined) {
    return {
      busy: false,
      mainTurnActive: false,
      pendingInteraction: 'none',
    };
  }
  return handle.accessor.get(ISessionActivityView).state();
}

/** Trim a compaction instruction; treat an empty/blank value as absent. */
function normalizeOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** The persisted `title` of a runtime session descriptor, when it is a string. */
function descriptorTitle(descriptor: SessionDescriptor): string | undefined {
  const title = descriptor.metadata['title'];
  return typeof title === 'string' && title.length > 0 ? title : undefined;
}

/** v1 `:undo` message page-size clamp (`packages/agent-core/.../sessionService.ts`). */
const DEFAULT_UNDO_MESSAGE_PAGE_SIZE = 50;
const MAX_UNDO_MESSAGE_PAGE_SIZE = 100;

/**
 * Mirror of v1 `pageContextMessages`: project the post-undo history into a
 * newest-first wire page, clamping `page_size` to `[1, 100]` (default 50).
 */
function pageUndoMessages(
  sessionId: string,
  sessionCreatedAtMs: number,
  history: readonly ContextMessage[],
  requestedPageSize: number | undefined,
): { items: ReturnType<typeof toProtocolMessage>[]; has_more: boolean } {
  const pageSize = Math.min(
    Math.max(requestedPageSize ?? DEFAULT_UNDO_MESSAGE_PAGE_SIZE, 1),
    MAX_UNDO_MESSAGE_PAGE_SIZE,
  );
  const all = history.map((message, index) =>
    toProtocolMessage(sessionId, index, message, sessionCreatedAtMs),
  );
  const desc = all.toReversed();
  return {
    items: desc.slice(0, pageSize),
    has_more: desc.length > pageSize,
  };
}

/**
 * Build the wire `Session.metadata`: caller-supplied custom fields (minus the
 * reserved `goal` key, matching v1's `toProtocolSession`) overlaid with the
 * required `cwd`. `cwd` always wins so the resolved work dir is authoritative.
 */
function buildWireMetadata(
  custom: Record<string, unknown> | undefined,
  cwd: string,
): { cwd: string; [key: string]: unknown } {
  if (custom === undefined) return { cwd };
  const { goal: _drop, ...rest } = custom as { goal?: unknown; [key: string]: unknown };
  return { ...rest, cwd };
}

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

function sendMappedError(
  reply: { send(payload: unknown): unknown },
  req: { id: string },
  err: unknown,
): void {
  const requestId = req.id;
  const log = requestLog(req);
  if (isError2(err)) {
    switch (err.code) {
      case 'session.not_found':
      case 'agent.not_found':
        reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case 'session.fork_active_turn':
      case ErrorCodes.SESSION_BUSY:
        reply.send(errEnvelope(ErrorCode.SESSION_BUSY, err.message, requestId, err.stack));
        return;
      case 'compaction.unable':
        reply.send(errEnvelope(ErrorCode.COMPACTION_UNABLE, err.message, requestId, err.stack));
        return;
      case 'session.undo_unavailable':
        reply.send({
          code: ErrorCode.SESSION_UNDO_UNAVAILABLE,
          msg: err.message,
          data: (err as { details?: unknown }).details ?? null,
          request_id: requestId,
          stack: err.stack,
        });
        return;
      case ErrorCodes.GOAL_ALREADY_EXISTS:
        reply.send(errEnvelope(ErrorCode.GOAL_ALREADY_EXISTS, err.message, requestId, err.stack));
        return;
      case ErrorCodes.GOAL_NOT_FOUND:
        reply.send(errEnvelope(ErrorCode.GOAL_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case ErrorCodes.GOAL_STATUS_INVALID:
        reply.send(errEnvelope(ErrorCode.GOAL_STATUS_INVALID, err.message, requestId, err.stack));
        return;
      case ErrorCodes.GOAL_NOT_RESUMABLE:
        reply.send(errEnvelope(ErrorCode.GOAL_NOT_RESUMABLE, err.message, requestId, err.stack));
        return;
      case ErrorCodes.GOAL_OBJECTIVE_EMPTY:
        reply.send(errEnvelope(ErrorCode.GOAL_OBJECTIVE_EMPTY, err.message, requestId, err.stack));
        return;
      case ErrorCodes.GOAL_OBJECTIVE_TOO_LONG:
        reply.send(
          errEnvelope(ErrorCode.GOAL_OBJECTIVE_TOO_LONG, err.message, requestId, err.stack),
        );
        return;
      case ErrorCodes.FS_PATH_NOT_FOUND:
        reply.send(errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case 'request.invalid':
      case 'validation.failed':
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, err.message, requestId, err.stack));
        return;
    }
  }
  log?.error({ err }, 'session request failed');
  reply.send(
    errEnvelope(
      ErrorCode.INTERNAL_ERROR,
      err instanceof Error ? err.message : String(err),
      requestId,
      err instanceof Error ? err.stack : undefined,
    ),
  );
}
