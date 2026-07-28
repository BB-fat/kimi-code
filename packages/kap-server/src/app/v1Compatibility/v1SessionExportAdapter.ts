/**
 * v1 session export adapter (multi-runtime refactor, plan §5.10/§6.3).
 *
 * `POST /api/v1/sessions/{session_id}/export` keeps its frozen HTTP contract
 * (status / headers / content-disposition / chunked stream / ZIP contents)
 * while the COLD data plane moves behind the multi-runtime contracts: the
 * bare id resolves through the v1 `IV1SessionRefResolver`, and the session's
 * files arrive as the owner runtime's logical `SessionExportEntry` stream
 * (`runtime.sessions.export`) — never assembled from the App home dir. The
 * adapter materializes that stream into a staging directory and hands it to
 * the SAME `exportSessionDirectory` zip pipeline as before, so the manifest,
 * entry names, log bundling and size limit behave byte-identically.
 *
 * The LIVE dependencies stay put (plan §6.3): a live session is still
 * flushed through the engine's own services (metadata read + session/agent
 * log + wire flush) before the runtime streams its export, exactly like the
 * pre-migration `flushLiveSession`.
 */

import { mkdtemp, open, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  ErrorCodes,
  Error2,
  IAgentLifecycleService,
  IBootstrapService,
  ILogService,
  ISessionLifecycleService,
  ISessionMetadata,
  IWorkspaceRuntimeManager,
  IWorkspaceService,
  IWireService,
  exportSessionDirectory,
  resolveGlobalLogPath,
  type ExportSessionOptions,
  type ExportSessionPayload,
  type ExportSessionResult,
  type Scope,
  type SessionExportEntry,
} from '@moonshot-ai/agent-core-v2';

import {
  createV1SessionRefResolver,
  type IV1SessionRefResolver,
} from './v1SessionRefResolver';

