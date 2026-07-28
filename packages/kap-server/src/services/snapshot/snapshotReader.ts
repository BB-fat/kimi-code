/**
 * `SnapshotReader` — server-layer cold reader for `GET /sessions/{sid}/snapshot`
 * (`KIMI_SNAPSHOT_READER=auto`, the default).
 *
 * M5a (multi-runtime refactor, plan §5.9/§6.3): the reader no longer assembles
 * session paths itself. The bare id is resolved through the kap-server
 * `IV1SessionRefResolver` (the single bare-id entry point), and the session's
 * metadata + wire records + blob payloads are read through the OWNER runtime's
 * `ISessionColdReader` (`runtime.sessions.coldRead`) — never through the App
 * home dir. The transcript is still reduced from the `context.*` records with
 * `reduceContextTranscript`, which mirrors the live reducers EXCEPT that
 * `context.apply_compaction` keeps the full history and appends a summary
 * marker instead of dropping the compacted prefix — the same full-transcript
 * view v1 serves (so compacted-away assistant replies stay visible after a
 * later undo). The transcript cache is keyed on the cold reader's opaque
 * `recordsRevision` token (derived by the runtime from its existing storage
 * facts — `(size, mtimeMs)` locally), keeping warm reads sub-millisecond.
 *
 * The v1 404 conditions are preserved exactly: the session must resolve AND
 * its workspace must still be registered in the catalog (an unregistered
 * workspace's sessions stay gettable but lose their snapshot, matching the
 * pre-migration `locateSession`).
 *
 * Pending approvals/questions, the live status, and `current_prompt_id` are
 * only available while the session is live; for a cold session they correctly
 * resolve to empty / `'idle'` (a cold session owns no runtime interaction).
 */

import {
  IAgentLifecycleService,
  IAgentPromptService,
  ISessionInteractionService,
  ISessionLifecycleService,
  IWorkspaceService,
  reduceContextTranscript,
  toProtocolMessage,
  type ContextMessage,
  type ISessionColdReader,
  type Scope,
  type SessionRef,
} from '@moonshot-ai/agent-core-v2';

import {
  buildV1ProjectionLookups,
  projectV1Session,
  type V1SessionSummaryFields,
} from '../../app/v1Compatibility/v1SessionProjection';
import type { IV1SessionRefResolver } from '../../app/v1Compatibility/v1SessionRefResolver';
import { toWireApproval } from '../../routes/approvals';
import { toWireQuestion } from '../../routes/questions';
import { resolveSessionFacts, toWireSession } from '../../routes/sessions';
import { type SessionEventBroadcaster } from '../../transport/ws/v1/sessionEventBroadcaster';
import type { InFlightTurn, SessionSnapshotResponse } from '../../protocol/rest-snapshot';
import { SnapshotNotFoundError } from './snapshot';
import type { ISnapshotReader } from './snapshot';
import { type SnapshotConfig } from './snapshotConfig';

const MAIN_AGENT_ID = 'main';
const SNAPSHOT_MESSAGE_PAGE_SIZE = 100;
const BLOBREF_PROTOCOL = 'blobref:';
const MISSING_MEDIA_PLACEHOLDER = '[media missing]';

export interface SnapshotReaderLogger {
  info(obj: Record<string, unknown>, msg: string): void;
}

export interface SnapshotReaderDeps {
  readonly core: Scope;
  readonly broadcaster: SessionEventBroadcaster;
  readonly logger: SnapshotReaderLogger;
  readonly config: SnapshotConfig;
  /** The single bare-id entry point (plan §1.3) the reader resolves through. */
  readonly resolver: IV1SessionRefResolver;
}

interface TranscriptCacheEntry {
  readonly revision: string;
  readonly messages: ContextMessage[];
  readonly times: readonly (number | undefined)[];
}

interface LocatedSession {
  readonly workspaceId: string;
  readonly cwd: string;
  readonly ref: SessionRef;
  readonly coldReader: ISessionColdReader;
  /** The index-shaped summary the wire builders consume (from the descriptor). */
  readonly summary: V1SessionSummaryFields;
}

export class SnapshotReader implements ISnapshotReader {
  private readonly transcriptCache = new Map<string, TranscriptCacheEntry>();

  constructor(private readonly deps: SnapshotReaderDeps) {}

