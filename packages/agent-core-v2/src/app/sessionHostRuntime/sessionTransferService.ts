/**
 * `sessionHostRuntime` domain — the cross-runtime transfer contract and its
 * coordinator (plan §3.5).
 *
 * Data plane:
 *
 *   sourceRuntime.sessions.export(source.sessionId)
 *     → validated logical SessionExportEntry stream
 *     → transfer coordinator (checksum / progress / retry)
 *     → targetRuntime.sessions.import(stream)
 *     → target commit
 *     → new SessionRef
 *
 * Invariants this implementation keeps:
 *
 *   - The source stays consistent across the whole export window: the
 *     coordinator reads the source's whole-inventory `revision()` BEFORE and
 *     AFTER streaming, and a change aborts with
 *     `session.transfer_source_changed` — the target is never touched, so an
 *     aborted transfer is invisible there and the source stays the complete
 *     source of truth (plan §7.10). Runtimes without `revision()` skip the
 *     check (documented per runtime).
 *   - The coordinator buffers the validated stream in memory, so the source
 *     revision is re-checked BEFORE the target import starts — i.e. before
 *     any commit can happen. (Buffering adds nothing new asymptotically: the
 *     current local/memory exports already pre-read their full inventory.)
 *   - The target owns staging/transaction/reconcile inside
 *     `sessions.import`; an uncommitted session is invisible to list/get and
 *     a failed import leaves nothing behind. Checksum/codec/framing failures
 *     surface as `session.transfer_failed` from the target's staging with
 *     the source untouched.
 *   - The stream carries logical kind/owner/name/content/checksum/schema
 *     version only — no source physical paths, workspace ids or `wd_id`.
 *   - The coordinator's journal lives in process memory only (plan §3.5: the
 *     journal may live at the target or in an external job store — NEVER
 *     written back into a Local source directory). It is the minimal
 *     progress/failure surface for M7; automatic retry is deliberately left
 *     to callers (the coded causes mark what is retryable).
 *   - After success the source is kept by default; a move
 *     (`deleteSource: true`) re-reads the target descriptor and spot-checks
 *     its record streams, and only then deletes the source explicitly.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Error2 } from '#/_base/errors/errors';

import {
  SessionHostRuntimeError,
  SessionHostRuntimeErrors,
} from './errors';
import type { ISessionHostRuntime } from './sessionHostRuntime';
import { ISessionHostRuntimeRegistry } from './sessionHostRuntimeRegistry';
import type { SameRuntimeForkInput, SessionExportEntry } from './sessionManager';
import type { SessionRef } from './sessionRef';
import type { SessionDescriptor } from './sessionRuntimeContext';

export interface TransferSessionInput {
  readonly source: SessionRef;
  readonly targetRuntimeId: string;
  /** Runtime-local id at the target; minted by the target runtime when absent. */
  readonly targetSessionId?: string;
  /** Delete the source after the target validated its commit (a move). */
  readonly deleteSource?: boolean;
}

/** Per-kind entry counts and byte totals observed while streaming. */
export interface SessionTransferDiagnostics {
  /** Entries streamed, grouped by logical kind (kinds with zero entries absent). */
  readonly entries: Readonly<Partial<Record<SessionExportEntry['kind'], number>>>;
  /** Total content bytes streamed. */
  readonly bytes: number;
  /**
   * Entries the target import explicitly reported as skipped (a target
   * runtime's documented no-op semantics). Every current target commits the
   * full inventory — the local runtime re-schedules cron entries, the memory
   * runtime retains them as opaque blobs — so this is empty in practice; the
   * field exists so a future target can degrade explicitly instead of
   * silently.
   */
  readonly skipped: readonly SessionTransferSkippedEntry[];
}

export interface SessionTransferSkippedEntry {
  readonly kind: SessionExportEntry['kind'];
  readonly name: string;
  readonly reason: string;
}

export interface SessionTransferResult {
  /** The session's new identity at the target runtime. */
  readonly target: SessionRef;
  /** Whether the source was deleted (move) or kept (copy). */
  readonly sourceDeleted: boolean;
  /** What the data plane carried (entry counts / bytes / explicit skips). */
  readonly diagnostics: SessionTransferDiagnostics;
}

/**
 * Cross-runtime fork: export from the source runtime, import into the target
 * runtime, keep the source. Same-runtime forks never go through here — they
 * call `runtime.sessions.fork` directly.
 */
