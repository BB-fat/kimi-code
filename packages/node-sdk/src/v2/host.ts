/**
 * `v2` host — `CoreAPI` implementation backed by `agent-core-v2` (DI × Scope).
 *
 * Drop-in replacement for v1 `KimiCore` inside `SDKRpcClient`: same constructor
 * shape `(coreRpc, options)`, same `sdk` reverse channel, same `CoreAPI`
 * surface. Agent-scope methods delegate to v2's `IAgentRPCService` (already
 * v1-shaped); app/session-scope methods are composed from v2 services; the rest
 * are stubbed `not_implemented` and filled in as the migration proceeds.
 *
 * Routing: every `CoreAPI` AgentAPI method arrives as
 * `{ sessionId, agentId, ...payload }` (v1 `WithSessionId`/`WithAgentId`). We
 * strip the ids, look up `main` in `this.sessions`, and forward the pure
 * `AgentAPI` payload to `main.accessor.get(IAgentRPCService)`. See
 * `plan/agent-core-v2-cli-adapter-p0.md`.
 */

import {
  ErrorCodes,
  KimiError,
  type CoreAPI,
  type CoreRPCClient,
  type ResumeSessionResult,
  type RPCMethods,
  type SDKAPI,
} from '@moonshot-ai/agent-core';
import {
  bootstrap,
  ensureMainAgent,
  IAgentPermissionModeService,
  IAgentRPCService,
  IBootstrapService,
  IEventBus,
  IEventService,
  IAgentLifecycleService,
  IAgentReplayService,
  IAgentScopeContext,
  ICliSkillDirs,
  IConfigService,
  IFlagService,
  ISessionInteractionService,
  ISessionCronService,
  ISessionContext,
  ISessionExportService,
  ISessionIndex,
  ISessionLifecycleService,
  ISessionMetadata,
  ISessionSkillCatalog,
  ISessionTodoService,
  ISessionWorkspaceCommandService,
  IWebSearchProviderService,
  IWorkspaceRegistry,
  logSeed,
  MoonshotWebSearchProvider,
  resolveConfigPath,
  resolveKimiHome,
  resolveLoggingConfig,
  type IAgentScopeHandle,
  type ISessionScopeHandle,
  type ExportSessionPayload,
  type ExportSessionResult,
  type Scope,
  type ServiceIdentifier,
} from '@moonshot-ai/agent-core-v2';
import { encodeWorkDirKey } from '@moonshot-ai/agent-core-v2/_base/utils/workdir-slug';

import type { JsonObject, KimiHostIdentity, SessionSummary as WireSessionSummary } from '#/types';

/** v1 AgentAPI method names (the `KimiCore` contract the SDK client calls). */
const AGENT_API_METHODS: readonly string[] = [
  'prompt',
  'runShellCommand',
  'cancelShellCommand',
  'steer',
  'cancel',
  'undoHistory',
  'setThinking',
  'setPermission',
  'setModel',
  'getModel',
  'enterPlan',
  'cancelPlan',
  'clearPlan',
  'enterSwarm',
  'exitSwarm',
  'getSwarmMode',
  'beginCompaction',
  'cancelCompaction',
  'registerTool',
  'unregisterTool',
  'setActiveTools',
  'stopBackground',
  'detachBackground',
  'clearContext',
  'activateSkill',
  'activatePluginCommand',
  'startBtw',
  'createGoal',
  'getGoal',
  'pauseGoal',
  'resumeGoal',
  'cancelGoal',
  'getBackgroundOutput',
  'getContext',
  'getConfig',
  'getPermission',
  'getPlan',
  'getUsage',
  'getTools',
  'getBackground',
];

/** v1 → v2 AgentAPI renames (background-task family). */
const AGENT_RENAME: Readonly<Record<string, string>> = {
  stopBackground: 'stopTask',
  detachBackground: 'detachTask',
  getBackgroundOutput: 'getTaskOutput',
  getBackground: 'getTasks',
};

const AGENT_API_SET: ReadonlySet<string> = new Set(AGENT_API_METHODS);

