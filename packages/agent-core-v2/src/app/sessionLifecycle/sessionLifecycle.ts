/**
 * `sessionLifecycle` domain (L6) — the v1-compatibility session lifecycle facade.
 *
 * Defines the public contract of session lifecycle: the `CreateSessionOptions`,
 * `ForkSessionOptions`, `CreateChildSessionOptions`, and the
 * `ISessionLifecycleService` used to create sessions (`create`), look up the
 * live ones (`get` / `list`), close them (`close`), archive/restore them,
 * fork them (`fork`), and fork-then-tag them as direct children (`createChild`). Announces
 * lifecycle transitions through ordered hook slots plus
 * `onDidCreateSession` / `onDidCloseSession` / `onDidArchiveSession` /
 * `onDidForkSession`. App-scoped — a single
 * process-wide instance owns the live session lookup. Persisted
 * sessions (open or closed) are the `sessionIndex` read model; per-session
 * behaviour lives in the Session-scoped domains.
 *
 * M8a (multi-runtime refactor, plan §15): the implementation is a THIN
 * FACADE over `IRuntimeSessionHostService` — bare session ids and workDirs
 * are resolved to a `SessionRef` (Workspace catalog + runtime manager) and
 * every lifecycle action is delegated to the runtime that owns the session.
 * The facade keeps the pieces every consumer shares: the process-wide live
 * lookup fed by `trackActivated`, the shared `SessionStart`/`SessionEnd`
 * hook slots (the Session-scoped external-hooks adapter registers here; the
 * runtime session host runs them), and the lifecycle events. The bare-id
 * surface stays because the klient RPC contract, the node-sdk in-process
 * client and the debug-RPC scope resolver are frozen v1 consumers (plan
 * §14: first-stage klient/CLI surfaces keep bare ids).
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import type { Event } from '#/_base/event';
import type { McpServerConfig } from '#/agent/mcp/config-schema';
import type { BindAgentInput } from '#/agent/profile/profile';
import type { SessionRef } from '#/app/sessionHostRuntime/sessionRef';
import type { Hooks } from '#/hooks';

export interface CreateSessionOptions {
  readonly sessionId?: string;
  readonly workDir: string;
  readonly additionalDirs?: readonly string[];
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
  readonly mainAgentBinding?: BindAgentInput;
}

export interface ForkSessionOptions {
  readonly sourceSessionId: string;
  readonly newSessionId?: string;
  readonly title?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface CreateChildSessionOptions {
  readonly sourceSessionId: string;
  readonly newSessionId?: string;
  readonly title?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface SessionCreatedEvent {
  readonly sessionId: string;
  readonly handle: ISessionScopeHandle;
  readonly source: SessionCreateSource;
}

export interface SessionClosedEvent {
  readonly sessionId: string;
}

export type SessionCreateSource = 'startup' | 'resume' | 'fork';

export type SessionCloseReason = 'exit';

export interface SessionWillCloseEvent {
  readonly sessionId: string;
  readonly handle: ISessionScopeHandle;
  readonly reason: SessionCloseReason;
}

export type SessionLifecycleHooks = {
  readonly onDidCreateSession: SessionCreatedEvent;
  readonly onWillCloseSession: SessionWillCloseEvent;
};

export interface SessionArchivedEvent {
  readonly sessionId: string;
}

export interface SessionForkedEvent {
  readonly sourceSessionId: string;
  readonly sessionId: string;
  readonly handle: ISessionScopeHandle;
}

export interface ISessionLifecycleService {
  readonly _serviceBrand: undefined;

  readonly onDidCreateSession: Event<SessionCreatedEvent>;
  readonly onDidCloseSession: Event<SessionClosedEvent>;
  readonly onDidArchiveSession: Event<SessionArchivedEvent>;
  readonly onDidForkSession: Event<SessionForkedEvent>;
  readonly hooks: Hooks<SessionLifecycleHooks>;
  create(opts: CreateSessionOptions): Promise<ISessionScopeHandle>;
  get(sessionId: string): ISessionScopeHandle | undefined;
  /**
   * Ref-addressed live lookup (multi-runtime refactor M6): the exact tracked
   * entry for the full `SessionRef`. Bare-id ambiguity is rejected upstream
   * by the v1 resolver, so internal callers pass the full ref.
   */
  getByRef(ref: SessionRef): ISessionScopeHandle | undefined;
  list(): readonly ISessionScopeHandle[];
  resume(sessionId: string): Promise<ISessionScopeHandle | undefined>;
  /**
   * Register a session activated OUTSIDE this facade (the runtime session
   * host, multi-runtime refactor M5c) so the process-wide live lookup (`get`
   * / `getByRef` / `list` / `resume`) observes it. The registrar keeps full
   * ownership: activation, close/archive and every lifecycle event stay with
   * it — this facade never disposes, re-resumes, or fires events for a
   * tracked session on its own. The returned `IDisposable` detaches the
   * entry (idempotent, identity-checked).
   *
   * M6: tracked entries are keyed by the FULL `SessionRef` (`sessionRefKey`),
   * so two same-named sessions hosted by different runtimes coexist; the
   * bare-id `get` projection only answers when the match is unique.
   *
   * M8a: tracked entries are the ONLY live source — the facade activates
   * nothing itself anymore (every `create`/`resume`/`fork` delegates to the
   * runtime session host, which publishes here).
   */
  trackActivated(ref: SessionRef, handle: ISessionScopeHandle): IDisposable;
  close(sessionId: string): Promise<void>;
  archive(sessionId: string): Promise<void>;
  restore(sessionId: string): Promise<ISessionScopeHandle | undefined>;
  fork(opts: ForkSessionOptions): Promise<ISessionScopeHandle>;
  createChild(opts: CreateChildSessionOptions): Promise<ISessionScopeHandle>;
}

export const ISessionLifecycleService: ServiceIdentifier<ISessionLifecycleService> =
  createDecorator<ISessionLifecycleService>('sessionLifecycleService');