export interface CrossRuntimeForkInput extends SameRuntimeForkInput {
  readonly source: SessionRef;
  readonly targetRuntimeId: string;
}

/* ------------------------------------------------------------------------ */
/* Journal                                                                   */
/* ------------------------------------------------------------------------ */

/** Coordinator phases; a `failed` entry's `error` holds the coded cause of the phase it died in. */
export type SessionTransferPhase =
  | 'export'
  | 'import'
  | 'verify'
  | 'delete-source'
  | 'done'
  | 'failed';

/**
 * One transfer's progress/failure record (plan §3.5 journal). In-memory only:
 * the journal NEVER lands in a Local source directory, on the target's
 * storage, or anywhere else persistent — it is the coordinator's own
 * diagnostic surface.
 */
export interface SessionTransferJournalEntry {
  readonly id: string;
  readonly source: SessionRef;
  readonly targetRuntimeId: string;
  readonly targetSessionId?: string;
  /** Whether this transfer deletes its source on success (a move). */
  readonly move: boolean;
  readonly phase: SessionTransferPhase;
  /** Stream progress counters (entries buffered / bytes seen). */
  readonly entries: number;
  readonly bytes: number;
  readonly startedAt: string;
  readonly completedAt?: string;
  /** Coded cause (`session.transfer_failed`, ...) when the transfer failed. */
  readonly error?: string;
}

export interface ISessionTransferService {
  readonly _serviceBrand: undefined;

  transfer(input: TransferSessionInput): Promise<SessionTransferResult>;
  forkAcrossRuntimes(input: CrossRuntimeForkInput): Promise<SessionDescriptor>;
  /** Snapshot of the in-memory journal (newest last), for diagnostics/tests. */
  journal(): readonly SessionTransferJournalEntry[];
}

export const ISessionTransferService: ServiceIdentifier<ISessionTransferService> =
  createDecorator<ISessionTransferService>('sessionTransferService');

/* ------------------------------------------------------------------------ */
/* Coordinator                                                               */
/* ------------------------------------------------------------------------ */

/** One export entry whose content has been buffered for the second-phase import. */
interface BufferedEntry {
  readonly kind: SessionExportEntry['kind'];
  readonly owner: SessionExportEntry['owner'];
  readonly name: string;
  readonly schemaVersion: number;
  readonly checksum?: string;
  readonly bytes: Uint8Array;
}

/** Bound on retained journal entries (oldest completed entries drop first). */
const JOURNAL_CAPACITY = 64;

function transferFailed(message: string, cause?: unknown): SessionHostRuntimeError {
  return new SessionHostRuntimeError(
    SessionHostRuntimeErrors.codes.SESSION_TRANSFER_FAILED,
    message,
    { cause },
  );
}

async function concatContent(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of source) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function* toStream(entries: readonly BufferedEntry[]): AsyncIterable<SessionExportEntry> {
  for (const entry of entries) {
    const bytes = entry.bytes;
    yield {
      kind: entry.kind,
      owner: entry.owner,
      name: entry.name,
      schemaVersion: entry.schemaVersion,
      checksum: entry.checksum,
      content: (async function* () {
        yield bytes;
      })(),
    };
  }
}

export class SessionTransferService implements ISessionTransferService {
  declare readonly _serviceBrand: undefined;

  private readonly entries: SessionTransferJournalEntry[] = [];
  private sequence = 0;

  constructor(
    @ISessionHostRuntimeRegistry private readonly registry: ISessionHostRuntimeRegistry,
  ) {}

  journal(): readonly SessionTransferJournalEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  async transfer(input: TransferSessionInput): Promise<SessionTransferResult> {
    const journal = this.begin(input.source, input.targetRuntimeId, input.deleteSource === true);
    try {
      const { sourceRuntime, targetRuntime, buffered, diagnostics } = await this.runDataPlane(
        input.source,
        input.targetRuntimeId,
        journal,
      );
      const imported = await this.importInto(
        targetRuntime,
        { sessionId: input.targetSessionId, entries: buffered },
        journal,
      );
      let sourceDeleted = false;
      if (input.deleteSource === true) {
        this.advance(journal, 'verify');
        await this.verifyTarget(targetRuntime, imported.ref.sessionId, buffered);
        this.advance(journal, 'delete-source');
        try {
          await sourceRuntime.sessions.delete(input.source.sessionId);
        } catch (error) {
          throw transferFailed(
            `source delete failed after the target committed as '${imported.ref.sessionId}' (runtime '${input.targetRuntimeId}') — the copy is complete and retained`,
            error,
          );
        }
        sourceDeleted = true;
      }
      this.complete(journal, 'done');
      return { target: imported.ref, sourceDeleted, diagnostics };
    } catch (error) {
      this.fail(journal, error);
      throw error;
    }
  }

