/**
 * `TranscriptService` — kap-server's session-level transcript owner.
 *
 * Live path: one `TranscriptStore` per in-memory session, bound to the core
 * engine via {@link bindSessionTranscript} on first use (idempotent) and torn
 * down by {@link dropSession} (wired to the broadcaster's close path). A
 * session that is not live in this process yields `undefined` — transcript WS
 * streaming only covers live sessions, while cold reads go through
 * {@link readColdSnapshot}. M6: every live map (store / ops listeners / op
 * journals / heal timers) is keyed by the full `SessionRef` (`sessionRefKey`)
 * and every live-entry method takes the ref — two same-named sessions hosted
 * by different runtimes get fully independent stores, op seqs and heals. The
 * backfill/heal cold reads go through the owner runtime addressed BY REF
 * (`resolver.coldRead`), never by re-resolving the bare id.
 *
 * Backfill: a freshly created live store starts empty — the binding only
 * projects events from attach time on. To make full reads (REST pages, WS
 * resets) meaningful for sessions with history, store creation kicks off an
 * idempotent backfill that replays the persisted wire records into the main
 * agent's transcript as ordinary upsert ops (never `reset`, so concurrently
 * arriving live ops survive) and seeds the roster from the session's
 * persisted agent registry. Any other agent's history is replayed on demand
 * via {@link ensureAgentHistory}. Consumers that need the established state
 * await {@link whenReady} / {@link ensureAgentHistory} (the REST route and
 * the WS subscribe path both do). The backfill also guarantees the main
 * agent's presence in the store roster, so a graded subscriber always has a
 * reset target.
 *
 * Cold path (M5a, plan §5.9/§6.3): the bare id resolves through the v1
 * `IV1SessionRefResolver` and one agent's transcript is rebuilt from the
 * persisted wire records streamed by the OWNER runtime's cold reader
 * (`runtime.sessions.coldRead` — never assembled from the App home dir), the
 * same reduction the `SnapshotReader` applies (`reduceContextTranscript`),
 * then groups the flat messages into a base snapshot via
 * `groupMessagesIntoSnapshot` and folds the non-`context.*` records
 * (tasks / interactions / todos / goal / plan / swarm) on top via
 * `foldWireRecordFacts` — best-effort fidelity. A live flush is visible to
 * the cold reader immediately (same files, same or higher revision).
 *
 * Lifecycle: entries are dropped when the session closes or archives (the
 * runtime session host's `onDidCloseSession` / `onDidArchiveSession`, M5c,
 * plus a live-lookup re-check on the cached-entry path), so later reads fall
 * through to the cold rebuild instead of serving a stale store.
 *
 * Post-turn heal: a projector that attached mid-turn (or a backfill that ran
 * before the request's content was flushed to `wire.jsonl`) holds only the
 * streamed suffix of the turn's text frames. Once a terminal `turn.upsert`
 * flows through the live-op callback, the ended turn is re-read from disk
 * (debounced per agent) and merged back live-first — see `healTurnOps`.
 */

import {
  IAgentLifecycleService,
  IRuntimeSessionHostService,
  ISessionLifecycleService,
  ISessionMetadata,
  IAgentLoopService,
  reduceContextTranscript,
  sessionRefKey,
  type IDisposable,
  type ISessionColdReader,
  type Scope,
  type SessionRef,
} from '@moonshot-ai/agent-core-v2';
import {
  TranscriptStore,
  foldWireRecordFacts,
  groupMessagesIntoSnapshot,
  isPlainAgentId,
  type AgentDescriptor,
  type AgentTranscript,
  type AgentTranscriptSnapshot,
  type TranscriptChangeEvent,
  type TranscriptMarker,
  type TranscriptOperation,
  type TranscriptTaskRef,
  type TranscriptTurn,
} from '@moonshot-ai/transcript';

import type { IV1SessionRefResolver } from '../../app/v1Compatibility/v1SessionRefResolver';
import {
  bindSessionTranscript,
  descriptorFromMeta,
  type TranscriptBinding,
  type TranscriptBindingLogger,
} from './coreBinding';

const MAIN_AGENT_ID = 'main';

/** One raw `wire.jsonl` journal line as the cold reader streams it back. */
type WireJournalRecord = { readonly type: string; readonly [key: string]: unknown };

export interface TranscriptServiceDeps {
  readonly core: Scope;
  /** The single bare-id entry point (plan §1.3) cold reads resolve through. */
  readonly resolver: IV1SessionRefResolver;
  readonly logger?: TranscriptBindingLogger;
}

