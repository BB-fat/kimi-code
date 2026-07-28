/**
 * M5b tests — the `runtimeSessionHost` composition layer and the legacy /
 * runtime activation BLACK-BOX parity comparison (multi-runtime refactor,
 * plan §6.3 preparation / §9.8 first slice).
 *
 * Two halves:
 *
 *  1. `runtimeSessionHost branch behavior` — the wrapper's create/resume/
 *     fork/archive branches: plan-mode auto-enter gating, failure rollback
 *     (create/fork delete the session from its runtime; resume only closes
 *     the lease), `session_load_failed` telemetry, and the unknown-session
 *     `undefined` contract.
 *
 *  2. `legacy vs runtime activation parity` — the SAME operation sequence
 *     (create → scripted prompt turn → plan-mode round trip → media original
 *     persist → cron seed → fork → archive → restore → close → process
 *     restart → resume → turn) driven once through the legacy
 *     `ISessionLifecycleService` and once through a `LocalWorkspaceRuntime`
 *     + `IRuntimeSessionHostService`, asserting the observable surfaces
 *     agree: `SessionStart`/`SessionEnd` hook sequence, `session_started`
 *     telemetry, the `event.session.archived` publication, and the on-disk
 *     tree (`state.json`, per-agent `wire.jsonl`, `logs/`, `plans/`, plan
 *     revision blobs, `media-originals/`, `cron/<wd_id>/`,
 *     `session_index.jsonl`) after normalizing wall-clock fields, random
 *     record ids and the home-dir prefix.
 *
 * Run with `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/app/runtimeSessionHost/runtimeSessionHost.test.ts`.
 */

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';

import { isAbsolute, join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import '#/index';

import { Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { ILogOptions } from '#/_base/log/logConfig';
import { createAppScope, type IAgentScopeHandle, type ISessionScopeHandle, type Scope } from '#/_base/di/scope';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { persistOriginalImage, sessionMediaOriginalsDir } from '#/agent/media/image-originals';
import { IAgentPlanService } from '#/agent/plan/plan';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentRPCService } from '#/agent/rpc/rpc';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { bootstrap } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { DEFAULT_CRON_CONFIG } from '#/app/cron/configSection';
import { CRON_SESSION_TAG, type CronTask } from '#/app/cron/cronTask';
import { ICronTaskPersistence } from '#/app/cron/cronTaskPersistence';
import { IEventBus } from '#/app/event/eventBus';
import { IEventService } from '#/app/event/event';
import {
  IExternalHooksRunnerService,
  type ExternalHooksRunnerTriggerArgs,
} from '#/app/externalHooksRunner/externalHooksRunner';
import {
  DEFAULT_MODEL_SECTION,
  DEFAULT_PROVIDER_SECTION,
  MODELS_SECTION,
  PROVIDERS_SECTION,
} from '#/app/kosongConfig/configSection';
import { LocalWorkspaceRuntime } from '#/app/localWorkspaceRuntime/localWorkspaceRuntime';
import {
  IRuntimeSessionActivationService,
} from '#/app/runtimeSession/runtimeSessionActivation';
import {
  IRuntimeSessionHostService,
} from '#/app/runtimeSessionHost/runtimeSessionHost';
import { ISessionHostRuntimeRegistry } from '#/app/sessionHostRuntime/sessionHostRuntimeRegistry';
import type { SessionRef } from '#/app/sessionHostRuntime/sessionRef';
import { ISessionLifecycleService } from '#/app/sessionLifecycle/sessionLifecycle';
import { StandaloneMemoryHostRuntime } from '#/app/standaloneMemoryRuntime/standaloneMemoryHostRuntime';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { createHooks } from '#/hooks';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IModelService, type ModelsSection } from '#/kosong/model/model';
import { IModelOAuthTokens } from '#/kosong/model/modelOAuth';
import { IProviderService, type ProvidersSection } from '#/kosong/provider/provider';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ensureMainAgent } from '#/session/agentLifecycle/mainAgent';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import {
  createGenerateBackedProtocolRegistry,
  configService,
  emptyConfig,
  MOCK_PROVIDER,
} from '../../harness/agent';
import { createScriptedGenerate } from '../../harness/scripted-generate';
import { recordingTelemetry, type TelemetryRecord } from '../telemetry/stubs';

/* ------------------------------------------------------------------------ */
/* Constants                                                                 */
/* ------------------------------------------------------------------------ */