/** Every v1 `CoreAPI` method name (for `createRPC` enumeration). */
const CORE_API_METHODS: readonly (keyof CoreAPI)[] = [
  ...AGENT_API_METHODS,
  'renameSession',
  'updateSessionMetadata',
  'getSessionMetadata',
  'listSkills',
  'listPluginCommands',
  'listMcpServers',
  'getMcpStartupMetrics',
  'reconnectMcpServer',
  'generateAgentsMd',
  'getSessionWarnings',
  'addAdditionalDir',
  'getCoreInfo',
  'getExperimentalFeatures',
  'getKimiConfig',
  'getConfigDiagnostics',
  'setKimiConfig',
  'removeKimiProvider',
  'createSession',
  'closeSession',
  'archiveSession',
  'resumeSession',
  'reloadSession',
  'forkSession',
  'listSessions',
  'exportSession',
  'listPlugins',
  'installPlugin',
  'setPluginEnabled',
  'setPluginMcpServerEnabled',
  'removePlugin',
  'reloadPlugins',
  'getPluginInfo',
] as (keyof CoreAPI)[];

export interface V2HostOptions {
  readonly homeDir?: string;
  readonly configPath?: string;
  readonly kimiRequestHeaders?: Record<string, string>;
  readonly resolveOAuthTokenProvider?: unknown;
  readonly skillDirs?: readonly string[];
  readonly telemetry?: unknown;
  readonly appVersion?: string;
  readonly identity?: KimiHostIdentity;
}

interface SessionSlot {
  readonly handle: ISessionScopeHandle;
  main?: IAgentScopeHandle;
  disposables?: { dispose(): void }[];
}

function notImplemented(name: string): never {
  const error = new Error(`V2Host: not implemented: ${name}`) as Error & { code?: string };
  error.code = 'not_implemented';
  throw error;
}

function sessionNotFound(sessionId: string): never {
  const error = new Error(`V2Host: session not found: ${sessionId}`) as Error & { code?: string };
  error.code = 'session.not_found';
  throw error;
}

type AgentRpc = Record<string, (payload: unknown) => unknown | Promise<unknown>>;

export class V2Host {
  readonly sdk: Promise<RPCMethods<SDKAPI>>;
  readonly homeDir: string;
  readonly configPath: string;

  private readonly app: Scope;
  private readonly sessions = new Map<string, SessionSlot>();
  private readonly kimiRequestHeaders: Record<string, string> | undefined;
  /** `undefined` = not built yet; `null` = no search service configured. */
  private webSearch: MoonshotWebSearchProvider | null | undefined;

  constructor(coreRpc: CoreRPCClient, options: V2HostOptions = {}) {
    this.homeDir = resolveKimiHome(options.homeDir);
    this.configPath = resolveConfigPath({ homeDir: this.homeDir, configPath: options.configPath });
    this.kimiRequestHeaders = options.kimiRequestHeaders;
    // Host-injected web-search seam (v1 parity: `core-impl.ts`
    // `createRuntimeConfig` builds it from `config.services.moonshot_search`).
    // The provider is resolved lazily so config has loaded by the time the
    // `WebSearch` tool's registration gate reads it (agent creation happens
    // after `IConfigService.ready` in `createSession`).
    const webSearchSeed: [ServiceIdentifier<unknown>, unknown] = [
      IWebSearchProviderService as ServiceIdentifier<unknown>,
      {
        _serviceBrand: undefined,
        getWebSearchProvider: () => this.getWebSearchProvider(),
      },
    ];
    const cliSkillDirsSeed: [ServiceIdentifier<unknown>, unknown] = [
      ICliSkillDirs as ServiceIdentifier<unknown>,
      { dirs: options.skillDirs ?? [] },
    ];
    this.app = bootstrap({ homeDir: this.homeDir, configPath: this.configPath }, [
      ...logSeed(resolveLoggingConfig({ homeDir: this.homeDir, env: process.env })),
      webSearchSeed,
      cliSkillDirsSeed,
    ]).app;

    const self = this as Record<string, unknown>;
    for (const name of CORE_API_METHODS) {
      if (self[name as string] !== undefined) continue; // prototype methods win
      if (AGENT_API_SET.has(name as string)) {
        self[name as string] = (payload: unknown) => this.delegateAgent(name as string, payload);
      } else {
        self[name as string] = () => notImplemented(name as string);
      }
    }

    this.sdk = coreRpc(this as unknown as Parameters<CoreRPCClient>[0]);

    // v1 parity: bridge the process-global `IEventService` (session lifecycle
    // / title / auth events) to the SDK. Per-agent events already ride the
    // agent `IEventBus` bridge in `attachSessionBridges`, but global events
    // such as `session.meta.updated` (auto-title from the first prompt) are
    // published on the app-scope bus and would otherwise never reach the TUI —
    // leaving `appState.sessionTitle` stale so `/fork` derives the fork title
    // from the session id. Flatten the `{ type, payload }` GlobalEvent shape
    // back into the flat `{ type, ...payload, sessionId, agentId }` shape the
    // SDK/TUI expects, and scope it to sessions this host actually owns.
    this.app.accessor.get(IEventService).subscribe((event) => {
      const payload =
        event.payload !== null && typeof event.payload === 'object'
          ? (event.payload as Record<string, unknown>)
          : undefined;
      const sessionId =
        typeof payload?.['sessionId'] === 'string' ? payload['sessionId'] : undefined;
      if (sessionId !== undefined && !this.sessions.has(sessionId)) return;
      void this.sdk.then((sdk) =>
        sdk.emitEvent({
          type: event.type,
          ...payload,
          sessionId,
          agentId: payload?.['agentId'],
        } as never),
      );
    });
  }