  async read(sid: string): Promise<SessionSnapshotResponse> {
    const startMs = Date.now();
    const { core, broadcaster, logger } = this.deps;

    const located = await this.locateSession(sid);

    const [snapState, transcript] = await Promise.all([
      broadcaster.getSnapshotState(sid),
      this.readTranscriptCached(sid, located),
    ]);

    const full = transcript.messages;
    const hasMore = full.length > SNAPSHOT_MESSAGE_PAGE_SIZE;
    const offset = hasMore ? full.length - SNAPSHOT_MESSAGE_PAGE_SIZE : 0;
    const page = hasMore ? full.slice(offset) : full;
    await this.rehydrateBlobRefs(page, located);
    // `created_at` prefers the real per-record time stamped onto wire.jsonl at
    // dispatch; records predating the stamp (or the `metadata` envelope) fall
    // back to the synthesized `session.createdAt + index`, clamped so the
    // page stays strictly increasing (mirrors `MessageLegacyService.list`).
    let previousMs = Number.NEGATIVE_INFINITY;
    const items = page.map((msg, i) => {
      const index = offset + i;
      const baseMs = transcript.times[index] ?? located.summary.createdAt + index;
      const createdAtMs = Math.max(previousMs + 1, baseMs);
      previousMs = createdAtMs;
      return toProtocolMessage(sid, index, msg, located.summary.createdAt, createdAtMs);
    });

    const live = core.accessor.get(ISessionLifecycleService).get(sid);
    const session = toWireSession(
      { ...located.summary, workspaceId: located.workspaceId },
      located.cwd,
      resolveSessionFacts(core, sid),
    );

    const inFlightTurn = this.attachCurrentPromptId(sid, live, snapState.inFlightTurn);
    const { approvals, questions } = this.readPending(sid, live);

    logger.info(
      {
        sid,
        duration_ms: Date.now() - startMs,
        cache: transcript.tag,
        transcript_entries: full.length,
        wire_bytes: transcript.wireBytes,
      },
      'snapshot.read',
    );

    return {
      as_of_seq: snapState.seq,
      epoch: snapState.epoch,
      session,
      messages: { items, has_more: hasMore },
      in_flight_turn: inFlightTurn,
      subagents: snapState.subagents,
      pending_approvals: approvals,
      pending_questions: questions,
    };
  }

  /**
   * Resolve `(workspaceId, cwd, coldReader, summary)` for `sid` through the v1
   * ref resolver. Mirrors the legacy route's 404 conditions: the bare id does
   * not resolve to exactly one runtime session, or the workspace is no longer
   * registered in the catalog (the session stays gettable but loses its
   * snapshot, matching the pre-migration behavior).
   */
  private async locateSession(sid: string): Promise<LocatedSession> {
    const { core, resolver } = this.deps;
    const resolved = await resolver.resolve(sid);
    if (resolved.kind === 'not_found') throw new SnapshotNotFoundError(sid);
    if (resolved.kind !== 'resolved') {
      // Ambiguous / unavailable: these are not "not found" — surface the
      // frozen 50001 mapping through the route's global error handler.
      throw new Error(
        resolved.kind === 'ambiguous'
          ? `session ${sid} is ambiguous across runtimes`
          : `session ${sid} is temporarily unavailable`,
      );
    }
    const view = projectV1Session(resolved.resolution, await buildV1ProjectionLookups(core));
    if (view === undefined) throw new SnapshotNotFoundError(sid);
    const workspace = await core.accessor.get(IWorkspaceService).get(view.workspaceId);
    if (workspace === undefined) throw new SnapshotNotFoundError(sid);

    const coldReader = await resolved.resolution.runtime.sessions.coldRead(sid);
    return {
      workspaceId: view.workspaceId,
      cwd: workspace.root,
      ref: resolved.resolution.ref,
      coldReader,
      summary: view.summary,
    };
  }