const RUNTIME_ID = 'rt-local';
const SESSION_ID = 'session_parity';
const FORK_ID = 'session_parity_fork';
const PLAN_ID = 'plan_parity';
const CRON_ID = '01J5X9Z8Y7W6V5T4S3R2Q1P0NM';
const PLAN_CONTENT = '# Parity Plan\n\n1. step one\n2. step two\n';
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]);

/** Fields that legitimately differ between two runs (wall clock, durations). */
const VOLATILE_KEYS = new Set([
  'time',
  'timestamp',
  'createdAt',
  'created_at',
  'updatedAt',
  'updated_at',
  'startedAt',
  'endedAt',
  'durationMs',
  'lastFiredAt',
  // LLM latency telemetry embedded in loop-event records.
  'llmClientConsumeMs',
  'llmFirstTokenLatencyMs',
  'llmServerDecodeMs',
  'llmStreamDurationMs',
]);

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// ULIDs appear bare and inside minted ids (`msg_<ulid>`, `task_<ulid>`, …).
const ULID_RE = /[0-9A-HJKMNP-TV-Z]{26}/g;

/* ------------------------------------------------------------------------ */
/* World composition                                                         */
/* ------------------------------------------------------------------------ */

interface HookRecord {
  readonly event: string;
  readonly matcherValue?: unknown;
  readonly inputData?: Record<string, unknown>;
}

interface SharedRecorders {
  readonly telemetry: TelemetryRecord[];
  readonly hooks: HookRecord[];
  readonly archived: string[];
}