  private async requireMain(sessionId: string): Promise<IAgentScopeHandle> {
    let slot = this.sessions.get(sessionId);
    if (slot === undefined) {
      const handle = await this.app.accessor.get(ISessionLifecycleService).resume(sessionId);
      if (handle === undefined) sessionNotFound(sessionId);
      const main = await ensureMainAgent(handle);
      // Force-instantiate session-scope tool providers (cron registers its
      // tools into the main agent's registry on construction).
      handle.accessor.get(ISessionCronService);
      slot = { handle, main };
      this.sessions.set(sessionId, slot);
    }
    if (slot.main !== undefined) return slot.main;
    const main = await ensureMainAgent(slot.handle);
    slot.handle.accessor.get(ISessionCronService);
    this.sessions.set(sessionId, { handle: slot.handle, main });
    return main;
  }

  /** Lazy v1-parity web-search provider from `config.services.moonshot_search`. */
  private getWebSearchProvider(): MoonshotWebSearchProvider | undefined {
    if (this.webSearch === undefined) {
      const services = this.app.accessor
        .get(IConfigService)
        .get<Record<string, unknown> | undefined>('services');
      // The unregistered `services` domain only camelCases its first-level
      // keys; the nested section keys stay snake_case. Accept both.
      const section = (services?.['moonshotSearch'] ?? services?.['moonshot_search']) as
        | Record<string, unknown>
        | undefined;
      const baseUrl = (section?.['baseUrl'] ?? section?.['base_url']) as string | undefined;
      const apiKey = (section?.['apiKey'] ?? section?.['api_key']) as string | undefined;
      this.webSearch =
        baseUrl === undefined || baseUrl.length === 0
          ? null
          : new MoonshotWebSearchProvider({
              baseUrl,
              apiKey,
              defaultHeaders: this.kimiRequestHeaders,
            });
    }
    return this.webSearch ?? undefined;
  }

  private async delegateAgent(method: string, payload: unknown): Promise<unknown> {
    const {
      sessionId,
      agentId: _agentId,
      ...rest
    } = (payload ?? {}) as {
      sessionId: string;
      agentId?: string;
    };
    if (typeof sessionId !== 'string') return notImplemented(`${method}(missing sessionId)`);
    const main = await this.requireMain(sessionId);
    const rpc = main.accessor.get(IAgentRPCService) as unknown as AgentRpc;
    const v2Method = AGENT_RENAME[method] ?? method;
    const fn = rpc[v2Method];
    if (typeof fn !== 'function') return notImplemented(`${method}→${v2Method}`);
    return fn(rest);
  }

  // ---------------------------------------------------------------------------
  // App-scope composed methods (P0)
  // ---------------------------------------------------------------------------

