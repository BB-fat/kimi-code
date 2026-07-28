/**
 * `localWorkspaceRuntime` domain (L6) — `LocalWorkspaceRuntime`, the local
 * co-located workspace runtime (plan §4.3), and its `ISessionManager`.
 *
 * ONE runtime instance corresponds to ONE opened workspace (resolved cwd →
 * existing `wd_id` bucket) and hosts ANY number of sessions for its
 * lifetime: `sessions.create` is repeatable and concurrent, every session
 * shares the runtime's `runtimeId`, cwd and `sessions/<wd_id>` bucket, and
 * each session's state, locks, flush and close stay isolated in its own
 * `sessions/<wd_id>/<sessionId>` directory. Closing one session — or the
 * last — never closes the runtime; only an explicit `runtime.close(reason)`
 * flips it offline, after which every manager method fails with
 * `session.runtime_unavailable` while all session data is retained.
 *
 * Every read and write lands on the EXISTING layout (plan §4.3, §7.9):
 * `state.json` metadata documents, per-agent `wire.jsonl` journals,
 * `logs/`, `plans/`, `tasks/`, `blobs/`, the append-only
 * `session_index.jsonl` discovery log and session-tagged cron documents.
 * The runtime introduces no second repository, no locator, no
 * `.session-store`, no staging/commit markers, no routing files, no
 * refcount catalogs, no duplicate state/wire/plan metadata and no shadow
 * reads or dual-writes — the directory tree remains the index and old
 * session directories open directly, with zero importer runs. The
 * `runtimeId` is never written into session directories.
 *
 * Same-runtime fork keeps the current directory copy + wire/state rewrite +
 * index append semantics; export/import is the logical entry stream
 * (byte-passthrough) of `localSessionTransfer.ts`.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';

import { join } from 'pathe';
import { ulid } from 'ulid';

import { Error2 } from '#/_base/errors/errors';

import { SessionHostRuntimeError, SessionHostRuntimeErrors } from '#/app/sessionHostRuntime/errors';
import type {
  RuntimeCloseReason,
  SessionRuntimeCapability,
  SessionRuntimeStatus,
} from '#/app/sessionHostRuntime/sessionHostRuntime';
import type {
  CreateSessionInput,
  DeleteSessionOptions,
  ISessionManager,
  OpenSessionOptions,
  ResumeSessionOptions,
  SameRuntimeForkInput,
  SessionExportEntry,
  SessionExportOptions,
  SessionImportInput,
  SessionListQuery,
  SessionPage,
  UpdateSessionPatch,
} from '#/app/sessionHostRuntime/sessionManager';
import type {
  ISessionColdReader,
  ISessionOsCapabilities,
  SessionDescriptor,
  SessionRuntimeContributions,
} from '#/app/sessionHostRuntime/sessionRuntimeContext';
import type {
  IWorkspaceRuntime,
  WorkspaceCapability,
} from '#/app/workspace/workspaceRuntime';
import { CRON_SESSION_TAG, type CronTask } from '#/app/cron/cronTask';
import { ErrorCodes } from '#/errors';
import { HostEnvironmentService } from '#/os/backends/node-local/hostEnvironmentService';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { HostFsWatchService } from '#/os/backends/node-local/hostFsWatchService';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { HostTerminalService } from '#/os/backends/node-local/hostTerminalService';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { jsonDocumentCodec } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';
import type { SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import { AGENT_WIRE_RECORD_KEY, createWireMetadataRecord, type WireRecord } from '#/wire/record';

import {
  LocalSessionColdReader,
  LocalSessionLease,
  type LocalLeaseHandle,
} from './localSessionContext';
import {
  exportLocalSession,
  importedStateDocument,
  stageLocalImport,
  writeStagedFile,
  encodeStateDocument,
  type SessionDirFile,
} from './localSessionTransfer';
import {
  agentScopeOf,
  assertValidSessionId,
  descriptorOf,
  fnv1aHex,
  initialStateDocument,
  isValidIdSegment,
  readStateDocument,
  sessionScopeOf,
  applyMetadataPatch,
  SESSION_INDEX_KEY,
  SESSION_META_KEY,
  type StateDocument,
} from './localWorkspaceLayout';

const DEFAULT_CAPABILITIES: ReadonlySet<SessionRuntimeCapability> = new Set([
  'os.filesystem',
  'os.process',
  'os.terminal',
  'os.watch',
  'os.stdio',
  'artifact.model_read',
  'session.cold_read',
  'session.export',
  'session.import',
  'session.fork',
]);

const DEFAULT_WORKSPACE_CAPABILITIES: ReadonlySet<WorkspaceCapability> = new Set([
  'workspace.local',
]);

const NO_CONTRIBUTIONS: SessionRuntimeContributions = {
  sessionServices: [],
  agentServices: [],
  tools: [],
};

export interface LocalWorkspaceRuntimeOptions {
  /**
   * Stable runtime id, assigned by composition/Workspace registration.
   * Defaults to `local-workspace_<workspaceId>` so the same workspace
   * re-opened in one process routes to the same identity; registration
   * management (M3) owns the final convention.
   */
  readonly runtimeId?: string;
  /** The resolved `wd_id` bucket this runtime owns. */
  readonly workspaceId: string;
  /** The workspace root (the v1 `metadata.cwd` fact) stamped into `state.json`. */
  readonly cwd: string;
  /** App home dir the legacy layout is rooted at (`<homeDir>/sessions/...`). */
  readonly homeDir: string;
  /**
   * Storage backend override; defaults to the node-fs `FileStorageService`
   * rooted at `homeDir` with the same modes the bootstrap seed uses.
   */
  readonly storage?: IFileSystemStorageService;
  /** Projected capability set; defaults to the full local baseline. */
  readonly capabilities?: ReadonlySet<SessionRuntimeCapability>;
  /** Workspace capability set; defaults to `{'workspace.local'}`. */
  readonly workspaceCapabilities?: ReadonlySet<WorkspaceCapability>;
  /** Contributions projected into leases at open time; defaults to none (M4 wires real ones). */
  readonly contributions?: SessionRuntimeContributions;
  /**
   * OS capability handles projected onto every session lease (plan §7.4);
   * each missing handle defaults to the node-local backend. Composition that
   * already holds the App-scope host services should pass them in so the
   * runtime shares (not duplicates) the host connections; handles are
   * runtime-level shared resources and are never disposed per session.
   */
  readonly os?: Partial<LocalOsHandles>;
}