/** Entry names are logical relative paths; refuse anything that escapes. */
function isSafeEntryName(name: string): boolean {
  if (name.length === 0 || name.startsWith('/') || name.includes('\\')) return false;
  return name.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/**
 * The relative path an export entry materializes to inside the staging dir.
 *
 * WHITELIST materialization: only the entry kinds that belong to the frozen
 * v1 ZIP contract (plan §6.1) — `document`, `records` and `blob` payloads —
 * land in staging. The `descriptor` kind never did (the zip pipeline builds
 * its own manifest), and transfer-only kinds such as `cron` (M7, plan §7.10)
 * must NEVER reach the ZIP: session-tagged cron tasks live outside the
 * session directory, so the pre-M7 baseline ZIP never contained them. Any
 * future entry kind added for the transfer data plane is excluded here by
 * default — extending the ZIP contract is an explicit, separate decision.
 */
function entryRelativePath(entry: SessionExportEntry): string | undefined {
  if (entry.kind !== 'document' && entry.kind !== 'records' && entry.kind !== 'blob') {
    return undefined;
  }
  const name =
    entry.owner.kind === 'session' ? entry.name : `agents/${entry.owner.agentId}/${entry.name}`;
  return isSafeEntryName(name) ? name : undefined;
}

async function materializeEntries(
  entries: AsyncIterable<SessionExportEntry>,
  stagingDir: string,
): Promise<void> {
  // Entry content streams straight to its staging file (the local runtime's
  // export already reads lazily off disk), so a large session export never
  // buffers an entry's bytes in memory (M8b).
  for await (const entry of entries) {
    const rel = entryRelativePath(entry);
    if (rel === undefined) continue;
    const target = join(stagingDir, rel);
    await mkdir(dirname(target), { recursive: true });
    const handle = await open(target, 'w');
    try {
      for await (const chunk of entry.content) {
        await handle.write(chunk);
      }
    } finally {
      await handle.close();
    }
  }
}

/**
 * Flush the live session exactly like the pre-migration export did: metadata
 * ready/read (the freshest title), the session log, and every agent's wire
 * journal. Best-effort with the same warn-and-continue policy. Returns the
 * live title when the session is live.
 */
async function flushLiveSessionForExport(
  core: Scope,
  sessionId: string,
  log: { warn(msg: string, obj?: Record<string, unknown>): void },
): Promise<string | undefined> {
  const handle = core.accessor.get(ISessionLifecycleService).get(sessionId);
  if (handle === undefined) return undefined;
  let title: string | undefined;
  try {
    const metadata = handle.accessor.get(ISessionMetadata);
    await metadata.ready;
    title = (await metadata.read()).title;
  } catch (error) {
    log.warn('flushMetadata failed before export', { error });
  }
  try {
    await handle.accessor.get(ILogService).flush();
  } catch (error) {
    log.warn('export session log flush failed', { error });
  }
  const agents = handle.accessor.get(IAgentLifecycleService);
  for (const agent of agents.list()) {
    try {
      await agent.accessor.get(IWireService).flush();
    } catch (error) {
      log.warn('export agent wire flush failed', { error });
    }
  }
  return title;
}

/**
 * Export one v1 session to a zip at `input.outputPath`. Throws the same
 * `Error2`s the route already maps: `session.not_found` (40401) for an
 * unknown id; the frozen resolver mapping (ambiguous/unavailable → 50001);
 * everything from the shared zip pipeline (`session.export_not_found`,
 * `session.export_too_large`, aborts) unchanged.
 */
export async function exportV1Session(
  core: Scope,
  input: ExportSessionPayload,
  options: ExportSessionOptions = {},
  resolver: IV1SessionRefResolver = createV1SessionRefResolver(core),
): Promise<ExportSessionResult> {
  options.signal?.throwIfAborted();
  if (input.version.trim().length === 0) {
    throw new Error2(ErrorCodes.SESSION_EXPORT_MISSING_VERSION, 'Session export requires a host version.', {
      details: { sessionId: input.sessionId },
    });
  }

  const resolved = await resolver.resolve(input.sessionId);
  if (resolved.kind === 'not_found') {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `Session "${input.sessionId}" does not exist`, {
      details: { sessionId: input.sessionId },
    });
  }
  if (resolved.kind !== 'resolved') {
    // Ambiguous / unavailable are NOT "not found": surface the frozen 50001
    // through the route's generic error mapping (internal causes stay out of
    // the wire, plan §8).
    throw new Error2(
      ErrorCodes.INTERNAL,
      resolved.kind === 'ambiguous'
        ? `session ${input.sessionId} is ambiguous across runtimes`
        : `session ${input.sessionId} is temporarily unavailable`,
      { details: { sessionId: input.sessionId } },
    );
  }
  const { runtime, descriptor } = resolved.resolution;

  const log = core.accessor.get(ILogService);
  const liveTitle = await flushLiveSessionForExport(core, input.sessionId, log);
  options.signal?.throwIfAborted();
  if (input.includeGlobalLog === true) {
    try {
      await log.flush();
    } catch {
      try {
        await log.flush();
      } catch {
        // Best-effort, same as the pre-migration retry policy.
      }
    }
  }

  // The workspace root for the manifest: the catalog entry of the owning
  // runtime's workspace ONLY. This deliberately matches the pre-migration
  // baseline (`SessionExportService.flushLiveSession`): a tombstoned or
  // missing catalog entry yields `undefined` — the session's own persisted
  // `cwd` is NOT used as a fallback, keeping the ZIP content contract frozen
  // (plan §9.8) even when the richer value looks more useful.
  const registrations = core.accessor.get(IWorkspaceRuntimeManager).list();
  const workspaceId = registrations.find(
    (entry) => entry.runtimeId === resolved.resolution.ref.runtimeId,
  )?.workspaceId;
  const workspace =
    workspaceId === undefined
      ? undefined
      : await core.accessor.get(IWorkspaceService).get(workspaceId);
  const workspaceDir = workspace?.root;

  const stagingDir = await mkdtemp(join(tmpdir(), `kimi-session-export-entries-`));
  try {
    await materializeEntries(runtime.sessions.export(input.sessionId), stagingDir);
    options.signal?.throwIfAborted();
    return await exportSessionDirectory({
      request: input,
      summary: {
        id: input.sessionId,
        title: liveTitle ?? (typeof descriptor.metadata['title'] === 'string' ? descriptor.metadata['title'] : undefined),
        workspaceDir,
        sessionDir: stagingDir,
      },
      globalLogPath: resolveGlobalLogPath(core.accessor.get(IBootstrapService).homeDir),
      desktopLogPath:
        input.includeDesktopLog === true
          ? join(core.accessor.get(IBootstrapService).homeDir, 'logs', 'kimi-code-desktop.log')
          : undefined,
      webLog: options.webLog,
      signal: options.signal,
      maxArchiveBytes: options.maxArchiveBytes,
    });
  } finally {
    await rm(stagingDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(
      () => {},
    );
  }
}