interface LiveEntry {
  /** The live session's full identity — every live map is keyed by its refKey (M6). */
  readonly ref: SessionRef;
  readonly store: TranscriptStore;
  readonly binding: TranscriptBinding;
  /** Resolves when the initial main-agent history backfill has landed. */
  readonly ready: Promise<void>;
  /** Per-agent history backfill promises (dedupe concurrent ensures). */
  readonly agentBackfills: Map<string, Promise<void>>;
  /** Per-agent op-batch seq counters + bounded journals (die with the store). */
  readonly opsJournals: Map<string, AgentOpsJournal>;
}

/**
 * Per-agent op-batch journal: every dispatched batch gets the next
 * consecutive seq (from 1) and is retained oldest-first, bounded by
 * {@link TRANSCRIPT_OPS_JOURNAL_CAPACITY}. `nextSeq - 1` is the watermark
 * ("state includes every batch with seq <= N").
 */
interface AgentOpsJournal {
  nextSeq: number;
  batches: { seq: number; ops: TranscriptOperation[] }[];
}

/** Retained op batches per agent; older batches evict (catch-up turns incomplete). */
export const TRANSCRIPT_OPS_JOURNAL_CAPACITY = 2000;

/** Catch-up view over one agent's journal: batches with seq > sinceSeq, oldest first. */
export interface TranscriptOpsCatchup {
  readonly batches: readonly { seq: number; ops: readonly TranscriptOperation[] }[];
  readonly latestSeq: number;
  /** false when the journal no longer reaches back to sinceSeq — the caller must do a full refresh. */
  readonly complete: boolean;
}

export class TranscriptService {
  /** Live stores, keyed by the full `SessionRef` (`sessionRefKey`) — M6: two same-named sessions hosted by different runtimes never share an entry. */
  private readonly live = new Map<string, LiveEntry>();
  private readonly opsListeners = new Map<
    string,
    Set<(event: TranscriptChangeEvent, seq: number) => void>
  >();
  /** Debounced post-turn heals: `${sessionRefKey}:${agentId}` → pending ordinals + timer. */
  private readonly healTimers = new Map<string, { ordinals: Set<number>; timer: NodeJS.Timeout }>();

  constructor(private readonly deps: TranscriptServiceDeps) {
    // Live entries must not outlive their session: once it closes or archives,
    // reads should fall through to the cold rebuild from disk. M5c: sessions
    // are activated through the runtime session host, so the eager cleanup
    // rides the HOST's lifecycle events (which carry the full SessionRef —
    // M6); the `forSessionLive` re-check (via the process-wide live lookup,
    // which `trackActivated` feeds — M8a: every activation publishes there)
    // remains the safety net for any other activation path.
    const host = deps.core.accessor.get(IRuntimeSessionHostService);
    host.onDidCloseSession(({ ref }) => this.dropSession(ref));
    host.onDidArchiveSession(({ ref }) => this.dropSession(ref));
  }

  /**
   * Get (or create + bind) the transcript store for a session that is live in
   * this process. Returns `undefined` when the session is not in memory.
   */
  forSessionLive(ref: SessionRef): TranscriptStore | undefined {
    const key = sessionRefKey(ref);
    const existing = this.live.get(key);
    if (existing !== undefined) {
      if (this.deps.core.accessor.get(ISessionLifecycleService).getByRef(ref) !== undefined) {
        return existing.store;
      }
      // Stale entry for a session already closed/archived (the drop event may
      // not have fired on every teardown path) — do not serve it.
      this.dropSession(ref);
      return undefined;
    }
    const session = this.deps.core.accessor.get(ISessionLifecycleService).getByRef(ref);
    if (session === undefined) return undefined;
    const store = new TranscriptStore(ref.sessionId);
    let binding: TranscriptBinding;
    try {
      binding = bindSessionTranscript(store, session, this.deps.logger, (event) =>
        this.handleLiveOps(key, event),
      );
    } catch (error) {
      // The session's core scope can be disposed mid-bind during shutdown
      // (same guard as the broadcaster's `ensureState`).
      if (error instanceof Error && error.message === 'InstantiationService has been disposed') {
        return undefined;
      }
      throw error;
    }
    this.live.set(key, {
      ref,
      store,
      binding,
      ready: (async () => {
        await this.backfillMain(ref, store);
        // Pending interactions announce only after the initial backfill, so
        // the persisted tool-call frames are present for the resolve-time
        // approvalId back-link (see TranscriptBinding).
        // Scoped to the main agent here — other agents seed after their own
        // on-demand backfill (ensureAgentHistory).
        if (this.live.get(key)?.store === store) {
          binding.seedPendingInteractions(MAIN_AGENT_ID);
        }
      })(),
      agentBackfills: new Map(),
      opsJournals: new Map(),
    });
    return store;
  }