/** The OS handle set the local runtime projects (everything but the per-workspace `cwd`). */
export type LocalOsHandles = Omit<ISessionOsCapabilities, 'cwd'>;

function defaultLocalOsHandles(overrides?: Partial<LocalOsHandles>): LocalOsHandles {
  return {
    filesystem: overrides?.filesystem ?? new HostFileSystem(),
    process: overrides?.process ?? new HostProcessService(),
    terminal: overrides?.terminal ?? new HostTerminalService(),
    watch: overrides?.watch ?? new HostFsWatchService(),
    environment: overrides?.environment ?? new HostEnvironmentService(),
  };
}

export class LocalWorkspaceRuntime implements IWorkspaceRuntime {
  readonly id: string;
  readonly kind = 'local-workspace';
  readonly sessions: LocalWorkspaceSessionManager;
  readonly workspaceCapabilities: ReadonlySet<WorkspaceCapability>;

  private currentStatus: SessionRuntimeStatus = 'online';
  private readonly caps: ReadonlySet<SessionRuntimeCapability>;

  constructor(options: LocalWorkspaceRuntimeOptions) {
    if (!isValidIdSegment(options.workspaceId)) {
      throw new Error2(
        ErrorCodes.VALIDATION_FAILED,
        `invalid workspace id '${options.workspaceId}': must be a single segment without separators, whitespace or control characters`,
      );
    }
    if (options.cwd.length === 0) {
      throw new Error2(ErrorCodes.VALIDATION_FAILED, 'workspace cwd must not be empty');
    }
    this.id = options.runtimeId ?? `local-workspace_${options.workspaceId}`;
    this.caps = options.capabilities ?? DEFAULT_CAPABILITIES;
    this.workspaceCapabilities =
      options.workspaceCapabilities ?? DEFAULT_WORKSPACE_CAPABILITIES;
    const storage =
      options.storage ?? new FileStorageService(options.homeDir, 0o700, 0o600);
    this.sessions = new LocalWorkspaceSessionManager(
      this.id,
      options.workspaceId,
      options.cwd,
      options.homeDir,
      storage,
      () => this.currentStatus,
      (status) => {
        this.currentStatus = status;
      },
      this.caps,
      options.contributions ?? NO_CONTRIBUTIONS,
      defaultLocalOsHandles(options.os),
    );
  }