  async createSession(payload: {
    id?: string;
    workDir: string;
    model?: string;
    permission?: 'yolo' | 'manual' | 'auto';
  }): Promise<{
    id: string;
    workDir: string;
    sessionDir: string;
    createdAt: number;
    updatedAt: number;
  }> {
    await this.app.accessor.get(IConfigService).ready;
    const sessionId =
      payload.id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const handle = await this.app.accessor
      .get(ISessionLifecycleService)
      .create({ sessionId, workDir: payload.workDir });
    // v1 parity: register the workspace so a cold `--continue` resume can find it
    // in `workspaces.json`; without this, `doResume` returns undefined on cold start.
    await this.app.accessor.get(IWorkspaceRegistry).createOrTouch(payload.workDir);
    const main = await ensureMainAgent(handle);
    // Force-instantiate session-scope tool providers (cron registers its tools
    // into the main agent's registry on construction).
    handle.accessor.get(ISessionCronService);
    const disposables = this.attachSessionBridges(handle, sessionId, main);
    // v1 parity: `KimiCore.createSession` falls back to `config.defaultModel`
    // when the caller passes no model (`core-impl.ts:227`); the TUI relies on it.
    const model =
      payload.model ??
      this.app.accessor.get(IConfigService).get<string | undefined>('defaultModel');
    if (model !== undefined) {
      await main.accessor.get(IAgentRPCService).setModel({ model });
    }
    if (payload.permission !== undefined) {
      main.accessor.get(IAgentPermissionModeService).setMode(payload.permission);
    }
    const slot: SessionSlot = { handle, main, disposables };
    this.sessions.set(sessionId, slot);
    const now = Date.now();
    return {
      id: sessionId,
      workDir: payload.workDir,
      sessionDir: '',
      createdAt: now,
      updatedAt: now,
    };
  }

  async resumeSession(payload: { sessionId: string }): Promise<unknown> {
    const handle = await this.app.accessor.get(ISessionLifecycleService).resume(payload.sessionId);
    if (handle === undefined) return notImplemented('resumeSession(cold/unknown)');
    const main = await ensureMainAgent(handle);
    // Force-instantiate session-scope tool providers (cron registers its tools
    // into the main agent's registry on construction).
    handle.accessor.get(ISessionCronService);
    const sessionId = payload.sessionId;
    // Mirror createSession's wiring so a resumed session emits events, bridges
    // child agents, and forwards HITL exactly like a fresh one.
    const disposables = this.attachSessionBridges(handle, sessionId, main);
    this.sessions.set(sessionId, { handle, main, disposables });
    return this.buildResumeResult(handle, main);
  }

  async reloadSession(payload: { sessionId: string }): Promise<unknown> {
    // v1 parity (`core-impl.ts` `reloadSession`): tear the live session down
    // and resume it fresh so config/plugin changes take effect, returning the
    // same full resume-state assembly as `resumeSession`.
    const slot = this.sessions.get(payload.sessionId);
    if (slot !== undefined) {
      slot.disposables?.forEach((d) => {
        try {
          d.dispose();
        } catch {
          // ignore
        }
      });
      this.sessions.delete(payload.sessionId);
      await this.app.accessor.get(ISessionLifecycleService).close(payload.sessionId);
    }
    return this.resumeSession(payload);
  }

