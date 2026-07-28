/**
 * `runtimeSessionHost` domain (L6) — `IRuntimeSessionHostService`, the
 * composition layer that activates sessions through their owner runtime
 * (multi-runtime refactor, M5b; plan §6.3). M8a: with the legacy
 * `sessionLifecycle` machine deleted, this is the ONLY activation path —
 * the bare-id `ISessionLifecycleService` facade and the kap-server v1 edge
 * both delegate here.
 *
 * The activation service (`runtimeSession`, one layer down) turns a lease
 * into a Session scope — and nothing else. Everything the activation flow
 * does AROUND scope assembly is an App-level concern and lives here:
 *
 *  - routing: `runtimeId`/`SessionRef` → `ISessionService` /
 *    `ISessionHostRuntimeRegistry` (never provider.open, never a per-session
 *    runtime — plan §3.4);
 *  - live-session registry keyed by the full `SessionRef`
 *    (`sessionRefKey`), with the same get/list/inflight-resume semantics the
 *    retired legacy service had;
 *  - main-agent materialization (create with binding / resume ensure /
 *    fork roster rebuild) and the `defaultPlanMode` auto-enter on create;
 *  - additional-dirs seeding from the project-local config;
 *  - lifecycle side effects: the shared `ISessionLifecycleService.hooks`
 *    slots (`onDidCreateSession` → `SessionStart`, `onWillCloseSession` →
 *    `SessionEnd`) so the Session-scoped external-hooks adapter observes
 *    every session exactly alike, the `session_started`
 *    telemetry event, `session_load_failed` on resume failures, and the
 *    `event.session.archived` publication;
 *  - failure rollback: a failed create/fork deletes the session from its
 *    runtime (the legacy `hostFs.remove(sessionDir)` equivalent); a failed
 *    resume disposes the half-built scope and closes the lease without
 *    touching persisted data.
 *
 * Wire and route concerns stay out: this service exposes no v1 schema and
 * switches no route by itself (the kap-server edge delegates routes to it).
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { McpServerConfig } from '#/agent/mcp/config-schema';
import type { BindAgentInput } from '#/agent/profile/profile';
import type {
  IRuntimeSessionScope,
} from '#/app/runtimeSession/runtimeSessionActivation';
import type { SessionCreateSource } from '#/app/sessionLifecycle/sessionLifecycle';
import type { SessionRef } from '#/app/sessionHostRuntime/sessionRef';
import type { SessionMetadata } from '#/app/sessionHostRuntime/sessionRuntimeContext';

/* ------------------------------------------------------------------------ */
/* Options & events                                                          */
/* ------------------------------------------------------------------------ */

export interface RuntimeSessionHostCreateOptions {
  /** The ALREADY-REGISTERED runtime that owns the new session (plan §3.4). */
  readonly runtimeId: string;
  /** Defaults to the runtime's own id strategy (`session_<uuid>` for local). */
  readonly sessionId?: string;
  /** Initial logical metadata persisted with the create. */
  readonly metadata?: SessionMetadata;
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
  /** When absent, NO main agent is created — the legacy create behavior. */
  readonly mainAgentBinding?: BindAgentInput;
  readonly additionalDirs?: readonly string[];
}

export interface RuntimeSessionHostResumeOptions {
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
  readonly additionalDirs?: readonly string[];
  /** Optimistic-concurrency token forwarded to the runtime's resume. */
  readonly expectedRevision?: string;
}

export interface RuntimeSessionHostForkOptions {
  readonly newSessionId?: string;
  readonly title?: string;
  /** Custom metadata merged over the source's (the `goal` key never crosses). */
  readonly metadata?: Record<string, unknown>;
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
}

export interface RuntimeSessionActivatedEvent {
  readonly ref: SessionRef;
  readonly scope: IRuntimeSessionScope;
  readonly source: SessionCreateSource;
}

export interface RuntimeSessionHostClosedEvent {
  readonly ref: SessionRef;
}

export interface RuntimeSessionHostForkedEvent {
  readonly source: SessionRef;
  readonly ref: SessionRef;
  readonly scope: IRuntimeSessionScope;
}

/* ------------------------------------------------------------------------ */
/* The service                                                               */
/* ------------------------------------------------------------------------ */

export interface IRuntimeSessionHostService {
  readonly _serviceBrand: undefined;

  readonly onDidActivateSession: Event<RuntimeSessionActivatedEvent>;
  readonly onDidCloseSession: Event<RuntimeSessionHostClosedEvent>;
  readonly onDidArchiveSession: Event<RuntimeSessionHostClosedEvent>;
  readonly onDidForkSession: Event<RuntimeSessionHostForkedEvent>;

  /**
   * Persist + activate a new session on an already-registered runtime
   * (legacy `create` parity: main agent only with a binding, plan-mode
   * auto-enter by config, `SessionStart` with source `startup`, rollback on
   * failure).
   */
  create(opts: RuntimeSessionHostCreateOptions): Promise<IRuntimeSessionScope>;
  /** Live scope lookup; `undefined` while a resume is in flight (legacy `get`). */
  get(ref: SessionRef): IRuntimeSessionScope | undefined;
  list(): readonly IRuntimeSessionScope[];
  /**
   * Activate a persisted session (legacy `resume` parity: `undefined` when
   * the session is unknown, main agent ensured, `SessionStart` with source
   * `resume`, `session_load_failed` telemetry on errors). Concurrent resumes
   * of the same ref fold into one.
   */
  resume(
    ref: SessionRef,
    opts?: RuntimeSessionHostResumeOptions,
  ): Promise<IRuntimeSessionScope | undefined>;
  /** `resume` + clear the archived flag (legacy `restore` parity). */
  restore(
    ref: SessionRef,
    opts?: RuntimeSessionHostResumeOptions,
  ): Promise<IRuntimeSessionScope | undefined>;
  /**
   * Same-runtime fork + activation (legacy `fork` parity: the runtime owns
   * the directory copy/wire rewrite/cron duplication/index line; the live
   * agent roster is rebuilt from the persisted metadata; `SessionStart`
   * with source `fork`; the target is rolled back on failure).
   */
  fork(ref: SessionRef, opts?: RuntimeSessionHostForkOptions): Promise<IRuntimeSessionScope>;
  /** Legacy `archive` parity: live sessions only — a cold session is a no-op. */
  archive(ref: SessionRef): Promise<void>;
  /** Legacy `close` parity: `SessionEnd` hook first, then scope teardown. */
  close(ref: SessionRef): Promise<void>;
}

export const IRuntimeSessionHostService: ServiceIdentifier<IRuntimeSessionHostService> =
  createDecorator<IRuntimeSessionHostService>('runtimeSessionHostService');