interface ParityWorld {
  readonly kind: 'legacy' | 'runtime';
  readonly homeDir: string;
  readonly cwd: string;
  readonly workspaceId: string;
  readonly root: Scope;
  readonly generate: ReturnType<typeof createScriptedGenerate>;
  readonly recorders: SharedRecorders;
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

function recordingHookRunner(records: HookRecord[]): IExternalHooksRunnerService {
  const push = (event: string, args?: ExternalHooksRunnerTriggerArgs): void => {
    records.push({ event, matcherValue: args?.matcherValue, inputData: args?.inputData });
  };
  return {
    _serviceBrand: undefined,
    trigger: (event, args) => {
      push(event, args);
      return Promise.resolve([]);
    },
    triggerBlock: () => Promise.resolve(undefined),
    fireAndForgetTrigger: (event, args) => {
      push(event, args);
      return Promise.resolve([]);
    },
  };
}

function makeWorld(input: {
  readonly kind: 'legacy' | 'runtime';
  readonly homeDir: string;
  readonly cwd: string;
  readonly workspaceId: string;
  readonly recorders: SharedRecorders;
  readonly planMode?: boolean;
}): ParityWorld {
  const generate = createScriptedGenerate();
  const kimiConfig = {
    ...emptyConfig(),
    cron: DEFAULT_CRON_CONFIG,
    ...(input.planMode === true ? { defaultPlanMode: true } : {}),
  };
  const { app: root } = bootstrap(
    { homeDir: input.homeDir, cwd: input.cwd, osHomeDir: input.homeDir, env: {} },
    [
      [IConfigService, configService(() => kimiConfig)],
      [ILogService, NOOP_LOG],
      [
        ILogOptions,
        {
          level: 'info',
          globalLogPath: join(input.homeDir, 'logs', 'kimi-code.log'),
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
      [ITelemetryService, recordingTelemetry(input.recorders.telemetry)],
      [IExternalHooksRunnerService, recordingHookRunner(input.recorders.hooks)],
    ],
  );

  // Hydrate the kosong registries from the (static) config, mirroring the
  // production bootstrap.
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
  root.accessor.get(IModelCatalog).get(MOCK_PROVIDER.model);

  root.accessor.get(IEventService).subscribe((event) => {
    if (event.type === 'event.session.archived') {
      input.recorders.archived.push((event.payload as { sessionId: string }).sessionId);
    }
  });

  if (input.kind === 'runtime') {
    const runtime = new LocalWorkspaceRuntime({
      runtimeId: RUNTIME_ID,
      workspaceId: input.workspaceId,
      cwd: input.cwd,
      homeDir: input.homeDir,
    });
    root.accessor.get(ISessionHostRuntimeRegistry).register(runtime);
  }

  return {
    kind: input.kind,
    homeDir: input.homeDir,
    cwd: input.cwd,
    workspaceId: input.workspaceId,
    root,
    generate,
    recorders: input.recorders,
  };
}

/* ------------------------------------------------------------------------ */
/* The shared operation sequence                                             */
/* ------------------------------------------------------------------------ */

/** The world-kind-specific lifecycle driver; every step delegates to it. */
interface Driver {
  create(): Promise<ISessionScopeHandle>;
  resume(sessionId: string): Promise<ISessionScopeHandle | undefined>;
  restore(sessionId: string): Promise<ISessionScopeHandle | undefined>;
  fork(sourceId: string): Promise<ISessionScopeHandle>;
  archive(sessionId: string): Promise<void>;
  close(sessionId: string): Promise<void>;
}

function legacyDriver(world: ParityWorld): Driver {
  const lifecycle = (): ISessionLifecycleService => world.root.accessor.get(ISessionLifecycleService);
  return {
    create: () => lifecycle().create({ workDir: world.cwd, sessionId: SESSION_ID }),
    resume: (sessionId) => lifecycle().resume(sessionId),
    restore: (sessionId) => lifecycle().restore(sessionId),
    fork: (sourceId) =>
      lifecycle().fork({ sourceSessionId: sourceId, newSessionId: FORK_ID, title: 'Parity Fork' }),
    archive: (sessionId) => lifecycle().archive(sessionId),
    close: (sessionId) => lifecycle().close(sessionId),
  };
}

function runtimeDriver(world: ParityWorld): Driver {
  const host = (): IRuntimeSessionHostService => world.root.accessor.get(IRuntimeSessionHostService);
  const ref = (sessionId: string): SessionRef => ({ runtimeId: RUNTIME_ID, sessionId });
  return {
    create: async () =>
      (await host().create({ runtimeId: RUNTIME_ID, sessionId: SESSION_ID })).handle,
    resume: async (sessionId) => (await host().resume(ref(sessionId)))?.handle,
    restore: async (sessionId) => (await host().restore(ref(sessionId)))?.handle,
    fork: async (sourceId) =>
      (await host().fork(ref(sourceId), { newSessionId: FORK_ID, title: 'Parity Fork' })).handle,
    archive: (sessionId) => host().archive(ref(sessionId)),
    close: (sessionId) => host().close(ref(sessionId)),
  };
}

function mainAgent(handle: ISessionScopeHandle): IAgentScopeHandle {
  const main = handle.accessor.get(IAgentLifecycleService).get(MAIN_AGENT_ID);
  expect(main).toBeDefined();
  return main!;
}

async function runTurn(world: ParityWorld, handle: ISessionScopeHandle, text: string): Promise<void> {
  const main = await ensureMainAgent(handle);
  main.accessor.get(IAgentProfileService).update({
    modelAlias: MOCK_PROVIDER.model,
    systemPrompt: 'You are a test agent.',
    thinkingLevel: 'off',
    cwd: world.cwd,
  });
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
  world.generate.mockNextResponse({ type: 'text', text } as never);
  await main.accessor.get(IAgentRPCService).prompt({ input: [{ type: 'text', text: 'hi' }] });
  await ended;
}

async function planRoundTrip(handle: ISessionScopeHandle): Promise<void> {
  const plan = mainAgent(handle).accessor.get(IAgentPlanService);
  await plan.enter(PLAN_ID);
  const status = await plan.status();
  expect(status).not.toBeNull();
  expect(typeof status?.path).toBe('string');
  const hostFs = mainAgent(handle).accessor.get(IHostFileSystem);
  await hostFs.writeText(status!.path!, PLAN_CONTENT);
  await plan.recordRevision();
  await plan.exit();
}

async function persistMedia(handle: ISessionScopeHandle): Promise<void> {
  const ctx = handle.accessor.get(ISessionContext);
  const dir = sessionMediaOriginalsDir(ctx.sessionDir);
  // The M4 media-originals bug: this must never collapse to a cwd-relative
  // path on the runtime path.
  expect(isAbsolute(dir)).toBe(true);
  const saved = await persistOriginalImage(PNG_BYTES, 'image/png', { dir });
  expect(saved).not.toBeNull();
  expect(saved!.startsWith(dir)).toBe(true);
}

async function seedCronTask(world: ParityWorld): Promise<void> {
  const task: CronTask = {
    id: CRON_ID,
    cron: '0 0 1 1 *',
    prompt: 'parity ping',
    createdAt: 1_700_000_000_000,
    recurring: true,
    tags: { [CRON_SESSION_TAG]: SESSION_ID },
  };
  await world.root.accessor.get(ICronTaskPersistence).save(world.workspaceId, task);
}

/** The full black-box sequence (plan §9.8 shape), driven identically per world. */
async function runSequence(world: ParityWorld, driver: Driver): Promise<void> {
  // create → prompt turn.
  const created = await driver.create();
  await created.accessor.get(ISessionMetadata).setTitle('Parity Title');
  await runTurn(world, created, 'turn one');

  // plan mode in/out with a revision snapshot.
  await planRoundTrip(created);

  // MCP-style media original persist.
  await persistMedia(created);

  // session-tagged cron task, duplicated by the fork below.
  await seedCronTask(world);

  // fork → both source and fork live.
  const forked = await driver.fork(SESSION_ID);
  expect(forked.accessor.get(IAgentLifecycleService).get(MAIN_AGENT_ID)).toBeDefined();

  // archive + restore the source; close the fork and the source.
  await driver.archive(SESSION_ID);
  // The archived flag is durable on disk (the archived handle is disposed).
  const archivedState = JSON.parse(
    readFileSync(
      join(world.homeDir, 'sessions', world.workspaceId, SESSION_ID, 'state.json'),
      'utf8',
    ),
  ) as { archived: boolean };
  expect(archivedState.archived).toBe(true);
  const restored = await driver.restore(SESSION_ID);
  expect(restored).toBeDefined();
  expect((await restored!.accessor.get(ISessionMetadata).read()).archived).toBe(false);
  await driver.close(FORK_ID);
  await driver.close(SESSION_ID);
}

/** Restart the world's process (fresh App scope over the same home dir). */
function restartWorld(world: ParityWorld): ParityWorld {
  world.root.dispose();
  return makeWorld({
    kind: world.kind,
    homeDir: world.homeDir,
    cwd: world.cwd,
    workspaceId: world.workspaceId,
    recorders: world.recorders,
  });
}

/* ------------------------------------------------------------------------ */
/* Tree snapshot & normalization                                             */
/* ------------------------------------------------------------------------ */

interface FileEntry {
  readonly rel: string;
  readonly bytes: Uint8Array;
}

function walkTree(root: string, sub: string): FileEntry[] {
  const base = join(root, sub);
  const out: FileEntry[] = [];
  const walk = (dir: string, relBase: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relBase === '' ? entry.name : `${relBase}/${entry.name}`;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) {
        out.push({ rel, bytes: new Uint8Array(readFileSync(abs)) });
      }
    }
  };
  walk(base, '');
  return out.toSorted((a, b) => a.rel.localeCompare(b.rel));
}

/** Deep-normalize: strip wall-clock fields, random ids and the home prefix. */
function normalize(value: unknown, homeDir: string): unknown {
  if (typeof value === 'string') {
    return value
      .split(homeDir).join('<HOME>')
      .replace(UUID_RE, '<UUID>')
      .replace(ULID_RE, '<ULID>');
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item, homeDir));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (VOLATILE_KEYS.has(key)) continue;
      const normalized = normalize(entry, homeDir);
      // `custom: {}` ≡ absent `custom`: the legacy fork's metadata update
      // clobbers `custom` to undefined (key dropped), while every
      // materialization load backfills `custom ?? {}` and persists it — the
      // two shapes are interchangeable to every reader and self-heal on the
      // next load, so the comparison canonicalizes them.
      if (
        key === 'custom' &&
        normalized !== null &&
        typeof normalized === 'object' &&
        !Array.isArray(normalized) &&
        Object.keys(normalized).length === 0
      ) {
        continue;
      }
      out[key] = normalized;
    }
    return out;
  }
  return value;
}