  /**
   * Assemble the v1 `ResumeSessionResult` the SDK/TUI hydrates a resumed
   * session from (`Session.getResumeState()` → `hydrateFromReplay`): the
   * summary plus `sessionMetadata` and a per-agent state record. Every getter
   * on the v2 `IAgentRPCService` is already v1-shaped (see the file header),
   * and the replay records come from the v2 `ReplayTimelineModel` projection,
   * a JSON-compatible mirror of v1's DTO — hence the single boundary cast on
   * the agent state and on the metadata (v2 `SessionMeta` uses epoch-ms
   * timestamps and `cwd`, the v1 wire shape uses ISO strings and `workDir`).
   */
  private async buildResumeResult(
    handle: ISessionScopeHandle,
    main: IAgentScopeHandle,
  ): Promise<ResumeSessionResult> {
    // A successful resume has already resolved the session's cwd (`doResume`
    // falls back summary.cwd → workspace registry and aborts when neither is
    // recoverable), so the seeded context always carries the real values.
    const ctx = handle.accessor.get(ISessionContext);
    const meta = await handle.accessor.get(ISessionMetadata).read();
    const rpc = main.accessor.get(IAgentRPCService);
    const replay = main.accessor.get(IAgentReplayService).getReplayRecords();
    // v1 parity: `toolStore.todo` carries the session todo list — v1 kept it
    // on the agent tool store, v2 owns it at session scope.
    const todos = handle.accessor.get(ISessionTodoService).getTodos();
    const [config, context, permission, plan, swarmMode, usage, tools, background] =
      await Promise.all([
        rpc.getConfig({}),
        rpc.getContext({}),
        rpc.getPermission({}),
        rpc.getPlan({}),
        rpc.getSwarmMode({}),
        rpc.getUsage({}),
        rpc.getTools({}),
        rpc.getTasks({ activeOnly: false }),
      ]);
    const sessionMetadata = {
      createdAt: new Date(meta.createdAt).toISOString(),
      updatedAt: new Date(meta.updatedAt).toISOString(),
      title: meta.title ?? '',
      isCustomTitle: meta.isCustomTitle ?? false,
      lastPrompt: meta.lastPrompt,
      forkedFrom: meta.forkedFrom,
      workDir: meta.cwd ?? ctx.cwd,
      agents: { ...meta.agents },
      custom: { ...meta.custom },
    } as unknown as ResumeSessionResult['sessionMetadata'];
    const mainState = {
      type: 'main',
      config,
      context,
      replay,
      permission,
      plan,
      swarmMode,
      usage,
      tools,
      toolStore: { todo: [...todos] },
      background,
    } as unknown as ResumeSessionResult['agents'][string];
    return {
      id: ctx.sessionId,
      title: meta.title,
      lastPrompt: meta.lastPrompt,
      workDir: ctx.cwd,
      sessionDir: ctx.sessionDir,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      archived: meta.archived,
      metadata: meta.custom as JsonObject | undefined,
      sessionMetadata,
      agents: { main: mainState },
    };
  }

  async forkSession(payload: {
    sessionId: string;
    id?: string;
    title?: string;
    metadata?: Record<string, unknown>;
  }): Promise<unknown> {
    await this.app.accessor.get(IConfigService).ready;
    // v1 parity: `KimiCore.forkSession` copies the source session's wire logs
    // into a brand-new session (new id, `forkedFrom` pointing at the source)
    // and returns it live. `ISessionLifecycleService.fork` already does the
    // copy + restore; the host only has to wire the bridges like create/resume.
    const handle = await this.app.accessor.get(ISessionLifecycleService).fork({
      sourceSessionId: payload.sessionId,
      newSessionId: payload.id,
      title: payload.title,
      metadata: payload.metadata,
    });
    const ctx = handle.accessor.get(ISessionContext);
    const sessionId = ctx.sessionId;
    const main = await ensureMainAgent(handle);
    // Force-instantiate session-scope tool providers (cron registers its tools
    // into the main agent's registry on construction).
    handle.accessor.get(ISessionCronService);
    const disposables = this.attachSessionBridges(handle, sessionId, main);
    this.sessions.set(sessionId, { handle, main, disposables });
    return this.buildResumeResult(handle, main);
  }