  private async readTranscriptCached(
    sid: string,
    located: LocatedSession,
  ): Promise<{
    messages: ContextMessage[];
    times: readonly (number | undefined)[];
    tag: 'hit' | 'miss' | 'uncached';
    wireBytes: number;
  }> {
    // The cache key is the runtime's opaque revision token for the wire
    // journal (locally `(size, mtimeMs)` of the file — derived, never stored).
    // A runtime without a revision source (or a session with no journal yet)
    // reads uncached.
    const revision = await located.coldReader.recordsRevision?.(MAIN_AGENT_ID);
    if (revision !== undefined) {
      const cached = this.transcriptCache.get(sid);
      if (cached !== undefined && cached.revision === revision) {
        // LRU touch.
        this.transcriptCache.delete(sid);
        this.transcriptCache.set(sid, cached);
        return { messages: cached.messages, times: cached.times, tag: 'hit', wireBytes: 0 };
      }
    }

    const records: { type: string; [key: string]: unknown }[] = [];
    let wireBytes = 0;
    for await (const record of located.coldReader.readRecords({ agentId: MAIN_AGENT_ID })) {
      records.push(record.data as { type: string });
      wireBytes += JSON.stringify(record.data).length;
    }
    const { entries, times } = reduceContextTranscript(records);
    const messages = [...entries];

    if (revision === undefined) {
      this.transcriptCache.delete(sid);
      return { messages, times, tag: 'uncached', wireBytes };
    }
    if (this.transcriptCache.has(sid)) this.transcriptCache.delete(sid);
    this.transcriptCache.set(sid, { revision, messages, times });
    while (this.transcriptCache.size > this.deps.config.cacheLimit) {
      const oldest = this.transcriptCache.keys().next().value;
      if (oldest === undefined) break;
      this.transcriptCache.delete(oldest);
    }
    return { messages, times, tag: 'miss', wireBytes };
  }

  private attachCurrentPromptId(
    sid: string,
    live: ReturnType<ISessionLifecycleService['get']>,
    inFlightTurn: InFlightTurn | null,
  ): InFlightTurn | null {
    if (inFlightTurn === null || live === undefined) return inFlightTurn;
    const main = live.accessor.get(IAgentLifecycleService).get(MAIN_AGENT_ID);
    if (main === undefined) return inFlightTurn;
    let currentPromptId: string | undefined;
    try {
      currentPromptId = main.accessor.get(IAgentPromptService).list().active?.id;
    } catch {
      return inFlightTurn;
    }
    if (currentPromptId === undefined) return inFlightTurn;
    return { ...inFlightTurn, current_prompt_id: currentPromptId };
  }

  private readPending(
    sid: string,
    live: ReturnType<ISessionLifecycleService['get']>,
  ): { approvals: ReturnType<typeof toWireApproval>[]; questions: ReturnType<typeof toWireQuestion>[] } {
    if (live === undefined) return { approvals: [], questions: [] };
    const interaction = live.accessor.get(ISessionInteractionService);
    return {
      approvals: interaction.listPending('approval').map((i) => toWireApproval(i, sid)),
      questions: interaction.listPending('question').map((i) => toWireQuestion(i, sid)),
    };
  }

  /** Rehydrate `blobref:<mime>;<sha256>` media URLs through the owner runtime's cold reader; unresolvable refs become `[media missing]`. Mirrors v1. */
  private async rehydrateBlobRefs(
    messages: readonly ContextMessage[],
    located: LocatedSession,
  ): Promise<void> {
    const cache = new Map<string, string | undefined>();
    for (const message of messages) {
      for (const part of message.content) {
        for (const value of Object.values(part as unknown as Record<string, unknown>)) {
          if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
          const media = value as { url?: unknown };
          if (typeof media.url !== 'string' || !media.url.startsWith(BLOBREF_PROTOCOL)) continue;
          media.url =
            (await this.resolveBlobRef(media.url, located, cache)) ?? MISSING_MEDIA_PLACEHOLDER;
        }
      }
    }
  }

  private async resolveBlobRef(
    url: string,
    located: LocatedSession,
    cache: Map<string, string | undefined>,
  ): Promise<string | undefined> {
    if (cache.has(url)) return cache.get(url);
    let resolved: string | undefined;
    const rest = url.slice(BLOBREF_PROTOCOL.length);
    const semiIdx = rest.indexOf(';');
    if (semiIdx !== -1) {
      const mimeType = rest.slice(0, semiIdx);
      const hash = rest.slice(semiIdx + 1);
      if (/^[0-9a-f]{16,}$/i.test(hash)) {
        try {
          const stream = await located.coldReader.readArtifact({
            runtimeId: located.ref.runtimeId,
            sessionId: located.ref.sessionId,
            owner: { kind: 'agent', agentId: MAIN_AGENT_ID },
            artifactId: hash,
          });
          const reader = stream.getReader();
          const chunks: Uint8Array[] = [];
          let total = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            total += value.byteLength;
          }
          const payload = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            payload.set(chunk, offset);
            offset += chunk.byteLength;
          }
          resolved = `data:${mimeType};base64,${Buffer.from(payload).toString('base64')}`;
        } catch {
          // Missing/mismatched artifacts degrade to the placeholder, exactly
          // like an unreadable blob file did before the migration.
          resolved = undefined;
        }
      }
    }
    cache.set(url, resolved);
    return resolved;
  }
}