  /**
   * Resolves when the session's initial history backfill has landed (or
   * immediately when the session has no live store). Full-read consumers
   * (REST route, WS subscribe) await this so the first answer carries the
   * established main-agent transcript.
   */
  async whenReady(ref: SessionRef): Promise<void> {
    await this.live.get(sessionRefKey(ref))?.ready;
  }

  /**
   * Ensure one agent's persisted history is replayed into the live store
   * (idempotent per agent; the main agent is already covered by the initial
   * backfill). Awaited by full-read consumers for the `agent_id` they serve,
   * so any agent's transcript — including subagents that are not
   * materialized in this process — comes back established.
   */
  async ensureAgentHistory(ref: SessionRef, agentId: string): Promise<void> {
    if (agentId === MAIN_AGENT_ID) return this.whenReady(ref);
    const key = sessionRefKey(ref);
    const entry = this.live.get(key);
    if (entry === undefined) return;
    await entry.ready;
    let backfill = entry.agentBackfills.get(agentId);
    if (backfill === undefined) {
      backfill = this.backfillAgent(ref, entry.store, agentId);
      entry.agentBackfills.set(agentId, backfill);
    }
    await backfill;
    // The agent's persisted tool frames are in place now — its pending
    // interactions can be announced with resolve-time back-links intact.
    if (this.live.get(key)?.store === entry.store) {
      entry.binding.seedPendingInteractions(agentId);
    }
  }

  /** Initial backfill: main-agent history + the full roster from session metadata. */
  private async backfillMain(ref: SessionRef, store: TranscriptStore): Promise<void> {
    await this.backfillAgent(ref, store, MAIN_AGENT_ID);
    if (this.live.get(sessionRefKey(ref))?.store !== store) return;
    // Seed the roster from the session's persisted agent registry, so full
    // reads (and agent pickers) see the complete historical roster —
    // including subagents not materialized in this process.
    try {
      const session = this.deps.core.accessor.get(ISessionLifecycleService).getByRef(ref);
      const meta = await session?.accessor.get(ISessionMetadata).read();
      for (const [agentId, agentMeta] of Object.entries(meta?.agents ?? {})) {
        store.describeAgent(descriptorFromMeta(agentId, agentMeta));
      }
    } catch {
      // Roster seeding is best-effort; transcripts work without descriptors.
    }
  }

  /**
   * Replay one agent's persisted wire records into its transcript. Everything
   * is an idempotent upsert (never `reset`), so live ops arriving while the
   * records are read from disk survive the merge; turn ordinals assigned by
   * the rebuild are 0-based like the engine's, so future live turns continue
   * without colliding.
   */
  private async backfillAgent(ref: SessionRef, store: TranscriptStore, agentId: string): Promise<void> {
    const key = sessionRefKey(ref);
    const sessionId = ref.sessionId;
    let snapshot: AgentTranscriptSnapshot | undefined;
    try {
      snapshot = await this.readLiveSnapshot(ref, agentId);
    } catch (error) {
      this.deps.logger?.warn(
        { sessionId, agentId, err: error instanceof Error ? error.message : error },
        'transcript: history backfill failed, continuing without it',
      );
    }
    // The entry may have been dropped (session closed) while reading from disk.
    if (this.live.get(key)?.store !== store) return;
    const transcript = store.ensureAgent(agentId);
    if (snapshot !== undefined) {
      // Turns merge live-first (`healTurnOps`): ops the projector landed
      // while the records were being read (a tool frame's display/approvalId,
      // a longer text frame) must not be replaced by the staler persisted
      // version.
      const ops = snapshotToOps(snapshot, (turn) =>
        healTurnOps(turn, transcript.getTurn(turn.turnId)),
      );
      const overlay = this.liveTurnOverlay(ref, agentId, transcript, snapshot);
      if (overlay !== undefined) ops.push(overlay);
      const result = transcript.apply(ops);
      if (result.gap !== undefined) {
        this.deps.logger?.warn({ sessionId, agentId, gap: result.gap }, 'transcript: backfill append gap');
      }
      // Fan the backfill out like any mapped-op batch so attached subscribers
      // converge; later resets carry it wholesale anyway.
      this.dispatchOps(key, { agentId, ops });
    }
    // Land the roster entry last, so roster-driven resets already see the
    // backfilled content. Preserve a richer descriptor already seeded from
    // session metadata (parentAgentId / label); and skip ids that have
    // neither a roster presence nor any persisted content — probing a
    // nonexistent agent id must not conjure a ghost roster entry.
    const existing = store.agents().find((d) => d.agentId === agentId);
    const hasContent =
      snapshot !== undefined && (snapshot.items.length > 0 || snapshot.tasks.length > 0);
    if (existing !== undefined || hasContent) {
      store.describeAgent({
        agentId,
        type: existing?.type ?? (agentId === MAIN_AGENT_ID ? 'main' : 'sub'),
        parentAgentId: existing?.parentAgentId,
        label: existing?.label,
        createdAt: existing?.createdAt,
      });
    }
  }