  status(): SessionRuntimeStatus {
    return this.currentStatus;
  }

  capabilities(): ReadonlySet<SessionRuntimeCapability> {
    return this.caps;
  }

  async close(_reason: RuntimeCloseReason): Promise<void> {
    await this.sessions.closeRuntime();
  }
}

export class LocalWorkspaceSessionManager implements ISessionManager {
  /** Live child leases by session id — the single-writer concurrency tokens. */
  private readonly leases = new Map<string, LocalLeaseHandle>();
  /** Append-log store for the shared `session_index.jsonl` discovery log. */
  private readonly indexLogs: AppendLogStore;

  constructor(
    private readonly runtimeId: string,
    private readonly workspaceId: string,
    private readonly cwd: string,
    private readonly homeDir: string,
    private readonly storage: IFileSystemStorageService,
    private readonly getStatus: () => SessionRuntimeStatus,
    private readonly setStatus: (status: SessionRuntimeStatus) => void,
    private readonly caps: ReadonlySet<SessionRuntimeCapability>,
    private readonly contributions: SessionRuntimeContributions,
    private readonly osHandles: LocalOsHandles,
  ) {
    this.indexLogs = new AppendLogStore(storage);
  }

  /* ---------------------------------------------------------------------- */
  /* CRUD                                                                    */
  /* ---------------------------------------------------------------------- */

  async create(input: CreateSessionInput): Promise<SessionDescriptor> {
    this.assertOnline();
    const sessionId = input.sessionId ?? `session_${randomUUID()}`;
    assertValidSessionId(sessionId);
    const scope = sessionScopeOf(this.workspaceId, sessionId);
    if ((await this.storage.read(scope, SESSION_META_KEY)) !== undefined) {
      throw new Error2(
        ErrorCodes.SESSION_ALREADY_EXISTS,
        `session '${sessionId}' already exists in runtime '${this.runtimeId}'`,
      );
    }
    const meta = initialStateDocument(sessionId, this.cwd, input.metadata, Date.now());
    const bytes = encodeStateDocument(meta);
    await this.storage.write(scope, SESSION_META_KEY, bytes, { atomic: true });
    await this.appendSessionIndexEntry(sessionId);
    return descriptorOf(this.runtimeId, meta, fnv1aHex(bytes));
  }

