/**
 * M4 tests (plan §9.3) — the runtime-backed Session scope assembly path
 * (`app/runtimeSession`): Session Core builds and runs a complete
 * Session/Agent scope from ONLY the lease-injected `ISessionRuntimeContext`.
 *
 * What these tests prove:
 *
 *  - With NO Workspace service registered — only a multi-session host runtime
 *    in the registry — a session can run (a real agent turn over a scripted
 *    fake model), resume, fork, export and delete through the generic
 *    activation path. The App container's session stores are recording
 *    wrappers and MUST stay untouched: persistence comes from the lease.
 *  - A headless (memory) session is built through the same generic context:
 *    OS contributions (fs/process/terminal services, os tools) do not exist,
 *    non-OS contributions work, and runtime-contributed services/tools are
 *    gated by the capability set (plan §7.4).
 *  - Two sessions on one runtime share the runtime identity while their
 *    state, events and locks stay isolated; closing one leaves the other and
 *    the runtime alive.
 *  - The SAME activation path driven by a `LocalWorkspaceRuntime` lease lands
 *    the legacy layout (`state.json`, `agents/main/wire.jsonl`) — the path is
 *    not memory-specific.
 *
 * Run with `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/app/runtimeSession/runtimeSession.test.ts`.
 */

import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import '#/index';

import { createDecorator } from '#/_base/di/instantiation';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { ILogOptions } from '#/_base/log/logConfig';
import { createAppScope, type Scope } from '#/_base/di/scope';
import { IEventBus } from '#/app/event/eventBus';
import { bootstrapSeed } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { ICronTaskPersistence } from '#/app/cron/cronTaskPersistence';
import { CronTaskPersistenceService } from '#/app/cron/cronTaskPersistenceService';
import {
  DEFAULT_MODEL_SECTION,
  DEFAULT_PROVIDER_SECTION,
  MODELS_SECTION,
  PROVIDERS_SECTION,
} from '#/app/kosongConfig/configSection';
import { DEFAULT_CRON_CONFIG } from '#/app/cron/configSection';
import { LocalWorkspaceRuntime } from '#/app/localWorkspaceRuntime/localWorkspaceRuntime';
import {
  EMPTY_HOST_ENVIRONMENT,
  EMPTY_HOST_FILE_SYSTEM,
  UNAVAILABLE_HOST_FS_WATCH_SERVICE,
  UNAVAILABLE_HOST_PROCESS_SERVICE,
  UNAVAILABLE_HOST_TERMINAL_SERVICE,
} from '#/app/runtimeSession/leaseOsProjection';
import {
  type IRuntimeSessionScope,
  IRuntimeSessionActivationService,
} from '#/app/runtimeSession/runtimeSessionActivation';
import { ISessionLifecycleService } from '#/app/sessionLifecycle/sessionLifecycle';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { ISessionHostRuntimeRegistry } from '#/app/sessionHostRuntime/sessionHostRuntimeRegistry';
import type {
  ISessionRuntimeContext,
  SessionRuntimeContributions,
} from '#/app/sessionHostRuntime/sessionRuntimeContext';
import { StandaloneMemoryHostRuntime } from '#/app/standaloneMemoryRuntime/standaloneMemoryHostRuntime';
import { IWorkspaceService } from '#/app/workspace/workspace';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentRPCService } from '#/agent/rpc/rpc';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { createHooks } from '#/hooks';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IModelService, type ModelsSection } from '#/kosong/model/model';
import { IModelOAuthTokens } from '#/kosong/model/modelOAuth';
import { IProviderService, type ProvidersSection } from '#/kosong/provider/provider';
import { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { IHostTerminalService } from '#/os/interface/terminal';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import {
  JsonAtomicDocumentStore,
  TomlAtomicDocumentStore,
} from '#/persistence/backends/node-fs/atomicDocumentStore';
import { BlobStoreService } from '#/persistence/backends/node-fs/blobStoreService';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import {
  IAtomicDocumentStore,
  IAtomicTomlDocumentStore,
} from '#/persistence/interface/atomicDocumentStore';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { IQueryStore } from '#/persistence/interface/queryStore';
import {
  IFileSystemStorageService,
  type StorageAppendOptions,
  type StorageReadRange,
  type StorageWriteOptions,
} from '#/persistence/interface/storage';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionCronService } from '#/session/cron/sessionCronService';
import { ISessionMcpService } from '#/session/mcp/sessionMcp';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import { ISessionFsService } from '#/session/sessionFs/fs';
import { ISessionFsWatchService } from '#/session/sessionFs/fsWatch';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionTerminalService } from '#/session/terminal/terminalService';
import type { AgentTool, ToolExecution } from '#/tool/toolContract';