  /**
   * Subscribe to the session's mapped-op stream (one shared subscription per
   * session — the broadcaster fans grades out against it). These are the
   * projector-mapped ops, not the store's accepted ops; see
   * `bindSessionTranscript` for why. Each batch carries its per-agent seq
   * (consecutive from 1; 0 only when the session has no live entry, which a
   * registered listener cannot observe). Returns `undefined` when the session
   * is not live (caller skips streaming for cold sessions).
   */
  onSessionOps(
    ref: SessionRef,
    listener: (event: TranscriptChangeEvent, seq: number) => void,
  ): IDisposable | undefined {
    if (this.forSessionLive(ref) === undefined) return undefined;
    const key = sessionRefKey(ref);
    let listeners = this.opsListeners.get(key);
    if (listeners === undefined) {
      listeners = new Set();
      this.opsListeners.set(key, listeners);
    }
    listeners.add(listener);
    return {
      dispose: () => {
        const entry = this.opsListeners.get(key);
        if (entry === undefined) return;
        entry.delete(listener);
        if (entry.size === 0) this.opsListeners.delete(key);
      },
    };
  }

  private dispatchOps(key: string, event: TranscriptChangeEvent): void {
    const seq = this.journalOps(key, event);
    const listeners = this.opsListeners.get(key);
    if (listeners === undefined) return;
    for (const listener of listeners) {
      try {
        listener(event, seq);
      } catch {
        // best-effort fan-out; a broken listener is dropped, not fatal
      }
    }
  }

  /**
   * Append one dispatched batch to its agent's journal and assign the next
   * consecutive seq. Journaling happens before the fan-out (and regardless of
   * listeners), so the watermark always covers every dispatched batch. Returns
   * 0 when the session has no live entry — the journal dies with the store.
   */
  private journalOps(key: string, event: TranscriptChangeEvent): number {
    const entry = this.live.get(key);
    if (entry === undefined) return 0;
    let journal = entry.opsJournals.get(event.agentId);
    if (journal === undefined) {
      journal = { nextSeq: 1, batches: [] };
      entry.opsJournals.set(event.agentId, journal);
    }
    const seq = journal.nextSeq++;
    journal.batches.push({ seq, ops: [...event.ops] });
    if (journal.batches.length > TRANSCRIPT_OPS_JOURNAL_CAPACITY) journal.batches.shift();
    return seq;
  }

  /**
   * Watermark for one agent: the seq of its latest dispatched op batch (0 when
   * nothing was dispatched — or the session is not live, cold sessions having
   * no journal).
   */
  getSeqWatermark(ref: SessionRef, agentId: string): number {
    const journal = this.live.get(sessionRefKey(ref))?.opsJournals.get(agentId);
    return journal === undefined ? 0 : journal.nextSeq - 1;
  }

  /**
   * Point-to-point catch-up: the journaled batches with seq > `sinceSeq`,
   * oldest first. `complete` is true only when every batch in
   * (sinceSeq, latestSeq] is retained — a sinceSeq ahead of the watermark
   * (stale cursor from a dead journal incarnation) or one the bounded journal
   * has already evicted yields `complete: false`, telling the caller to fall
   * back to a full refresh. Returns `undefined` when the session is not live
   * (cold sessions have no journal).
   */
  getOpsSince(
    ref: SessionRef,
    agentId: string,
    sinceSeq: number,
  ): TranscriptOpsCatchup | undefined {
    if (this.forSessionLive(ref) === undefined) return undefined;
    const journal = this.live.get(sessionRefKey(ref))?.opsJournals.get(agentId);
    const latestSeq = journal === undefined ? 0 : journal.nextSeq - 1;
    if (sinceSeq > latestSeq) return { batches: [], latestSeq, complete: false };
    const batches = journal?.batches.filter((batch) => batch.seq > sinceSeq) ?? [];
    // Batches are consecutive, so coverage reduces to the oldest retained seq.
    const oldest = journal?.batches[0]?.seq;
    const complete = batches.length === 0 || (oldest !== undefined && oldest <= sinceSeq + 1);
    return { batches, latestSeq, complete };
  }