  async forkAcrossRuntimes(input: CrossRuntimeForkInput): Promise<SessionDescriptor> {
    const journal = this.begin(input.source, input.targetRuntimeId, false);
    try {
      const { targetRuntime, buffered } = await this.runDataPlane(
        input.source,
        input.targetRuntimeId,
        journal,
      );
      const imported = await this.importInto(
        targetRuntime,
        {
          sessionId: input.sessionId,
          metadata: input.metadata,
          // The target runtime applies ITS same-runtime fork identity
          // semantics (re-anchored id, `forkedFrom`, fresh timestamps,
          // unarchived, goal dropped, default fork title) — plan §5.8.
          forkFrom: input.source.sessionId,
          entries: buffered,
        },
        journal,
      );
      this.complete(journal, 'done');
      return imported;
    } catch (error) {
      this.fail(journal, error);
      throw error;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Data plane phases                                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Export + source-consistency validation: buffer the source stream while
   * bracketing it with whole-inventory revision reads. A revision change
   * aborts with `session.transfer_source_changed` before the target is ever
   * resolved against the stream — nothing reaches the target on an abort.
   */
  private async runDataPlane(
    source: SessionRef,
    targetRuntimeId: string,
    journal: SessionTransferJournalEntry,
  ): Promise<{
    readonly sourceRuntime: ISessionHostRuntime;
    readonly targetRuntime: ISessionHostRuntime;
    readonly buffered: readonly BufferedEntry[];
    readonly diagnostics: SessionTransferDiagnostics;
  }> {
    const sourceRuntime = this.registry.require(source.runtimeId);
    const targetRuntime = this.registry.require(targetRuntimeId);

    this.advance(journal, 'export');
    const revisionOf = sourceRuntime.sessions.revision?.bind(sourceRuntime.sessions);
    const before = await revisionOf?.(source.sessionId);
    const buffered: BufferedEntry[] = [];
    const byKind: Partial<Record<SessionExportEntry['kind'], number>> = {};
    let bytes = 0;
    try {
      for await (const entry of sourceRuntime.sessions.export(source.sessionId)) {
        const content = await concatContent(entry.content);
        buffered.push({
          kind: entry.kind,
          owner: entry.owner,
          name: entry.name,
          schemaVersion: entry.schemaVersion,
          checksum: entry.checksum,
          bytes: content,
        });
        byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
        bytes += content.byteLength;
        this.progress(journal, buffered.length, bytes);
      }
    } catch (error) {
      // A source that cannot produce its stream fails the transfer without
      // touching the target; the source itself is unchanged (export is
      // read-only by contract).
      throw error instanceof Error2 ? error : transferFailed('source export failed', error);
    }
    const after = await revisionOf?.(source.sessionId);
    if (before !== undefined && after !== before) {
      throw new SessionHostRuntimeError(
        SessionHostRuntimeErrors.codes.SESSION_TRANSFER_SOURCE_CHANGED,
        `session '${source.sessionId}' changed while it was being exported (revision ${before} → ${after}); nothing was imported`,
        { details: { runtimeId: source.runtimeId, sessionId: source.sessionId } },
      );
    }
    return {
      sourceRuntime,
      targetRuntime,
      buffered,
      diagnostics: { entries: byKind, bytes, skipped: [] },
    };
  }

  /** Phase 2: hand the buffered stream to the target's staged import/commit. */
  private async importInto(
    targetRuntime: ISessionHostRuntime,
    input: {
      readonly sessionId?: string;
      readonly metadata?: SameRuntimeForkInput['metadata'];
      readonly forkFrom?: string;
      readonly entries: readonly BufferedEntry[];
    },
    journal: SessionTransferJournalEntry,
  ): Promise<SessionDescriptor> {
    this.advance(journal, 'import');
    try {
      return await targetRuntime.sessions.import({
        sessionId: input.sessionId,
        metadata: input.metadata,
        forkFrom: input.forkFrom,
        entries: toStream(input.entries),
      });
    } catch (error) {
      // Staging surfaces checksum/codec/framing failures as coded errors
      // already (session.transfer_failed / session.already_exists); anything
      // else is an unstructured target failure — wrap it so callers always
      // see a coded cause. The target's staged import guarantees no
      // half-committed session is visible afterwards.
      throw error instanceof Error2 ? error : transferFailed('target import failed', error);
    }
  }

  /**
   * Move gate (plan §3.5/§9.6): the source is deleted only after the target
   * proves its commit — the descriptor is visible and every record-owning
   * agent's stream reads back. A verification failure keeps BOTH sides: the
   * source stays the owner, and the (already committed) target copy is left
   * for the caller to keep or clean up explicitly. (Roster shape is a
   * per-runtime convention — the local runtime persists it in `state.json`
   * while the memory runtime derives it from namespaces — so the check reads
   * record streams directly instead of comparing rosters.)
   */
  private async verifyTarget(
    targetRuntime: ISessionHostRuntime,
    sessionId: string,
    buffered: readonly BufferedEntry[],
  ): Promise<void> {
    const descriptor = await targetRuntime.sessions.get(sessionId);
    if (descriptor === undefined) {
      throw transferFailed(
        `target session '${sessionId}' is not visible after the import commit; the source was NOT deleted`,
      );
    }
    const recordAgents = new Set<string>();
    for (const entry of buffered) {
      if (entry.kind === 'records' && entry.owner.kind === 'agent') {
        recordAgents.add(entry.owner.agentId);
      }
    }
    if (recordAgents.size === 0) return;
    const cold = await targetRuntime.sessions.coldRead(sessionId);
    for (const entry of buffered) {
      if (entry.kind !== 'records' || entry.owner.kind !== 'agent') continue;
      let saw = false;
      // Spot-check readability: the agent's stream must iterate its records.
      for await (const record of cold.readRecords({ agentId: entry.owner.agentId, limit: 1 })) {
        void record;
        saw = true;
        break;
      }
      // An entry that carried records must read at least one back; an empty
      // stream entry only needs to iterate without failing.
      if (!saw && entry.bytes.byteLength > 0) {
        throw transferFailed(
          `target session '${sessionId}' cannot read back agent '${entry.owner.agentId}' records after the import; the source was NOT deleted`,
        );
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Journal internals                                                       */
  /* ---------------------------------------------------------------------- */

  private begin(
    source: SessionRef,
    targetRuntimeId: string,
    move: boolean,
  ): SessionTransferJournalEntry {
    const entry: SessionTransferJournalEntry = {
      id: `transfer-${++this.sequence}`,
      source,
      targetRuntimeId,
      move,
      phase: 'export',
      entries: 0,
      bytes: 0,
      startedAt: new Date().toISOString(),
    };
    this.entries.push(entry);
    if (this.entries.length > JOURNAL_CAPACITY) {
      // Drop the oldest COMPLETED entries first; in-flight ones stay.
      const drop = this.entries.findIndex((candidate) => candidate.completedAt !== undefined);
      this.entries.splice(drop === -1 ? 0 : drop, 1);
    }
    return entry;
  }

  private advance(entry: SessionTransferJournalEntry, phase: SessionTransferPhase): void {
    (entry as { phase: SessionTransferPhase }).phase = phase;
  }

  private progress(entry: SessionTransferJournalEntry, entries: number, bytes: number): void {
    (entry as { entries: number }).entries = entries;
    (entry as { bytes: number }).bytes = bytes;
  }

  private complete(entry: SessionTransferJournalEntry, phase: SessionTransferPhase): void {
    this.advance(entry, phase);
    (entry as { completedAt: string }).completedAt = new Date().toISOString();
  }

  private fail(entry: SessionTransferJournalEntry, error: unknown): void {
    this.advance(entry, 'failed');
    (entry as { completedAt: string }).completedAt = new Date().toISOString();
    (entry as { error: string }).error =
      error instanceof Error2 ? error.code : String(error);
  }
}

registerScopedService(
  LifecycleScope.App,
  ISessionTransferService,
  SessionTransferService,
  ScopeActivation.OnDemand,
  'sessionHostRuntime',
);
