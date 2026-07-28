/**
 * `runtimeSession` domain (L6) — `IRuntimeSessionActivationService`, the
 * runtime-backed Session scope assembly path (plan §1.5, §5.3, §7.2).
 *
 * This is THE way Session Core turns a runtime lease into a live Session
 * scope: `runtime.sessions.open/resume` returns a complete
 * `ISessionRuntimeContext`, and `activate` builds the Session child scope
 * from it — persistence, artifacts, cold reader, capabilities, contributions
 * and OS handles ALL arrive with the lease. Nothing here touches the
 * Workspace domain, the bootstrap path builders, the session index, or the
 * App container's session storage (plan §1.5: after open, storage / cold
 * reader / artifact service / OS provider come from the injected context
 * only).
 *
 * The legacy `sessionLifecycle` path is untouched and keeps serving
 * kap-server; this path exists side by side and is what the multi-runtime
 * milestones grow into (M5+ wire kap-server's REST/WS delegation to it).
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import type { McpServerConfig } from '#/agent/mcp/config-schema';
import type { BindAgentInput } from '#/agent/profile/profile';
import type {
  ISessionRuntimeContext,
  SessionCloseReason,
} from '#/app/sessionHostRuntime/sessionRuntimeContext';
import type { SessionRef } from '#/app/sessionHostRuntime/sessionRef';

export interface ActivateRuntimeSessionOptions {
  /** Caller-supplied MCP servers, merged like the legacy create path's `mcpServers`. */
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
  /**
   * Ensure the session's main agent exists after materialization: it is
   * created with this binding when the restored roster has none (the legacy
   * `create` / `resume` behaviors unified — resume creates the main agent
   * only when missing).
   */
  readonly mainAgent?: { readonly binding?: BindAgentInput };
}

/**
 * A live runtime-backed session: the DI scope handle plus the lease it was
 * built from. `close` drains the session's agents, disposes the scope and
 * closes the lease — never the owning runtime (plan §5.4).
 */
export interface IRuntimeSessionScope {
  readonly ref: SessionRef;
  readonly lease: ISessionRuntimeContext;
  readonly handle: ISessionScopeHandle;

  /** Drain pending persistence writes (the lease's append-log stores). */
  flush(): Promise<void>;
  close(reason: SessionCloseReason): Promise<void>;
}

export interface IRuntimeSessionActivationService {
  readonly _serviceBrand: undefined;

  /**
   * Build a Session scope from a runtime lease. Either the complete scope —
   * materialized metadata/tool policy/catalogs and, when requested, a live
   * main agent — or a rejection (`session.open_failed` and friends); a failed
   * activation disposes the half-built scope and does NOT close the lease
   * (its lifecycle stays with the caller).
   */
  activate(
    lease: ISessionRuntimeContext,
    options?: ActivateRuntimeSessionOptions,
  ): Promise<IRuntimeSessionScope>;
}

export const IRuntimeSessionActivationService: ServiceIdentifier<IRuntimeSessionActivationService> =
  createDecorator<IRuntimeSessionActivationService>('runtimeSessionActivationService');