  /**
   * Live (projector-mapped) op batches: fan out, then watch for terminal
   * turns to heal. Backfill batches go through `dispatchOps` directly so a
   * replayed history cannot retrigger heals.
   */
  private handleLiveOps(key: string, event: TranscriptChangeEvent): void {
    this.dispatchOps(key, event);
    for (const op of event.ops) {
      if (op.op === 'turn.upsert' && TERMINAL_TURN_STATES.has(op.turn.state)) {
        this.scheduleTurnHeal(key, event.agentId, op.turn.ordinal);
      }
    }
  }

  private scheduleTurnHeal(key: string, agentId: string, ordinal: number): void {
    const timerKey = `${key}:${agentId}`;
    const existing = this.healTimers.get(timerKey);
    if (existing !== undefined) {
      existing.ordinals.add(ordinal);
      existing.timer.refresh();
      return;
    }
    const ordinals = new Set([ordinal]);
    const timer = setTimeout(() => {
      this.healTimers.delete(timerKey);
      const entry = this.live.get(key);
      if (entry !== undefined) void this.healEndedTurns(entry.ref, agentId, ordinals);
    }, TURN_HEAL_DEBOUNCE_MS);
    timer.unref();
    this.healTimers.set(timerKey, { ordinals, timer });
  }

  /**
   * A backfill rebuilds every turn as 'completed' — the cold grouping cannot
   * see in-flight work. When the agent's loop is actually mid-turn, re-assert
   * the active turn's header as 'running' AFTER the snapshot ops (its cold
   * 'completed' header would otherwise win, even over a live running header
   * the projector already wrote). Live header fields win, then the
   * snapshot's. Returns `undefined` only when the loop is idle.
   */
  private liveTurnOverlay(
    ref: SessionRef,
    agentId: string,
    transcript: AgentTranscript,
    snapshot: AgentTranscriptSnapshot,
  ): TranscriptOperation | undefined {
    const session = this.deps.core.accessor.get(ISessionLifecycleService).getByRef(ref);
    const agent = session?.accessor.get(IAgentLifecycleService).get(agentId);
    const status = agent?.accessor.get(IAgentLoopService).status();
    if (status?.state !== 'running' || status.activeTurnId === undefined) return undefined;
    const ordinal = status.activeTurnId;
    const turnId = `t${ordinal}`;
    const existing = transcript.getTurn(turnId);
    const snapshotTurn = snapshot.items.find(
      (item): item is TranscriptTurn => item.kind === 'turn' && item.ordinal === ordinal,
    );
    return {
      op: 'turn.upsert',
      turn: {
        kind: 'turn',
        turnId,
        ordinal,
        state: 'running',
        origin: existing?.origin ?? snapshotTurn?.origin ?? { kind: 'other' },
        prompt: existing?.prompt ?? snapshotTurn?.prompt,
        startedAt: existing?.startedAt ?? snapshotTurn?.startedAt,
      },
    };
  }

  /**
   * Re-read the agent's persisted history and merge the ended turn(s) back
   * into the live store. The projector attaches to the bus at bind time, so
   * text streamed (and persisted) before that is missing from its frames; by
   * the time a turn ends, its records are complete on disk. The merge is
   * deliberately conservative (`healTurnOps`): live state wins everywhere
   * except the one regression being healed — truncated text/thinking frames.
   */
  private async healEndedTurns(
    ref: SessionRef,
    agentId: string,
    ordinals: ReadonlySet<number>,
  ): Promise<void> {
    const key = sessionRefKey(ref);
    const entry = this.live.get(key);
    if (entry === undefined) return;
    let snapshot: AgentTranscriptSnapshot | undefined;
    try {
      snapshot = await this.readLiveSnapshot(ref, agentId);
    } catch (error) {
      this.deps.logger?.warn(
        { sessionId: ref.sessionId, agentId, err: error instanceof Error ? error.message : error },
        'transcript: post-turn heal failed, continuing without it',
      );
      return;
    }
    // The entry may have been dropped (session closed) while reading from disk.
    if (snapshot === undefined || this.live.get(key)?.store !== entry.store) return;
    const transcript = entry.store.getAgent(agentId);
    if (transcript === undefined) return;
    const ops: TranscriptOperation[] = [];
    for (const item of snapshot.items) {
      if (item.kind !== 'turn' || !ordinals.has(item.ordinal)) continue;
      ops.push(...healTurnOps(item, transcript.getTurn(item.turnId)));
    }
    if (ops.length === 0) return;
    transcript.apply(ops);
    // Fan the heal out like any mapped-op batch so attached subscribers
    // converge; all ops are state-style upserts.
    this.dispatchOps(key, { agentId, ops });
  }