import {
  createGenerateBackedProtocolRegistry,
  configService,
  emptyConfig,
  MOCK_PROVIDER,
} from '../../harness/agent';
import { createScriptedGenerate } from '../../harness/scripted-generate';

/* ------------------------------------------------------------------------ */
/* App composition                                                           */
/* ------------------------------------------------------------------------ */

interface StorageCall {
  readonly op: string;
  readonly scope: string;
  readonly key: string;
}

/**
 * The App container's storage backend: works (so App-level services that
 * legitimately keep App state behave), but records every access — the
 * runtime-backed session must NEVER touch it (plan §1.5). Scenarios assert
 * the recorded calls.
 */
class RecordingStorageService extends InMemoryStorageService {
  readonly calls: StorageCall[] = [];

  private record(op: string, scope: string, key: string): void {
    this.calls.push({ op, scope, key });
  }

  override read(scope: string, key: string): Promise<Uint8Array | undefined> {
    this.record('read', scope, key);
    return super.read(scope, key);
  }

  override async *readStream(
    scope: string,
    key: string,
    range?: StorageReadRange,
  ): AsyncIterable<Uint8Array> {
    this.record('readStream', scope, key);
    yield* super.readStream(scope, key, range);
  }

  override write(
    scope: string,
    key: string,
    data: Uint8Array,
    options?: StorageWriteOptions,
  ): Promise<void> {
    this.record('write', scope, key);
    return super.write(scope, key, data, options);
  }

  override writeStream(
    scope: string,
    key: string,
    source: AsyncIterable<Uint8Array>,
    options?: StorageWriteOptions,
  ): Promise<void> {
    this.record('writeStream', scope, key);
    return super.writeStream(scope, key, source, options);
  }

  override append(
    scope: string,
    key: string,
    data: Uint8Array,
    options?: StorageAppendOptions,
  ): Promise<void> {
    this.record('append', scope, key);
    return super.append(scope, key, data, options);
  }

  override list(scope: string, prefix?: string): Promise<readonly string[]> {
    this.record('list', scope, prefix ?? '');
    return super.list(scope, prefix);
  }

  override delete(scope: string, key: string): Promise<void> {
    this.record('delete', scope, key);
    return super.delete(scope, key);
  }
}

const NOOP_LOG: ILogService = {
  _serviceBrand: undefined,
  level: 'off',
  setLevel: () => {},
  flush: () => Promise.resolve(),
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => NOOP_LOG,
} as unknown as ILogService;

/** An App service the runtime-backed path must never call. */
function forbiddenService<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      if (prop === '_serviceBrand') return undefined;
      if (prop === 'hooks') {
        return createHooks(['onDidCreateSession', 'onWillCloseSession']);
      }
      if (typeof prop === 'string' && prop.startsWith('on')) return Event.None;
      return () => {
        throw new Error(
          `${name}.${String(prop)} must not be called: the runtime-backed session path does not use it`,
        );
      };
    },
  });
}

const NOOP_QUERY_STORE: IQueryStore = new Proxy({} as IQueryStore, {
  get(_target, prop) {
    if (prop === '_serviceBrand') return undefined;
    if (typeof prop === 'string' && prop.startsWith('on')) return Event.None;
    return () => Promise.resolve(prop === 'list' ? [] : undefined);
  },
});

interface TestApp {
  readonly root: Scope;
  readonly registry: ISessionHostRuntimeRegistry;
  readonly activation: IRuntimeSessionActivationService;
  readonly generate: ReturnType<typeof createScriptedGenerate>;
  readonly appStorage: RecordingStorageService;
  readonly homeDir: string;
  readonly cwd: string;
}

