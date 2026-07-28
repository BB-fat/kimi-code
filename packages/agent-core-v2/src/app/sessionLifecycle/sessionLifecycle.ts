/**
 * `sessionLifecycle` domain (L6) — creates and tracks sessions at the process root.
 *
 * Defines the public contract of session lifecycle: the `CreateSessionOptions`,
 * `ForkSessionOptions`, `CreateChildSessionOptions`, and the
 * `ISessionLifecycleService` used to create sessions (`create`), look up the
 * live ones (`get` / `list`), close them (`close`), archive/restore them,
 * fork them (`fork`), and fork-then-tag them as direct children (`createChild`). Announces
 * lifecycle transitions through ordered hook slots plus
 * `onDidCreateSession` / `onDidCloseSession` / `onDidArchiveSession` /
 * `onDidForkSession`. App-scoped — a single
 * process-wide instance owns the live session scope tree. Persisted
 * sessions (open or closed) are the `sessionIndex` read model; per-session
 * behaviour lives in the Session-scoped domains.
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
   * entry for the full `SessionRef`, falling back to this service's OWN map
   * (legacy-activated sessions carry no ref — their bare id is the only key,
   * and ambiguity was already rejected upstream by the v1 resolver).
   */
  getByRef(ref: SessionRef): ISessionScopeHandle | undefined;
  list(): readonly ISessionScopeHandle[];
  resume(sessionId: string): Promise<ISessionScopeHandle | undefined>;
  /**
   * Register a session activated OUTSIDE this service (the runtime session
   * host, multi-runtime refactor M5c) so the process-wide live lookup (`get`
   * / `getByRef` / `list` / `resume`) observes it alongside the sessions this
   * service activated itself. The registrar keeps full ownership: activation,
   * close/archive and every lifecycle event stay with it — this service never
   * disposes, re-resumes, or fires events for a tracked session, and its
   * `close` / `archive` (own-map operations) are no-ops for one. The returned
   * `IDisposable` detaches the entry (idempotent, identity-checked).
   *
   * M6: tracked entries are keyed by the FULL `SessionRef` (`sessionRefKey`),
   * so two same-named sessions hosted by different runtimes coexist; the
   * bare-id `get` projection only answers when the match is unique.
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