  /**
   * Resolve a bare id for a COLD read (plan §5.9): `undefined` means the
   * session does not exist (the route's current 40401 mapping); an ambiguous
   * or unreachable id throws — it is NOT "not found" — and surfaces as the
   * frozen 50001 through the route's global error handler.
   */
  private async resolveColdSession(sessionId: string) {
    const resolved = await this.deps.resolver.resolve(sessionId);
    if (resolved.kind === 'not_found') return undefined;
    if (resolved.kind !== 'resolved') {
      throw new Error(
        resolved.kind === 'ambiguous'
          ? `session ${sessionId} is ambiguous across runtimes`
          : `session ${sessionId} is temporarily unavailable`,
      );
    }
    return resolved.resolution;
  }

  /**
   * Roster for a cold session, read from the persisted session metadata (the
   * owner runtime's descriptor, `state.json`) and mapped like the live seeding
   * (`descriptorFromMeta`). Returns `undefined` when the session is unknown;
   * an unreadable or agent-less metadata document yields an empty roster
   * (best-effort — transcripts work without descriptors).
   */
  async readColdRoster(sessionId: string): Promise<AgentDescriptor[] | undefined> {
    const resolution = await this.resolveColdSession(sessionId);
    if (resolution === undefined) return undefined;
    const coldReader = await resolution.runtime.sessions.coldRead(sessionId);
    let agents: unknown;
    try {
      agents = (await coldReader.descriptor()).metadata['agents'];
    } catch {
      return [];
    }
    if (agents === null || typeof agents !== 'object' || Array.isArray(agents)) return [];
    return Object.entries(agents as Record<string, Parameters<typeof descriptorFromMeta>[1]>).map(
      ([agentId, agentMeta]) => descriptorFromMeta(agentId, agentMeta),
    );
  }

  /**
   * Rebuild one agent's transcript snapshot for a cold session from its
   * persisted wire records, streamed through the owner runtime's cold reader
   * (M5a — never assembled from the App home dir). Returns `undefined` when
   * the session is unknown; a known session without wire records for the
   * agent yields an empty snapshot.
   */
  async readColdSnapshot(
    sessionId: string,
    agentId: string = MAIN_AGENT_ID,
  ): Promise<AgentTranscriptSnapshot | undefined> {
    const resolution = await this.resolveColdSession(sessionId);
    if (resolution === undefined) return undefined;
    // Path-hostile ids never map to a real agent directory — answer empty
    // instead of letting the id traverse outside the agent namespace.
    if (!isPlainAgentId(agentId)) {
      return groupMessagesIntoSnapshot([]);
    }
    const coldReader = await resolution.runtime.sessions.coldRead(sessionId);
    return this.snapshotFromColdReader(coldReader, agentId);
  }

  /**
   * The live-entry half of the cold read (M6): the backfill/heal paths hold
   * the session's exact `SessionRef`, so they read through the owner runtime
   * addressed BY REF (`resolver.coldRead`) — never by re-resolving the bare
   * id, which a same-named pair on another runtime would make ambiguous.
   * Returns `undefined` when the runtime is gone (the store is about to be
   * dropped anyway).
   */
  private async readLiveSnapshot(
    ref: SessionRef,
    agentId: string,
  ): Promise<AgentTranscriptSnapshot | undefined> {
    if (!isPlainAgentId(agentId)) {
      return groupMessagesIntoSnapshot([]);
    }
    const coldReader = await this.deps.resolver.coldRead(ref);
    if (coldReader === undefined) return undefined;
    return this.snapshotFromColdReader(coldReader, agentId);
  }