function makeApp(): TestApp {
  const homeDir = mkdtempSync(join(tmpdir(), 'kimi-m4-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'kimi-m4-cwd-'));
  const generate = createScriptedGenerate();
  const kimiConfig = { ...emptyConfig(), cron: DEFAULT_CRON_CONFIG };
  const appStorage = new RecordingStorageService();

  const root = createAppScope({
    extra: [
      ...bootstrapSeed({ homeDir, cwd, osHomeDir: homeDir, env: {} }),
      [IConfigService, configService(() => kimiConfig)],
      [ILogService, NOOP_LOG],
      [
        ILogOptions,
        {
          level: 'off',
          globalLogPath: join(homeDir, 'logs', 'kimi-code.log'),
          globalMaxBytes: 6 * 1024 * 1024,
          globalFiles: 1,
          sessionMaxBytes: 5 * 1024 * 1024,
          sessionFiles: 1,
        } satisfies ILogOptions,
      ],
      [IProtocolAdapterRegistry, createGenerateBackedProtocolRegistry(generate.generate)],
      [
        IModelOAuthTokens,
        {
          _serviceBrand: undefined,
          hasCachedAccessToken: () => Promise.resolve(false),
          getAccessToken: () =>
            Promise.reject(new Error('IModelOAuthTokens is not available in tests')),
        } satisfies IModelOAuthTokens,
      ],
      // App session storage is recording, not throwing: App-level services may
      // hold App state, but the runtime-backed session must never show up here.
      [IFileSystemStorageService, appStorage],
      [IAtomicDocumentStore, new JsonAtomicDocumentStore(appStorage)],
      [IAtomicTomlDocumentStore, new TomlAtomicDocumentStore(appStorage)],
      [IAppendLogStore, new AppendLogStore(appStorage)],
      [IBlobStore, new BlobStoreService(appStorage)],
      [IQueryStore, NOOP_QUERY_STORE],
      [ICronTaskPersistence, new SyncDescriptor(CronTaskPersistenceService)],
      // The host OS the App container knows is EMPTY: a runtime-backed session
      // gets OS handles only from its lease, so nothing session-scoped may
      // ever reach these (plan §1.5).
      [IHostFileSystem, EMPTY_HOST_FILE_SYSTEM],
      [IHostProcessService, UNAVAILABLE_HOST_PROCESS_SERVICE],
      [IHostTerminalService, UNAVAILABLE_HOST_TERMINAL_SERVICE],
      [IHostFsWatchService, UNAVAILABLE_HOST_FS_WATCH_SERVICE],
      [IHostEnvironment, EMPTY_HOST_ENVIRONMENT],
      // The legacy session machinery and the Workspace domain are forbidden
      // on this path — calling them fails the test.
      [ISessionLifecycleService, forbiddenService('ISessionLifecycleService')],
      [ISessionIndex, forbiddenService('ISessionIndex')],
      [IWorkspaceService, forbiddenService('IWorkspaceService')],
    ],
  });

  // Hydrate the kosong registries from the config once (the config never
  // changes afterwards), mirroring the harness's bootstrap.
  const config = root.accessor.get(IConfigService);
  root.accessor
    .get(IProviderService)
    .loadAll(
      config.get<ProvidersSection>(PROVIDERS_SECTION) ?? {},
      config.get<string>(DEFAULT_PROVIDER_SECTION),
    );
  root.accessor
    .get(IModelService)
    .loadAll(
      config.get<ModelsSection>(MODELS_SECTION) ?? {},
      config.get<string>(DEFAULT_MODEL_SECTION),
    );

  const registry = root.accessor.get(ISessionHostRuntimeRegistry);
  // The model catalog resolves the scripted test model.
  root.accessor.get(IModelCatalog).get(MOCK_PROVIDER.model);

  return {
    root,
    registry,
    activation: root.accessor.get(IRuntimeSessionActivationService),
    generate,
    appStorage,
    homeDir,
    cwd,
  };
}

/* ------------------------------------------------------------------------ */
/* Turn driver                                                               */
/* ------------------------------------------------------------------------ */

async function activateMain(
  app: TestApp,
  lease: ISessionRuntimeContext,
): Promise<IRuntimeSessionScope> {
  const scope = await app.activation.activate(lease, { mainAgent: {} });
  const main = scope.handle.accessor.get(IAgentLifecycleService).get(MAIN_AGENT_ID);
  expect(main).toBeDefined();
  main!.accessor.get(IAgentProfileService).update({
    modelAlias: MOCK_PROVIDER.model,
    systemPrompt: 'You are a test agent.',
    thinkingLevel: 'off',
  });
  return scope;
}

async function runTurn(app: TestApp, scope: IRuntimeSessionScope, text: string): Promise<void> {
  const main = scope.handle.accessor.get(IAgentLifecycleService).get(MAIN_AGENT_ID)!;
  const bus = main.accessor.get(IEventBus);
  const ended = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('turn.ended timed out'));
    }, 15_000);
    const d = bus.subscribe('turn.ended', () => {
      d.dispose();
      clearTimeout(timer);
      resolve();
    });
  });
  app.generate.mockNextResponse({ type: 'text', text } as never);
  await main.accessor.get(IAgentRPCService).prompt({ input: [{ type: 'text', text: 'hi' }] });
  await ended;
}