function parseJsonLines(bytes: Uint8Array): unknown[] {
  const text = new TextDecoder().decode(bytes).trim();
  if (text === '') return [];
  return text.split('\n').map((line) => JSON.parse(line) as unknown);
}

/* ------------------------------------------------------------------------ */
/* Parity test                                                               */
/* ------------------------------------------------------------------------ */

describe('legacy vs runtime activation parity (plan §9.8)', () => {
  let cwd: string;
  let homeA: string;
  let homeB: string;
  const cleanups: string[] = [];

  beforeEach(() => {
    const tmp = realpathSync(tmpdir());
    cwd = mkdtempSync(join(tmp, 'kimi-m5b-cwd-'));
    homeA = mkdtempSync(join(tmp, 'kimi-m5b-homeA-'));
    homeB = mkdtempSync(join(tmp, 'kimi-m5b-homeB-'));
    cleanups.push(cwd, homeA, homeB);
  });

  afterEach(() => {
    for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('produces the same observable behavior and disk artifacts on both activation paths', async () => {
    const workspaceId = encodeWorkDirKey(cwd);
    const recordersA: SharedRecorders = { telemetry: [], hooks: [], archived: [] };
    const recordersB: SharedRecorders = { telemetry: [], hooks: [], archived: [] };

    let worldA = makeWorld({ kind: 'legacy', homeDir: homeA, cwd, workspaceId, recorders: recordersA });
    let worldB = makeWorld({ kind: 'runtime', homeDir: homeB, cwd, workspaceId, recorders: recordersB });

    // The legacy path resolves the workspace through its registry; the
    // runtime was constructed with the same bucket id.
    await runSequence(worldA, legacyDriver(worldA));
    await runSequence(worldB, runtimeDriver(worldB));

    /* ---- restart + resume ------------------------------------------------ */
    worldA = restartWorld(worldA);
    worldB = restartWorld(worldB);

    const resumedA = await legacyDriver(worldA).resume(SESSION_ID);
    const resumedB = await runtimeDriver(worldB).resume(SESSION_ID);
    expect(resumedA).toBeDefined();
    expect(resumedB).toBeDefined();
    await runTurn(worldA, resumedA!, 'after restart');
    await runTurn(worldB, resumedB!, 'after restart');

    /* ---- tool surface: plan tools active on both paths (live handles) ----- */
    const toolNamesOf = (handle: ISessionScopeHandle): readonly string[] =>
      mainAgent(handle)
        .accessor.get(IAgentToolRegistryService)
        .list()
        .map((tool) => tool.name)
        .toSorted();
    const namesA = toolNamesOf(resumedA!);
    const namesB = toolNamesOf(resumedB!);
    expect(namesB).toEqual(namesA);
    expect(namesB).toContain('EnterPlanMode');
    expect(namesB).toContain('ExitPlanMode');

    await legacyDriver(worldA).close(SESSION_ID);
    await runtimeDriver(worldB).close(SESSION_ID);

    /* ---- hooks: identical SessionStart/SessionEnd sequence --------------- */
    const hookShape = (records: readonly HookRecord[]): unknown[] =>
      records.map((record) => ({
        event: record.event,
        source: record.inputData?.['source'],
        reason: record.inputData?.['reason'],
      }));
    // Prompt turns fire `UserPromptSubmit` on both paths; the lifecycle
    // events are what the parity claim is about.
    const lifecycleHooks = (records: readonly HookRecord[]): unknown[] =>
      hookShape(records).filter(
        (shape) =>
          (shape as { event: string }).event === 'SessionStart' ||
          (shape as { event: string }).event === 'SessionEnd',
      );
    // NOTE (pre-existing legacy quirk, unchanged by this milestone): every
    // session's external-hooks adapter registers on the shared lifecycle
    // slot under the SAME id 'externalHooks', and OrderedHookSlot.register
    // REPLACES on id collision — so with two live sessions (source + fork)
    // only the LAST registered session's SessionEnd fires, and `SessionStart`
    // is never fired for `fork` (the adapter filters that source). Both
    // paths share the slot host, so the quirk is bit-identical across them.
    const expectedHooks = [
      { event: 'SessionStart', source: 'startup', reason: undefined }, // create
      { event: 'SessionStart', source: 'resume', reason: undefined }, // restore
      { event: 'SessionEnd', source: undefined, reason: 'exit' }, // fork close (last registration)
      { event: 'SessionStart', source: 'resume', reason: undefined }, // post-restart resume
      { event: 'SessionEnd', source: undefined, reason: 'exit' }, // final close
    ];
    expect(lifecycleHooks(recordersA.hooks)).toEqual(expectedHooks);
    expect(lifecycleHooks(recordersB.hooks)).toEqual(expectedHooks);
    // The FULL hook stream (UserPromptSubmit included) agrees between paths.
    expect(hookShape(recordersB.hooks)).toEqual(hookShape(recordersA.hooks));

    /* ---- telemetry: identical session_started sequence -------------------- */
    const sessionStarted = (records: readonly TelemetryRecord[]): unknown[] =>
      records
        .filter((record) => record.event === 'session_started' || record.event === 'session_load_failed')
        .map((record) => ({
          event: record.event,
          resumed: (record.properties as { resumed?: boolean } | undefined)?.resumed,
        }));
    const expectedStarted = [
      { event: 'session_started', resumed: false }, // create
      { event: 'session_started', resumed: false }, // fork
      { event: 'session_started', resumed: true }, // restore
      { event: 'session_started', resumed: true }, // post-restart resume
    ];
    expect(sessionStarted(recordersA.telemetry)).toEqual(expectedStarted);
    expect(sessionStarted(recordersB.telemetry)).toEqual(expectedStarted);

    /* ---- archived publication ---------------------------------------------- */
    expect(recordersA.archived).toEqual([SESSION_ID]);
    expect(recordersB.archived).toEqual([SESSION_ID]);

    /* ---- disk tree: sessions/ ---------------------------------------------- */
    const treeA = walkTree(homeA, 'sessions');
    const treeB = walkTree(homeB, 'sessions');
    expect(treeA.map((entry) => entry.rel)).toEqual(treeB.map((entry) => entry.rel));

    const normalizedJson = (entry: FileEntry, home: string): unknown =>
      normalize(JSON.parse(new TextDecoder().decode(entry.bytes)), home);
    const normalizedJsonLines = (entry: FileEntry, home: string): unknown[] =>
      parseJsonLines(entry.bytes).map((line) => normalize(line, home));

    for (const entry of treeA) {
      const other = treeB.find((candidate) => candidate.rel === entry.rel)!;
      if (entry.rel.endsWith('.json')) {
        expect(normalizedJson(entry, homeA)).toEqual(normalizedJson(other, homeB));
      } else if (entry.rel.endsWith('.jsonl')) {
        expect(normalizedJsonLines(entry, homeA)).toEqual(normalizedJsonLines(other, homeB));
      } else if (entry.rel.endsWith('.log')) {
        // Session log lines are timestamped; both files must exist and be
        // non-empty at the identical position.
        expect(other.bytes.byteLength).toBeGreaterThan(0);
        expect(entry.bytes.byteLength).toBeGreaterThan(0);
      } else {
        // Plan documents, plan revision blobs, media originals: byte-identical.
        expect(other.bytes).toEqual(entry.bytes);
      }
    }

    /* ---- the session log actually landed at the legacy position ------------ */
    const logRel = `${workspaceId}/${SESSION_ID}/logs/kimi-code.log`;
    expect(treeA.some((entry) => entry.rel === logRel)).toBe(true);

    /* ---- state.json highlights (normalized deep-equal already ran) --------- */
    const stateOf = (home: string, sessionId: string): Record<string, unknown> =>
      JSON.parse(
        readFileSync(join(home, 'sessions', workspaceId, sessionId, 'state.json'), 'utf8'),
      ) as Record<string, unknown>;
    const stateA = stateOf(homeA, SESSION_ID);
    const stateB = stateOf(homeB, SESSION_ID);
    // `agents.main.homedir` — the v1-compat field — is populated on BOTH paths.
    const homedirOf = (state: Record<string, unknown>): unknown =>
      (state['agents'] as Record<string, Record<string, unknown>>)['main']?.['homedir'];
    expect(homedirOf(stateA)).toBe(join(homeA, 'sessions', workspaceId, SESSION_ID, 'agents', 'main'));
    expect(homedirOf(stateB)).toBe(join(homeB, 'sessions', workspaceId, SESSION_ID, 'agents', 'main'));
    for (const key of ['id', 'version', 'cwd', 'title', 'isCustomTitle', 'archived', 'forkedFrom']) {
      expect(stateB[key]).toEqual(stateA[key]);
    }

    /* ---- session_index.jsonl ------------------------------------------------ */
    const indexA = parseJsonLines(new Uint8Array(readFileSync(join(homeA, 'session_index.jsonl'))));
    const indexB = parseJsonLines(new Uint8Array(readFileSync(join(homeB, 'session_index.jsonl'))));
    expect(indexA.map((line) => normalize(line, homeA))).toEqual(
      indexB.map((line) => normalize(line, homeB)),
    );

    /* ---- cron/<wd_id>/ ------------------------------------------------------- */
    const cronA = walkTree(join(homeA, 'cron'), workspaceId);
    const cronB = walkTree(join(homeB, 'cron'), workspaceId);
    // The seeded task + one fork clone per world; clone ids are ulids.
    expect(cronA).toHaveLength(2);
    expect(cronB).toHaveLength(2);
    const cronDocs = (entries: readonly FileEntry[], home: string): unknown[] =>
      entries
        .map((entry) =>
          normalize(JSON.parse(new TextDecoder().decode(entry.bytes)), home),
        )
        .map((doc) => {
          // Clone ids are random; the tag identity is what matters.
          const { id: _id, ...rest } = doc as Record<string, unknown>;
          return rest;
        })
        .toSorted((a, b) =>
          JSON.stringify((a as { tags?: unknown }).tags).localeCompare(
            JSON.stringify((b as { tags?: unknown }).tags),
          ),
        );
    expect(cronDocs(cronA, homeA)).toEqual(cronDocs(cronB, homeB));
    // The clone points at the fork; the seed still points at the source.
    const tagsA = cronDocs(cronA, homeA).map(
      (doc) => ((doc as { tags?: Record<string, string> }).tags ?? {})[CRON_SESSION_TAG],
    );
    expect(tagsA.toSorted()).toEqual([FORK_ID, SESSION_ID].toSorted());

    worldA.root.dispose();
    worldB.root.dispose();
  }, 120_000);
});

/* ------------------------------------------------------------------------ */
/* Branch behavior                                                           */
/* ------------------------------------------------------------------------ */

describe('runtimeSessionHost branch behavior', () => {
  let tmp: string;
  let cwd: string;
  let homeDir: string;

  beforeEach(() => {
    tmp = realpathSync(tmpdir());
    cwd = mkdtempSync(join(tmp, 'kimi-m5b-branch-cwd-'));
    homeDir = mkdtempSync(join(tmp, 'kimi-m5b-branch-home-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  function makeBranchApp(input: {
    readonly activation?: IRuntimeSessionActivationService;
    readonly planMode?: boolean;
  }): {
    readonly root: Scope;
    readonly host: IRuntimeSessionHostService;
    readonly registry: ISessionHostRuntimeRegistry;
    readonly telemetry: TelemetryRecord[];
    /** Session ids currently published into the live lookup via `trackActivated`. */
    readonly tracked: Set<string>;
  } {
    const telemetry: TelemetryRecord[] = [];
    const kimiConfig = {
      ...emptyConfig(),
      cron: DEFAULT_CRON_CONFIG,
      ...(input.planMode === true ? { defaultPlanMode: true } : {}),
    };
    const tracked = new Set<string>();
    const lifecycleStub = {
      _serviceBrand: undefined,
      hooks: createHooks(['onDidCreateSession', 'onWillCloseSession']),
      onDidCreateSession: Event.None,
      onDidCloseSession: Event.None,
      onDidArchiveSession: Event.None,
      onDidForkSession: Event.None,
      trackActivated: (sessionId: string) => {
        tracked.add(sessionId);
        return { dispose: () => tracked.delete(sessionId) };
      },
    } as unknown as ISessionLifecycleService;
    const { app: root } = bootstrap(
      { homeDir, cwd, osHomeDir: homeDir, env: {} },
      [
        [IConfigService, configService(() => kimiConfig)],
        [ILogService, NOOP_LOG],
        [
          ILogOptions,
          {
            level: 'info',
            globalLogPath: join(homeDir, 'logs', 'kimi-code.log'),
            globalMaxBytes: 6 * 1024 * 1024,
            globalFiles: 1,
            sessionMaxBytes: 5 * 1024 * 1024,
            sessionFiles: 1,
          } satisfies ILogOptions,
        ],
        [ITelemetryService, recordingTelemetry(telemetry)],
        [ISessionLifecycleService, lifecycleStub],
        ...(input.activation !== undefined
          ? [[IRuntimeSessionActivationService, input.activation] as const]
          : []),
      ],
    );
    return {
      root,
      host: root.accessor.get(IRuntimeSessionHostService),
      registry: root.accessor.get(ISessionHostRuntimeRegistry),
      telemetry,
      tracked,
    };
  }

  it('rolls back the runtime session when activation fails on create', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-mem' });
    const failing: IRuntimeSessionActivationService = {
      _serviceBrand: undefined,
      activate: () => Promise.reject(new Error('boom')),
    };
    const app = makeBranchApp({ activation: failing });
    app.registry.register(runtime);

    await expect(app.host.create({ runtimeId: 'rt-mem', sessionId: 's1' })).rejects.toThrow('boom');
    // The session is gone from its runtime (the legacy remove(sessionDir)
    // equivalent) and nothing stays live.
    expect(await runtime.sessions.get('s1')).toBeUndefined();
    expect(app.host.get({ runtimeId: 'rt-mem', sessionId: 's1' })).toBeUndefined();
    expect(app.host.list()).toHaveLength(0);
    expect(app.telemetry.filter((record) => record.event === 'session_started')).toHaveLength(0);
    app.root.dispose();
  });

  it('reports session_load_failed and keeps persisted data when resume fails', async () => {
    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-mem' });
    const failing: IRuntimeSessionActivationService = {
      _serviceBrand: undefined,
      activate: () => Promise.reject(new Error('boom')),
    };
    const app = makeBranchApp({ activation: failing });
    app.registry.register(runtime);
    await runtime.sessions.create({ sessionId: 's2' });

    const ref = { runtimeId: 'rt-mem', sessionId: 's2' };
    await expect(app.host.resume(ref)).rejects.toThrow('boom');
    // Persisted data is untouched; the failure is reported once.
    expect(await runtime.sessions.get('s2')).toBeDefined();
    const failures = app.telemetry.filter((record) => record.event === 'session_load_failed');
    expect(failures).toHaveLength(1);
    app.root.dispose();
  });

  it('returns undefined for unknown sessions and runtimes without telemetry noise', async () => {
    const app = makeBranchApp({});
    expect(await app.host.resume({ runtimeId: 'rt-ghost', sessionId: 'nope' })).toBeUndefined();

    const runtime = new StandaloneMemoryHostRuntime({ id: 'rt-mem' });
    app.registry.register(runtime);
    expect(await app.host.resume({ runtimeId: 'rt-mem', sessionId: 'nope' })).toBeUndefined();
    expect(app.telemetry.filter((record) => record.event === 'session_load_failed')).toHaveLength(0);
    app.root.dispose();
  });

  it('auto-enters plan mode on create when configured AND the runtime owns plan files', async () => {
    const app = makeBranchApp({ planMode: true });
    const local = new LocalWorkspaceRuntime({
      runtimeId: RUNTIME_ID,
      workspaceId: encodeWorkDirKey(cwd),
      cwd,
      homeDir,
    });
    app.registry.register(local);

    const scope = await app.host.create({ runtimeId: RUNTIME_ID, sessionId: 'pm' });
    const plan = scope.handle.accessor
      .get(IAgentLifecycleService)
      .get(MAIN_AGENT_ID)!
      .accessor.get(IAgentPlanService);
    const status = await plan.status();
    expect(status).not.toBeNull();
    expect(status!.path).toBe(
      join(homeDir, 'sessions', encodeWorkDirKey(cwd), 'pm', 'agents', 'main', 'plans', `${status!.id}.md`),
    );
    await app.host.close({ runtimeId: RUNTIME_ID, sessionId: 'pm' });
    app.root.dispose();
  });

  it('does not auto-enter plan mode on a headless runtime (no plan file owner)', async () => {
    const app = makeBranchApp({ planMode: true });
    app.registry.register(new StandaloneMemoryHostRuntime({ id: 'rt-mem' }));

    const scope = await app.host.create({ runtimeId: 'rt-mem', sessionId: 'pm-headless' });
    // No `session.host_files` capability: the legacy config auto-enter is
    // skipped instead of writing a relative plan path into the host cwd.
    expect(scope.handle.accessor.get(IAgentLifecycleService).get(MAIN_AGENT_ID)).toBeUndefined();
    expect(existsSync(join(cwd, 'agents'))).toBe(false);
    await app.host.close({ runtimeId: 'rt-mem', sessionId: 'pm-headless' });
    app.root.dispose();
  });

  it('publishes activations into the process-wide live lookup and detaches on close/archive (M5c)', async () => {
    const app = makeBranchApp({});
    app.registry.register(new StandaloneMemoryHostRuntime({ id: 'rt-mem' }));

    // create publishes immediately.
    await app.host.create({ runtimeId: 'rt-mem', sessionId: 's-created' });
    expect([...app.tracked].toSorted()).toEqual(['s-created']);

    // A cold resume publishes too; the fork tracks the target and leaves the
    // source tracked.
    await app.host.create({ runtimeId: 'rt-mem', sessionId: 's-parent' });
    await app.host.close({ runtimeId: 'rt-mem', sessionId: 's-parent' });
    expect(app.tracked.has('s-parent')).toBe(false);
    await app.host.resume({ runtimeId: 'rt-mem', sessionId: 's-parent' });
    expect(app.tracked.has('s-parent')).toBe(true);
    await app.host.fork({ runtimeId: 'rt-mem', sessionId: 's-parent' }, { newSessionId: 's-fork' });
    expect(app.tracked.has('s-fork')).toBe(true);
    expect(app.tracked.has('s-parent')).toBe(true);

    // close detaches exactly its own session; archive detaches too.
    await app.host.close({ runtimeId: 'rt-mem', sessionId: 's-fork' });
    expect(app.tracked.has('s-fork')).toBe(false);
    expect(app.tracked.has('s-parent')).toBe(true);
    await app.host.archive({ runtimeId: 'rt-mem', sessionId: 's-parent' });
    expect([...app.tracked].toSorted()).toEqual(['s-created']);
    app.root.dispose();
  });
});