  /** Fold one agent's persisted wire records (cold-reader stream) into a snapshot. */
  private async snapshotFromColdReader(
    coldReader: ISessionColdReader,
    agentId: string,
  ): Promise<AgentTranscriptSnapshot> {
    const records: WireJournalRecord[] = [];
    for await (const record of coldReader.readRecords({ agentId })) {
      records.push(record.data as WireJournalRecord);
    }
    const messages = [...reduceContextTranscript(records).entries];
    const base = groupMessagesIntoSnapshot(messages);
    // Second fold: tasks / interactions / todos / meta (goal, plan, swarm)
    // come from the non-`context.*` records in the same journal.
    return foldWireRecordFacts(records, base);
  }

  /** Dispose the live store + binding for a session (session closed / server shutdown). */
  dropSession(ref: SessionRef): void {
    const key = sessionRefKey(ref);
    this.opsListeners.delete(key);
    for (const [timerKey, pending] of this.healTimers) {
      if (timerKey.startsWith(`${key}:`)) {
        clearTimeout(pending.timer);
        this.healTimers.delete(timerKey);
      }
    }
    const entry = this.live.get(key);
    if (entry === undefined) return;
    this.live.delete(key);
    entry.binding.dispose();
  }
}

/**
 * Flatten a snapshot into idempotent upsert ops (turn/step/frame upserts,
 * standalone items, tasks, meta). Deliberately never a `reset`: upserts merge
 * by id and keep ordinal order, so the backfill cannot clobber live ops that
 * landed while the records were being read.
 *
 * Standalone items (markers / taskrefs) carry a `beforeTurn` placement anchor:
 * the reducer's standalone path is append-only, so without an anchor a
 * historical marker replayed after live turns arrived would land past them.
 * The anchor is the ordinal of the snapshot turn directly following the item
 * (trailing items anchor past the last snapshot turn, which is where the
 * engine's next live turn lands); a turn-anchored insert places the item
 * before the first turn with `ordinal >= beforeTurn`.
 *
 * `turnOps` customizes the per-turn flattening (the backfill passes a
 * live-first merge; the default flattens wholesale for cold reads).
 */
export function snapshotToOps(
  snapshot: AgentTranscriptSnapshot,
  turnOps: (turn: TranscriptTurn) => TranscriptOperation[] = snapshotTurnOps,
): TranscriptOperation[] {
  const ops: TranscriptOperation[] = [];
  /** Standalone items seen since the last turn, awaiting their anchor. */
  const pending: (TranscriptMarker | TranscriptTaskRef)[] = [];
  let lastTurnOrdinal: number | undefined;
  const flushPending = (beforeTurn?: number): void => {
    for (const item of pending) {
      ops.push(
        item.kind === 'marker'
          ? { op: 'marker.upsert', item, beforeTurn }
          : { op: 'taskref.upsert', item, beforeTurn },
      );
    }
    pending.length = 0;
  };
  for (const item of snapshot.items) {
    if (item.kind === 'turn') {
      flushPending(item.ordinal);
      lastTurnOrdinal = item.ordinal;
      ops.push(...turnOps(item));
    } else {
      pending.push(item);
    }
  }
  // Trailing standalone items followed the last snapshot turn in history but
  // precede the engine's next live turn (`lastTurnOrdinal + 1`, matched
  // robustly by the reducer's `>=` placement when ordinals drift).
  flushPending(lastTurnOrdinal === undefined ? undefined : lastTurnOrdinal + 1);
  for (const task of snapshot.tasks) {
    ops.push({ op: 'task.upsert', task });
  }
  ops.push({ op: 'meta.merge', meta: snapshot.meta });
  return ops;
}

/** One snapshot turn flattened wholesale (the cold / unseen-turn path). */
export function snapshotTurnOps(turn: TranscriptTurn): TranscriptOperation[] {
  const ops: TranscriptOperation[] = [];
  const { steps, ...header } = turn;
  ops.push({ op: 'turn.upsert', turn: header });
  for (const step of steps) {
    const { frames, ...stepHeader } = step;
    ops.push({ op: 'step.upsert', turnId: turn.turnId, step: stepHeader });
    for (const frame of frames) {
      ops.push({ op: 'frame.upsert', turnId: turn.turnId, stepId: step.stepId, frame });
    }
  }
  return ops;
}

/** Post-turn heals fire this long after the last terminal turn of an agent. */
const TURN_HEAL_DEBOUNCE_MS = 250;
const TERMINAL_TURN_STATES: ReadonlySet<TranscriptTurn['state']> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