function contextTexts(scope: IRuntimeSessionScope): string {
  const main = scope.handle.accessor.get(IAgentLifecycleService).get(MAIN_AGENT_ID)!;
  const messages = main.accessor.get(IAgentContextMemoryService).get();
  return JSON.stringify(messages);
}

function toolNames(scope: IRuntimeSessionScope): readonly string[] {
  const main = scope.handle.accessor.get(IAgentLifecycleService).get(MAIN_AGENT_ID)!;
  return main
    .accessor.get(IAgentToolRegistryService)
    .list()
    .map((tool) => tool.name)
    .toSorted();
}

/* ------------------------------------------------------------------------ */
/* Scenarios                                                                 */
/* ------------------------------------------------------------------------ */

let app: TestApp;

beforeEach(() => {
  app = makeApp();
});

afterEach(() => {
  app.root.dispose();
  rmSync(app.homeDir, { recursive: true, force: true });
  rmSync(app.cwd, { recursive: true, force: true });
});

describe('memory host runtime: full session lifecycle without any Workspace service (plan §9.3)', () => {
  it('runs, resumes, forks, exports and deletes through the generic activation path', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-mem' });
    app.registry.register(runtime);
    await runtime.sessions.create({ sessionId: 's1', metadata: { title: 'one' } });

    // open → activate → run a real agent turn over the scripted fake model.
    const first = await activateMain(app, await runtime.sessions.open('s1', {}));
    expect(first.handle.accessor.get(ISessionContext).sessionDir).toBe('');
    // The runtime's descriptor plane carries the create() metadata; the
    // lease's engine metadata (state.json equivalent) starts from the lease.
    expect((await runtime.sessions.get('s1'))?.metadata['title']).toBe('one');
    expect((await first.handle.accessor.get(ISessionMetadata).read()).id).toBe('s1');
    await runTurn(app, first, 'hello from turn one');
    expect(app.generate.calls.length).toBe(1);
    expect(contextTexts(first)).toContain('hello from turn one');
    await first.close('explicit');

    // resume: a fresh lease + scope restores the agent context from the
    // lease's persistence — nothing lived in the App container.
    const resumed = await activateMain(app, await runtime.sessions.resume('s1', {}));
    expect(contextTexts(resumed)).toContain('hello from turn one');
    await runTurn(app, resumed, 'second turn');
    expect(contextTexts(resumed)).toContain('second turn');
    await resumed.close('explicit');

    // fork (same runtime), then the fork activates through the same path.
    await runtime.sessions.fork('s1', { sessionId: 's2' });
    const forked = await activateMain(app, await runtime.sessions.open('s2', {}));
    const forkMeta = await forked.handle.accessor.get(ISessionMetadata).read();
    expect(forkMeta.forkedFrom).toBe('s1');
    expect(contextTexts(forked)).toContain('second turn');
    await forked.close('explicit');

    // export is the runtime's logical stream.
    const exported: unknown[] = [];
    for await (const entry of runtime.sessions.export('s1')) exported.push(entry);
    expect(exported.length).toBeGreaterThan(0);

    await runtime.sessions.delete('s2');
    expect(await runtime.sessions.get('s2')).toBeUndefined();
    await runtime.sessions.delete('s1');
    expect(await runtime.sessions.get('s1')).toBeUndefined();

    // plan §1.5: the whole lifecycle never touched the App container's
    // session storage — every byte went through the lease.
    expect(app.appStorage.calls).toEqual([]);
  });
});