  private attachSessionBridges(
    handle: ISessionScopeHandle,
    sessionId: string,
    main: IAgentScopeHandle,
  ): { dispose(): void }[] {
    const disposables: { dispose(): void }[] = [];
    // Live signals are AgentEvent-shaped by construction (see server-v2's
    // `SessionEventBroadcaster`); `record` emissions are durable state, not UI.
    const attachEventBridge = (agent: IAgentScopeHandle, agentId: string): { dispose(): void } => {
      const seenTurns = new Set<string>();
      return agent.accessor.get(IEventBus).subscribe((event) => {
        const e = event as { type?: unknown; turnId?: unknown };
        // `turn.started` may arrive on IEventBus (core now publishes it) or not
        // (older kernels that fire it only on legacy `wire.signal`). Track seen
        // turns so a synthesized fallback fires at most once, and never when the
        // real `turn.started` already arrived.
        if (typeof e.turnId === 'number') {
          const key = `${agentId}:${e.turnId}`;
          if (e.type === 'turn.started') {
            seenTurns.add(key);
          } else if (e.type === 'turn.step.started' && !seenTurns.has(key)) {
            seenTurns.add(key);
            void this.sdk.then((sdk) =>
              sdk.emitEvent({
                type: 'turn.started',
                turnId: e.turnId,
                sessionId,
                agentId,
              } as never),
            );
          }
        }
        void this.sdk.then((sdk) => sdk.emitEvent({ ...event, sessionId, agentId } as never));
      });
    };
    disposables.push(attachEventBridge(main, 'main'));
    // Bridge every child agent's events too — e2e asserts the set of non-main
    // agent event streams matches exactly. `onDidCreate` fires for main as well
    // (handled above), so skip it.
    const lifecycle = handle.accessor.get(IAgentLifecycleService) as unknown as {
      onDidCreate: (listener: (child: IAgentScopeHandle) => void) => { dispose(): void };
    };
    const childSub = lifecycle.onDidCreate((child) => {
      const childId = child.accessor.get(IAgentScopeContext).agentId;
      if (childId === 'main') return;
      const slot = this.sessions.get(sessionId);
      if (slot?.disposables === undefined) return;
      slot.disposables.push(attachEventBridge(child, childId));
    });
    disposables.push(childSub);
    // Reverse HITL bridge: v2 parks approval/question requests on the session
    // interaction service; forward each pending request to the SDK handler
    // (`requestApproval`/`requestQuestion` — payload is already v1-shaped) and
    // write the handler's decision back via `respond`. Without this, approvals
    // such as ExitPlanMode hang forever.
    const attachInteractionBridge = (): { dispose(): void } => {
      const interaction = handle.accessor.get(ISessionInteractionService) as unknown as {
        onDidChangePending: (listener: (event: { pending: readonly string[] }) => void) => {
          dispose(): void;
        };
        listPending: () => readonly {
          id: string;
          kind: string;
          payload: unknown;
          origin?: { agentId?: string };
        }[];
        respond: (id: string, response: unknown) => void;
      };
      const seen = new Set<string>();
      const resolveOne = async (item: {
        id: string;
        kind: string;
        payload: unknown;
        origin?: { agentId?: string };
      }): Promise<void> => {
        const agentId = item.origin?.agentId ?? 'main';
        const sdk = await this.sdk;
        const body = { ...(item.payload as Record<string, unknown>), sessionId, agentId } as never;
        if (item.kind === 'approval') {
          interaction.respond(item.id, await sdk.requestApproval(body));
        } else if (item.kind === 'question') {
          interaction.respond(item.id, await sdk.requestQuestion(body));
        }
      };
      return interaction.onDidChangePending(({ pending }) => {
        for (const id of pending) {
          if (seen.has(id)) continue;
          seen.add(id);
          const item = interaction.listPending().find((entry) => entry.id === id);
          if (item !== undefined) void resolveOne(item);
        }
      });
    };
    disposables.push(attachInteractionBridge());
    return disposables;
  }

  async listSessions(
    payload: {
      workDir?: string;
      sessionId?: string;
      includeArchive?: boolean;
      childOf?: string;
      limit?: number;
    } = {},
  ): Promise<readonly WireSessionSummary[]> {
    // v1 parity: `SessionStore.list` scopes the query by workDir bucket
    // (`encodeWorkDirKey`) and rejects blank workDir outright. v1 returns a
    // plain array; the v2 index answers a `Page<SessionSummary>` — the edge
    // unwraps it.
    if (payload.workDir !== undefined && payload.workDir.trim() === '') {
      throw new KimiError(ErrorCodes.REQUEST_WORK_DIR_REQUIRED, 'listSessions requires workDir');
    }
    const query = {
      workspaceId:
        payload.workDir === undefined ? undefined : encodeWorkDirKey(payload.workDir),
      sessionId: payload.sessionId,
      includeArchived: payload.includeArchive === true ? true : undefined,
      childOf: payload.childOf,
      limit: payload.limit,
    };
    const page = await this.app.accessor.get(ISessionIndex).list(query);
    const registry = this.app.accessor.get(IWorkspaceRegistry);
    const bootstrapService = this.app.accessor.get(IBootstrapService);
    const summaries: WireSessionSummary[] = [];
    for (const item of page.items) {
      // The wire contract has `workDir` as a required field, and sessions
      // omit it only for documents predating cwd persistence; mirror the
      // resume edge's fallback to the workspace registry, then to a fixed
      // placeholder so old records still round-trip.
      const workDir =
        item.cwd ?? (await registry.get(item.workspaceId))?.root ?? '(unknown)';
      summaries.push({
        id: item.id,
        title: item.title,
        lastPrompt: item.lastPrompt,
        workDir,
        sessionDir: bootstrapService.sessionDir(item.workspaceId, item.id),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        archived: item.archived,
        metadata: item.custom as JsonObject | undefined,
      });
    }
    return summaries;
  }