/**
 * Merge one persisted (snapshot) turn back into the live store after the turn
 * ended — the post-turn heal for mid-turn attaches:
 *   - turn the live store never saw: taken wholesale;
 *   - header: the snapshot is authoritative for origin/prompt (it reads the
 *     persisted user message, which a mid-turn-attached projector missed);
 *     the live header wins on state and timestamps;
 *   - steps the live turn never saw: taken wholesale from the snapshot;
 *   - existing steps: text/thinking frames are re-emitted only when the
 *     persisted text is longer and the kind matches (a fresh live frame may
 *     still be ahead of a lagging flush); tool frames are re-emitted when
 *     the live step lacks the frame or the live frame lacks the outcome the
 *     persisted one carries (a tool.result dropped in the attach race is
 *     otherwise unrecoverable until a cold rebuild) — live-only extras
 *     (display / agentRefs / approvalId) are preserved on the emitted frame;
 *   - interactions are never re-emitted: they are global entities (not step
 *     content), are not persisted as context messages, and the live kernel
 *     bridge is always richer.
 */
export function healTurnOps(
  snapshotTurn: TranscriptTurn,
  liveTurn: TranscriptTurn | undefined,
): TranscriptOperation[] {
  const { steps, ...header } = snapshotTurn;
  const ops: TranscriptOperation[] = [];
  if (liveTurn === undefined) {
    ops.push({ op: 'turn.upsert', turn: header });
    for (const step of steps) {
      const { frames, ...stepHeader } = step;
      ops.push({ op: 'step.upsert', turnId: snapshotTurn.turnId, step: stepHeader });
      for (const frame of frames) {
        ops.push({ op: 'frame.upsert', turnId: snapshotTurn.turnId, stepId: step.stepId, frame });
      }
    }
    return ops;
  }
  ops.push({
    op: 'turn.upsert',
    turn: {
      ...header,
      state: liveTurn.state,
      prompt: liveTurn.prompt ?? header.prompt,
      startedAt: liveTurn.startedAt ?? header.startedAt,
      endedAt: liveTurn.endedAt ?? header.endedAt,
    },
  });
  for (const step of steps) {
    const liveStep = liveTurn.steps.find((entry) => entry.stepId === step.stepId);
    const { frames, ...stepHeader } = step;
    if (liveStep === undefined) {
      ops.push({ op: 'step.upsert', turnId: snapshotTurn.turnId, step: stepHeader });
      for (const frame of frames) {
        ops.push({ op: 'frame.upsert', turnId: snapshotTurn.turnId, stepId: step.stepId, frame });
      }
      continue;
    }
    for (const frame of frames) {
      const liveFrame = liveStep.frames.find((entry) => entry.frameId === frame.frameId);
      if (frame.kind === 'tool') {
        // Recover frames the live step never saw and results missed in the
        // attach race (a dropped tool.result is unrecoverable live). Live
        // frames that already carry the outcome stay untouched, and live-only
        // extras (display / agentRefs / approvalId) ride the emitted frame.
        const liveTool = liveFrame?.kind === 'tool' ? liveFrame : undefined;
        const liveHasOutcome =
          liveTool !== undefined && (liveTool.output !== undefined || liveTool.error !== undefined);
        const snapshotHasOutcome = frame.output !== undefined || frame.error !== undefined;
        if (liveTool !== undefined && (liveHasOutcome || !snapshotHasOutcome)) continue;
        ops.push({
          op: 'frame.upsert',
          turnId: snapshotTurn.turnId,
          stepId: step.stepId,
          frame:
            liveTool === undefined
              ? frame
              : {
                  ...frame,
                  display: liveTool.display ?? frame.display,
                  agentRefs: liveTool.agentRefs ?? frame.agentRefs,
                  approvalId: liveTool.approvalId ?? frame.approvalId,
                },
        });
        continue;
      }
      if (frame.kind !== 'text' && frame.kind !== 'thinking') continue;
      // The length shortcut only applies to the SAME frame kind: a
      // kind-mismatched live frame (the projector guessed the stream kind
      // wrong mid-turn) must be replaced by the persisted one, not skipped.
      if (
        liveFrame !== undefined &&
        liveFrame.kind === frame.kind &&
        (liveFrame.kind === 'text' || liveFrame.kind === 'thinking') &&
        liveFrame.text.length >= frame.text.length
      ) {
        continue;
      }
      ops.push({ op: 'frame.upsert', turnId: snapshotTurn.turnId, stepId: step.stepId, frame });
    }
  }
  return ops;
}