describe('headless session: contribution gating (plan §7.4/§9.3)', () => {
  class MarkerSessionService {
    declare readonly _serviceBrand: undefined;
    readonly kind = 'session-marker';
  }
  class MarkerAgentService {
    declare readonly _serviceBrand: undefined;
    readonly kind = 'agent-marker';
  }
  class MarkerTool implements AgentTool {
    declare readonly _serviceBrand: undefined;
    readonly name = 'MarkerTool';
    readonly description = 'runtime-contributed marker tool';
    readonly parameters: Record<string, unknown> = {};
    resolveExecution(): ToolExecution {
      return { isError: true, output: 'marker' };
    }
  }
  const IMarkerSessionService = createDecorator<MarkerSessionService>('m4MarkerSessionService');
  const IMarkerOsSessionService = createDecorator<MarkerSessionService>('m4MarkerOsSessionService');
  const IMarkerAgentService = createDecorator<MarkerAgentService>('m4MarkerAgentService');
  const IMarkerOsAgentService = createDecorator<MarkerAgentService>('m4MarkerOsAgentService');
  const IMarkerTool = createDecorator<MarkerTool>('m4MarkerTool');
  const IMarkerOsTool = createDecorator<MarkerTool>('m4MarkerOsTool');

  function contributions(): SessionRuntimeContributions {
    return {
      sessionServices: [
        {
          id: IMarkerSessionService,
          descriptor: new SyncDescriptor(MarkerSessionService),
          requires: [],
        },
        {
          id: IMarkerOsSessionService,
          descriptor: new SyncDescriptor(MarkerSessionService),
          requires: ['os.filesystem'],
        },
      ],
      agentServices: [
        {
          id: IMarkerAgentService,
          descriptor: new SyncDescriptor(MarkerAgentService),
          requires: [],
        },
        {
          id: IMarkerOsAgentService,
          descriptor: new SyncDescriptor(MarkerAgentService),
          requires: ['os.process'],
        },
      ],
      tools: [
        {
          id: IMarkerTool,
          name: 'MarkerTool',
          descriptor: new SyncDescriptor(MarkerTool),
          requires: [],
        },
        {
          id: IMarkerOsTool,
          name: 'OsMarkerTool',
          descriptor: new SyncDescriptor(MarkerTool),
          requires: ['os.terminal'],
        },
      ],
    };
  }

  it('builds the scope through the generic context: OS contributions absent, non-OS contributions present', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-gate', contributions: contributions() });
    app.registry.register(runtime);
    await runtime.sessions.create({ sessionId: 'gated' });

    const scope = await activateMain(app, await runtime.sessions.open('gated', {}));
    const get = scope.handle.accessor.get;

    // Baseline non-OS services exist.
    expect(get(ISessionMetadata)).toBeDefined();
    expect(get(ISessionMcpService)).toBeDefined();

    // OS services are not registered at all (resolution would reach the App
    // container's forbidden stubs, so assert via the registry instead):
    // the capability view answers the gating question directly.
    const main = get(IAgentLifecycleService).get(MAIN_AGENT_ID)!;
    const names = new Set(toolNames(scope));

    // Non-OS builtin tools activate; OS and host-file tools do not.
    for (const expected of [
      'TodoList',
      'AskUserQuestion',
      'TaskList',
      'TaskOutput',
      'TaskStop',
      'Skill',
      'select_tools',
      'CreateGoal',
      'FetchURL',
      'MarkerTool',
    ]) {
      expect(names, `tool ${expected}`).toContain(expected);
    }
    for (const excluded of [
      'Bash',
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'Agent',
      'AgentSwarm',
      'EnterPlanMode',
      'ExitPlanMode',
      'CronCreate',
      'CronList',
      'CronDelete',
      'OsMarkerTool',
    ]) {
      expect(names, `tool ${excluded}`).not.toContain(excluded);
    }
    expect(main).toBeDefined();

    // Runtime-contributed services respect the same gating.
    expect(get(IMarkerSessionService)).toBeInstanceOf(MarkerSessionService);
    expect(() => get(IMarkerOsSessionService)).toThrow();
    const agentGet = main.accessor.get;
    expect(agentGet(IMarkerAgentService)).toBeInstanceOf(MarkerAgentService);
    expect(() => agentGet(IMarkerOsAgentService)).toThrow();

    // The session's host interfaces are the lease projections, not App host
    // services: reads look empty, mutations are capability violations.
    const fs = get(IHostFileSystem);
    await expect(fs.writeBytes('/tmp/x', new Uint8Array())).rejects.toMatchObject({
      code: 'session.capability_unavailable',
    });
    await expect(fs.readText('/missing')).rejects.toMatchObject({ code: 'os.fs.not_found' });

    // OS-gated session services were filtered out of the collection and are
    // registered nowhere else, so resolving them fails outright.
    expect(() => get(ISessionCronService)).toThrow();
    expect(() => get(ISessionProcessRunner)).toThrow();
    expect(() => get(ISessionFsService)).toThrow();
    expect(() => get(ISessionTerminalService)).toThrow();
    expect(() => get(ISessionFsWatchService)).toThrow();

    await scope.close('explicit');
    expect(app.appStorage.calls).toEqual([]);
  });
});