  async closeSession(payload: { sessionId: string }): Promise<void> {
    const slot = this.sessions.get(payload.sessionId);
    try {
      await this.app.accessor.get(ISessionLifecycleService).close(payload.sessionId);
    } catch {
      // ignore close errors (session may already be closed)
    }
    slot?.disposables?.forEach((d) => {
      try {
        d.dispose();
      } catch {
        // ignore
      }
    });
    this.sessions.delete(payload.sessionId);
  }

  async getKimiConfig(): Promise<Record<string, unknown>> {
    await this.app.accessor.get(IConfigService).ready;
    return this.app.accessor.get(IConfigService).getAll();
  }

  async getConfigDiagnostics(): Promise<{ warnings: readonly string[] }> {
    await this.app.accessor.get(IConfigService).ready;
    const diags = this.app.accessor.get(IConfigService).diagnostics();
    return { warnings: diags.map((d) => d.message) };
  }

  async exportSession(payload: ExportSessionPayload): Promise<ExportSessionResult> {
    // v2 core implements export via `ISessionExportService` (sessionExport
    // domain); just forward. v1 parity: `KimiCore.exportSession` delegates to
    // the same-shaped core `ISessionExportService.export`.
    return this.app.accessor.get(ISessionExportService).export(payload);
  }

  /** Dispose the v2 app scope (and transitively every Session/Agent scope and
   *  service), releasing ref'd handles — file watchers (chokidar via the
   *  persistence layer) and sockets — so a one-shot CLI process can exit. */
  dispose(): void {
    for (const slot of this.sessions.values()) {
      slot.disposables?.forEach((d) => {
        try {
          d.dispose();
        } catch {
          // ignore
        }
      });
    }
    this.sessions.clear();
    this.app.dispose();
  }

  getExperimentalFeatures(): readonly unknown[] {
    const flag = this.app.accessor.get(IFlagService) as unknown as {
      list?: () => readonly unknown[];
    };
    return typeof flag.list === 'function' ? flag.list() : [];
  }

  getSessionWarnings(): readonly unknown[] {
    return [];
  }

  listMcpServers(): readonly unknown[] {
    return [];
  }

  getMcpStartupMetrics(): { durationMs: number } {
    return { durationMs: 0 };
  }

  reconnectMcpServer(): void {}

  generateAgentsMd(): void {}

  listSkills(payload: { sessionId: string }): readonly unknown[] {
    const slot = this.sessions.get(payload.sessionId);
    if (slot === undefined) return [];
    const catalog = slot.handle.accessor.get(ISessionSkillCatalog) as unknown as {
      catalog: {
        listSkills: () => readonly {
          name: string;
          description: string;
          path: string;
          source: string;
          metadata?: { type?: string; disableModelInvocation?: boolean; isSubSkill?: boolean };
        }[];
      };
    };
    return catalog.catalog.listSkills().map((s) => ({
      name: s.name,
      description: s.description,
      path: s.path,
      source: s.source,
      type: s.metadata?.type,
      disableModelInvocation: s.metadata?.disableModelInvocation,
      isSubSkill: s.metadata?.isSubSkill,
    }));
  }

  async addAdditionalDir(payload: {
    sessionId: string;
    path: string;
    persist?: boolean;
  }): Promise<{ additionalDirs: readonly string[]; configPath?: string }> {
    const slot = this.sessions.get(payload.sessionId);
    if (slot === undefined) return notImplemented('addAdditionalDir(session not found)');
    // Route through the session workspace-command service: it persists the dir
    // (when `persist`) AND injects the `<local-command-stdout>` reminder into the
    // main agent's context — the v1.4 behavior the bare in-memory workspace
    // context skipped (which dropped the reminder from the wire).
    const result = await slot.handle.accessor
      .get(ISessionWorkspaceCommandService)
      .addAdditionalDir({ path: payload.path, persist: payload.persist });
    return { additionalDirs: result.additionalDirs, configPath: result.configPath };
  }

  listPluginCommands(): readonly unknown[] {
    return [];
  }
}