  async list(query?: SessionListQuery): Promise<SessionPage> {
    this.assertOnline();
    const ids = await this.storage.list(`sessions/${this.workspaceId}`);
    const descriptors: SessionDescriptor[] = [];
    for (const sessionId of ids) {
      // Tolerant per-session reads (FileSessionIndex semantics): a missing or
      // unreadable state.json simply is not a session of this bucket.
      const state = await this.readStateTolerant(sessionId);
      if (state === undefined) continue;
      const descriptor = descriptorOf(this.runtimeId, state.meta, state.revision);
      if (query?.status !== undefined && descriptor.status !== query.status) continue;
      descriptors.push(descriptor);
    }
    // The index's single recency ordering.
    descriptors.sort(
      (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    );
    const start = query?.cursor === undefined ? 0 : Number.parseInt(query.cursor, 10);
    const limit = query?.limit ?? Number.POSITIVE_INFINITY;
    const page = descriptors.slice(start, start + limit);
    const next = start + page.length;
    return {
      items: page,
      cursor: next < descriptors.length ? String(next) : undefined,
    };
  }

  async get(sessionId: string): Promise<SessionDescriptor | undefined> {
    this.assertOnline();
    const state = await this.readStateTolerant(sessionId);
    return state === undefined
      ? undefined
      : descriptorOf(this.runtimeId, state.meta, state.revision);
  }

  async update(sessionId: string, patch: UpdateSessionPatch): Promise<SessionDescriptor> {
    this.assertOnline();
    const state = await this.requireState(sessionId);
    this.assertRevision(state, patch.revision);
    let next: SessionMeta = { ...state.meta, updatedAt: Date.now() };
    if (patch.metadata !== undefined) next = applyMetadataPatch(next, patch.metadata);
    if (patch.status !== undefined) next = { ...next, archived: patch.status === 'archived' };
    const bytes = encodeStateDocument(next);
    await this.storage.write(
      sessionScopeOf(this.workspaceId, sessionId),
      SESSION_META_KEY,
      bytes,
      { atomic: true },
    );
    return descriptorOf(this.runtimeId, next, fnv1aHex(bytes));
  }

  async delete(sessionId: string, options?: DeleteSessionOptions): Promise<void> {
    this.assertOnline();
    await this.requireState(sessionId);
    const lease = this.leases.get(sessionId);
    if (lease !== undefined) {
      if (options?.force !== true) {
        throw new SessionHostRuntimeError(
          SessionHostRuntimeErrors.codes.SESSION_LEASE_CONFLICT,
          `session '${sessionId}' cannot be deleted while a live lease holds it (pass force to override)`,
          { details: { runtimeId: this.runtimeId, sessionId } },
        );
      }
      await lease.closeFromManager('deleted');
    }
    // The append-only session_index.jsonl keeps its historical line: the
    // index tolerates vanished directories, exactly like externally removed
    // session folders today. Session-tagged cron documents keep the current
    // behavior too (nothing deletes them with a session).
    await rm(this.sessionDir(sessionId), { recursive: true, force: true });
  }

  /* ---------------------------------------------------------------------- */
  /* Open / resume                                                           */
  /* ---------------------------------------------------------------------- */

  async open(sessionId: string, _options: OpenSessionOptions): Promise<LocalSessionLease> {
    this.assertOnline();
    const state = await this.requireState(sessionId);
    return this.openLease(state);
  }

  async resume(sessionId: string, options: ResumeSessionOptions): Promise<LocalSessionLease> {
    this.assertOnline();
    const state = await this.requireState(sessionId);
    this.assertRevision(state, options.expectedRevision);
    return this.openLease(state);
  }

  /* ---------------------------------------------------------------------- */
  /* Same-runtime fork (plan §5.8)                                           */
  /* ---------------------------------------------------------------------- */

  async fork(sourceSessionId: string, input: SameRuntimeForkInput): Promise<SessionDescriptor> {
    this.assertOnline();
    const source = await this.requireState(sourceSessionId);
    // A live writer may hold unflushed appends: flush its lease first so the
    // fork copies a complete point-in-time cut (the writer may append again
    // afterwards — those later writes belong to the source only).
    await this.leases.get(sourceSessionId)?.flush();

    const targetId = input.sessionId ?? `session_${randomUUID()}`;
    assertValidSessionId(targetId);
    const targetScope = sessionScopeOf(this.workspaceId, targetId);
    if ((await this.storage.read(targetScope, SESSION_META_KEY)) !== undefined) {
      throw new Error2(
        ErrorCodes.SESSION_ALREADY_EXISTS,
        `session '${targetId}' already exists in runtime '${this.runtimeId}'`,
      );
    }

    const now = Date.now();
    try {
      // 1. Directory copy with the current exclusion set (state.json, logs,
      //    wire.jsonl, symlinks) — plans/tasks/blobs/media travel as files.
      await this.copySessionFiles(this.sessionDir(sourceSessionId), this.sessionDir(targetId));
      // 2. Per-agent wire rewrite: metadata envelope guaranteed first, fork
      //    boundary appended, rewritten into the target scope.
      for (const agentId of Object.keys(source.meta.agents ?? {})) {
        await this.copyAgentWire(sourceSessionId, agentId, targetId, now);
      }
      // 3. Target state.json: source fields re-anchored to the fork.
      const forkTitle = readMetadataString(input.metadata, 'title');
      const target: SessionMeta = {
        ...source.meta,
        id: targetId,
        createdAt: now,
        updatedAt: now,
        archived: false,
        title: forkTitle ?? `Fork: ${source.meta.title ?? sourceSessionId}`,
        isCustomTitle: forkTitle !== undefined ? true : source.meta.isCustomTitle === true,
        forkedFrom: sourceSessionId,
        lastPrompt: source.meta.lastPrompt,
        custom: forkCustomMetadata(source.meta.custom, readMetadataRecord(input.metadata, 'custom')),
      };
      const bytes = encodeStateDocument(target);
      await this.storage.write(targetScope, SESSION_META_KEY, bytes, { atomic: true });
      // 4. Session-tagged cron tasks duplicate with the fork.
      await this.duplicateCronTasks(sourceSessionId, targetId);
      // 5. The discovery log learns about the fork.
      await this.appendSessionIndexEntry(targetId);
      return descriptorOf(this.runtimeId, target, fnv1aHex(bytes));
    } catch (error) {
      await rm(this.sessionDir(targetId), { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Cold read / export / import                                             */
  /* ---------------------------------------------------------------------- */

  async coldRead(sessionId: string): Promise<ISessionColdReader> {
    this.assertOnline();
    await this.requireState(sessionId);
    return new LocalSessionColdReader(this.storage, this.workspaceId, {
      runtimeId: this.runtimeId,
      sessionId,
    });
  }

  async *export(
    sessionId: string,
    _options?: SessionExportOptions,
  ): AsyncIterable<SessionExportEntry> {
    this.assertOnline();
    const state = await this.requireState(sessionId);
    // Same snapshot rule as fork: flush a live lease's pending appends first,
    // so the exported stream is a complete cut at the flush boundary.
    await this.leases.get(sessionId)?.flush();
    const files = await this.walkSessionDir(this.sessionDir(sessionId));
    yield* exportLocalSession({
      runtimeId: this.runtimeId,
      sessionId,
      meta: state.meta,
      stateBytes: state.bytes,
      files,
    });
  }

  async import(input: SessionImportInput): Promise<SessionDescriptor> {
    this.assertOnline();
    const sessionId = input.sessionId ?? `session_${randomUUID()}`;
    assertValidSessionId(sessionId);
    const scope = sessionScopeOf(this.workspaceId, sessionId);
    if ((await this.storage.read(scope, SESSION_META_KEY)) !== undefined) {
      throw new Error2(
        ErrorCodes.SESSION_ALREADY_EXISTS,
        `session '${sessionId}' already exists in runtime '${this.runtimeId}'`,
      );
    }
    const staged = await stageLocalImport(input.entries);
    try {
      // Payload first, state.json LAST: a session is visible to the index
      // only once its state.json exists, so the intermediate directory is
      // invisible to list/get (the local equivalent of staging, plan §3.5).
      for (const file of staged.files) {
        await writeStagedFile(this.storage, this.workspaceId, sessionId, file);
      }
      const meta = importedStateDocument({
        workspaceId: this.workspaceId,
        sessionId,
        cwd: this.cwd,
        staged,
        metadata: input.metadata,
        now: Date.now(),
      });
      const bytes = encodeStateDocument(meta);
      await this.storage.write(scope, SESSION_META_KEY, bytes, { atomic: true });
      await this.appendSessionIndexEntry(sessionId);
      return descriptorOf(this.runtimeId, meta, fnv1aHex(bytes));
    } catch (error) {
      await rm(this.sessionDir(sessionId), { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Runtime lifecycle                                                       */
  /* ---------------------------------------------------------------------- */

  /** Drive the whole runtime offline (plan §5.4): leases lost, data retained. */
  async closeRuntime(): Promise<void> {
    if (this.getStatus() === 'offline') return;
    this.setStatus('offline');
    const closures = [...this.leases.values()].map((lease) =>
      lease.closeFromManager('runtime_lost'),
    );
    await Promise.allSettled(closures);
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  private openLease(state: StateDocument): LocalSessionLease {
    const sessionId = state.meta.id;
    // The check-and-set is synchronous, so concurrent opens of the same
    // session race atomically: the loser sees the live lease and conflicts.
    if (this.leases.has(sessionId)) {
      throw new SessionHostRuntimeError(
        SessionHostRuntimeErrors.codes.SESSION_LEASE_CONFLICT,
        `session '${sessionId}' already has a live lease in runtime '${this.runtimeId}'`,
        { details: { runtimeId: this.runtimeId, sessionId } },
      );
    }
    const lease = new LocalSessionLease(
      this.storage,
      this.workspaceId,
      this.cwd,
      state,
      this.runtimeId,
      this.caps,
      this.contributions,
      this.osHandles,
      (closed) => {
        if (this.leases.get(sessionId) === closed) this.leases.delete(sessionId);
      },
    );
    this.leases.set(sessionId, lease);
    return lease;
  }

  private assertOnline(): void {
    if (this.getStatus() === 'online') return;
    throw new SessionHostRuntimeError(
      SessionHostRuntimeErrors.codes.SESSION_RUNTIME_UNAVAILABLE,
      `session host runtime '${this.runtimeId}' is unavailable (${this.getStatus()})`,
      { details: { runtimeId: this.runtimeId, status: this.getStatus() } },
    );
  }

  private async readStateTolerant(sessionId: string): Promise<StateDocument | undefined> {
    try {
      return await readStateDocument(
        this.storage,
        sessionScopeOf(this.workspaceId, sessionId),
        sessionId,
      );
    } catch {
      return undefined;
    }
  }

  private async requireState(sessionId: string): Promise<StateDocument> {
    let state: StateDocument | undefined;
    try {
      state = await readStateDocument(
        this.storage,
        sessionScopeOf(this.workspaceId, sessionId),
        sessionId,
      );
    } catch (error) {
      throw new SessionHostRuntimeError(
        SessionHostRuntimeErrors.codes.SESSION_OPEN_FAILED,
        `session '${sessionId}' metadata is unreadable in runtime '${this.runtimeId}'`,
        { cause: error, details: { runtimeId: this.runtimeId, sessionId } },
      );
    }
    if (state === undefined) {
      throw new Error2(
        ErrorCodes.SESSION_NOT_FOUND,
        `session '${sessionId}' does not exist in runtime '${this.runtimeId}'`,
        { details: { runtimeId: this.runtimeId, sessionId } },
      );
    }
    return state;
  }

  private assertRevision(state: StateDocument, expected: string | undefined): void {
    if (expected === undefined) return;
    if (expected === state.revision) return;
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `session '${state.meta.id}' revision mismatch: expected ${expected}, current ${state.revision}`,
      {
        details: {
          runtimeId: this.runtimeId,
          expectedRevision: expected,
          revision: state.revision,
        },
      },
    );
  }

  private sessionDir(sessionId: string): string {
    return join(this.homeDir, sessionScopeOf(this.workspaceId, sessionId));
  }

  /**
   * Append one entry to the v1-compatible `session_index.jsonl` — the same
   * line shape `sessionLifecycle` writes today, so v1 discovery keeps
   * working for sessions this runtime creates, forks or imports.
   */
  private async appendSessionIndexEntry(sessionId: string): Promise<void> {
    this.indexLogs.append('', SESSION_INDEX_KEY, {
      sessionId,
      sessionDir: this.sessionDir(sessionId),
      workDir: this.cwd,
    });
    await this.indexLogs.flush();
  }

  /**
   * Directory copy for same-runtime fork, mirroring the current semantics:
   * skip `state.json` and `logs` at the root, every `wire.jsonl` at any
   * depth, and all symbolic links; missing source directories are fine.
   */
  private async copySessionFiles(sourceDir: string, targetDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(sourceDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    await this.copySessionDirEntries(sourceDir, targetDir, entries, '');
  }

  private async copySessionDirEntries(
    sourceDir: string,
    targetDir: string,
    entries: readonly import('node:fs').Dirent[],
    relBase: string,
  ): Promise<void> {
    for (const entry of entries) {
      const rel = relBase === '' ? entry.name : `${relBase}/${entry.name}`;
      if (rel === SESSION_META_KEY || rel === 'logs' || entry.name === AGENT_WIRE_RECORD_KEY) {
        continue;
      }
      if (entry.isSymbolicLink()) continue;
      const sourcePath = join(sourceDir, entry.name);
      const targetPath = join(targetDir, entry.name);
      if (entry.isDirectory()) {
        let children;
        try {
          children = await readdir(sourcePath, { withFileTypes: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        await mkdir(targetPath, { recursive: true });
        await this.copySessionDirEntries(sourcePath, targetPath, children, rel);
      } else if (entry.isFile()) {
        const data = await readFile(sourcePath);
        await mkdir(targetDir, { recursive: true });
        await writeFile(targetPath, data);
      }
    }
  }

  /**
   * Per-agent wire copy for fork: read the source journal, guarantee the
   * metadata envelope is first, append the fork boundary, and rewrite into
   * the target agent scope — the same rewrite `sessionLifecycle` performs.
   */
  private async copyAgentWire(
    sourceSessionId: string,
    agentId: string,
    targetId: string,
    now: number,
  ): Promise<void> {
    const logs = new AppendLogStore(this.storage);
    const records: WireRecord[] = [];
    for await (const record of logs.read<WireRecord>(
      agentScopeOf(this.workspaceId, sourceSessionId, agentId),
      AGENT_WIRE_RECORD_KEY,
    )) {
      records.push(record);
    }
    if (records.length === 0) {
      records.push(createWireMetadataRecord(now));
    } else if (records[0]?.type !== 'metadata') {
      records.unshift(createWireMetadataRecord(now));
    }
    records.push({ type: 'forked', time: now });
    await logs.rewrite(
      agentScopeOf(this.workspaceId, targetId, agentId),
      AGENT_WIRE_RECORD_KEY,
      records,
    );
  }

  /** Duplicate the session-tagged cron tasks of the source into the fork. */
  private async duplicateCronTasks(sourceId: string, targetId: string): Promise<void> {
    const cronScope = `cron/${this.workspaceId}`;
    const keys = await this.storage.list(cronScope);
    for (const key of keys) {
      const bytes = await this.storage.read(cronScope, key);
      if (bytes === undefined) continue;
      let task: CronTask;
      try {
        task = jsonDocumentCodec.decode(bytes) as CronTask;
      } catch {
        continue;
      }
      if (task.tags?.[CRON_SESSION_TAG] !== sourceId) continue;
      const clone: CronTask = {
        ...task,
        id: ulid(),
        tags: { ...task.tags, [CRON_SESSION_TAG]: targetId },
      };
      await this.storage.write(cronScope, `${clone.id}.json`, jsonDocumentCodec.encode(clone), {
        atomic: true,
      });
    }
  }

  /** Collect every regular file under the session directory (symlinks excluded). */
  private async walkSessionDir(sessionDir: string): Promise<readonly SessionDirFile[]> {
    const files: SessionDirFile[] = [];
    const walk = async (dir: string, relBase: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        const rel = relBase === '' ? entry.name : `${relBase}/${entry.name}`;
        if (entry.isSymbolicLink()) continue;
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs, rel);
        } else if (entry.isFile()) {
          files.push({ rel, bytes: new Uint8Array(await readFile(abs)) });
        }
      }
    };
    await walk(sessionDir, '');
    files.sort((a, b) => a.rel.localeCompare(b.rel));
    return files;
  }
}

function readMetadataString(
  metadata: SameRuntimeForkInput['metadata'],
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readMetadataRecord(
  metadata: SameRuntimeForkInput['metadata'],
  key: string,
): Record<string, unknown> | undefined {
  const value = metadata?.[key];
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Merge custom metadata for a fork, dropping the `goal` key on both sides —
 * the same rule `sessionLifecycle` applies (goal state never crosses forks).
 */
function forkCustomMetadata(
  source: Record<string, unknown> | undefined,
  input: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const merged = { ...withoutGoal(source), ...withoutGoal(input) };
  return Object.keys(merged).length === 0 ? undefined : merged;
}

function withoutGoal(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (value === undefined) return {};
  const { goal: _drop, ...rest } = value as { goal?: unknown; [key: string]: unknown };
  return rest;
}