describe('one runtime, two parallel sessions (plan §9.3)', () => {
  it('shares the runtime identity while state, events and locks stay isolated', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-par' });
    app.registry.register(runtime);
    await runtime.sessions.create({ sessionId: 'A' });
    await runtime.sessions.create({ sessionId: 'B' });

    const a = await activateMain(app, await runtime.sessions.open('A', {}));
    const b = await activateMain(app, await runtime.sessions.open('B', {}));
    expect(a.ref.runtimeId).toBe('rt-par');
    expect(b.ref.runtimeId).toBe('rt-par');

    // The lease is the per-session writer token: a second open of A conflicts.
    await expect(runtime.sessions.open('A', {})).rejects.toMatchObject({
      code: 'session.lease_conflict',
    });

    // State isolation: A's turn and title never leak into B.
    await runTurn(app, a, 'only in A');
    await a.handle.accessor.get(ISessionMetadata).setTitle('title-A');
    expect(contextTexts(a)).toContain('only in A');
    expect(contextTexts(b)).not.toContain('only in A');
    expect((await b.handle.accessor.get(ISessionMetadata).read()).title).toBeUndefined();

    // Closing A leaves B fully functional and the runtime online.
    await a.close('explicit');
    await runTurn(app, b, 'B keeps going');
    expect(contextTexts(b)).toContain('B keeps going');
    expect(runtime.status()).toBe('online');
    await runtime.sessions.create({ sessionId: 'C' });
    await b.close('explicit');
  });
});

describe('local workspace runtime: the same activation path (plan §9.3)', () => {
  it('drives a turn and lands the legacy layout', async () => {
    const runtime = new LocalWorkspaceRuntime({
      runtimeId: 'rt-local',
      workspaceId: 'wd_test',
      cwd: app.cwd,
      homeDir: app.homeDir,
    });
    app.registry.register(runtime);
    await runtime.sessions.create({ sessionId: 's1', metadata: { title: 'local' } });

    const lease = await runtime.sessions.open('s1', {});
    expect(lease.os?.cwd).toBe(app.cwd);
    const scope = await activateMain(app, lease);

    // OS capabilities are projected: the session resolves the real handles.
    expect(scope.handle.accessor.get(ISessionProcessRunner)).toBeDefined();
    expect(scope.handle.accessor.get(ISessionFsService)).toBeDefined();
    expect(scope.handle.accessor.get(ISessionTerminalService)).toBeDefined();
    expect(scope.handle.accessor.get(ISessionFsWatchService)).toBeDefined();
    expect(scope.handle.accessor.get(IHostFileSystem)).toBe(lease.os?.filesystem);

    const main = scope.handle.accessor.get(IAgentLifecycleService).get(MAIN_AGENT_ID)!;
    main.accessor.get(IAgentProfileService).update({ cwd: app.cwd });
    await runTurn(app, scope, 'local turn');
    await scope.close('explicit');

    // The legacy layout, byte for byte: state.json + per-agent wire.jsonl.
    const sessionDir = join(app.homeDir, 'sessions', 'wd_test', 's1');
    const state = JSON.parse(readFileSync(join(sessionDir, 'state.json'), 'utf8')) as {
      id: string;
      title?: string;
      agents?: Record<string, unknown>;
    };
    expect(state.id).toBe('s1');
    expect(state.title).toBe('local');
    expect(Object.keys(state.agents ?? {})).toContain('main');
    const wire = readFileSync(join(sessionDir, 'agents', 'main', 'wire.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string });
    expect(wire[0]?.type).toBe('metadata');
    expect(wire.length).toBeGreaterThan(1);

    // resume through the same path restores the context from disk.
    const resumed = await activateMain(app, await runtime.sessions.resume('s1', {}));
    expect(contextTexts(resumed)).toContain('local turn');
    await resumed.close('explicit');

    // The App container's storage saw NO session bytes — the only tolerated
    // calls are cron's App-side reads (a documented M4 gap, M8 moves cron to
    // the lease's typed Stores).
    for (const call of app.appStorage.calls) {
      expect(call.scope.startsWith('cron'), `unexpected App storage access: ${call.op} ${call.scope}/${call.key}`).toBe(true);
      expect(['read', 'list']).toContain(call.op);
    }

    await runtime.sessions.delete('s1');
    expect(existsSync(sessionDir)).toBe(false);
  });
});
