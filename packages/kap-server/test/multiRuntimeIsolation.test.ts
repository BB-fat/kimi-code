/**
 * Multi-runtime same-name isolation (M6, plan §6.4/§9.7 last rule).
 *
 * Two runtimes hosting a LIVE session with the SAME bare id at once: the
 * broadcaster, the transcript service and the event journals must keep the
 * pair fully apart — frames, transcript stores, op seqs, watermarks and
 * journal files are addressed by the full `SessionRef`, while every outbound
 * frame still projects the bare `session_id` (the v1 wire never changes).
 *
 * Plus the WS edge's ambiguity mapping (plan §6.4: "无法唯一解析时按现有 WS
 * error/control 行为返回兼容错误，不订阅任意候选"): a control frame whose
 * bare id matches more than one runtime gets the existing non-zero-code ack
 * channel (50001, frozen REST wording) and NO subscription is created.
 */

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IAgentLifecycleService,
  IEventBus,
  IEventService,
  IRuntimeSessionHostService,
  ISessionActivityView,
  ISessionInteractionService,
  ISessionLifecycleService,
  ISessionMetadata,
  sessionRefKey,
  type Scope,
  type SessionRef,
} from '@moonshot-ai/agent-core-v2';
import { StateRegistry, SessionInteractionService } from '@moonshot-ai/agent-core-v2';
import type { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConnectionRegistry } from '../src/transport/ws/connectionRegistry';
import {
  SessionEventBroadcaster,
  type BroadcastTarget,
} from '../src/transport/ws/v1/sessionEventBroadcaster';
import {
  type EventEnvelope,
  sessionJournalPath,
} from '../src/transport/ws/v1/sessionEventJournal';
import { WsConnectionV1 } from '../src/transport/ws/v1/wsConnectionV1';
import type { IV1SessionRefResolver } from '../src/app/v1Compatibility/v1SessionRefResolver';
import { TranscriptService } from '../src/services/transcript/transcriptService';

const RT_A = 'rt-a';
const RT_B = 'rt-b';
const SHARED_ID = 'shared-session';

const refA: SessionRef = { runtimeId: RT_A, sessionId: SHARED_ID };
const refB: SessionRef = { runtimeId: RT_B, sessionId: SHARED_ID };

// ---------------------------------------------------------------------------
// Fakes (trimmed mirrors of sessionEventBroadcaster.test.ts's harness)
// ---------------------------------------------------------------------------

class FakeAgentBus {
  private allHandlers: Array<(e: { type: string }) => void> = [];
  subscribe(handler: (e: { type: string }) => void): { dispose(): void };
  subscribe(type: string, handler: (e: { type: string }) => void): { dispose(): void };
  subscribe(
    typeOrHandler: string | ((e: { type: string }) => void),
    handler?: (e: { type: string }) => void,
  ) {
    if (typeof typeOrHandler === 'function') {
      this.allHandlers.push(typeOrHandler);
      return {
        dispose: () => {
          const i = this.allHandlers.indexOf(typeOrHandler);
          if (i >= 0) this.allHandlers.splice(i, 1);
        },
      };
    }
    void handler;
    return { dispose: () => {} };
  }
  emit(e: { type: string } & Record<string, unknown>): void {
    for (const h of [...this.allHandlers]) h(e);
  }
}

class FakeAgentHandle {
  readonly kind = 2;
  readonly bus = new FakeAgentBus();
  readonly accessor;
  constructor(readonly id: string) {
    const services = new Map<unknown, unknown>([[IEventBus, this.bus]]);
    this.accessor = { get: (token: unknown) => services.get(token) };
  }
}

class TestSessionStateService extends StateRegistry {
  declare readonly _serviceBrand: undefined;
}

/** A live session handle: one main agent + the services the broadcaster touches. */
class FakeSession {
  readonly main = new FakeAgentHandle('main');
  readonly agents: FakeAgentHandle[] = [];
  readonly interactions = new SessionInteractionService(new TestSessionStateService());
  readonly lifecycle = {
    list: () => this.agents,
    get: (id: string) => this.agents.find((h) => h.id === id),
    onDidCreate: () => ({ dispose: () => {} }),
    onDidDispose: () => ({ dispose: () => {} }),
  };
  readonly workView = {
    state: () => ({ busy: false, mainTurnActive: false, pendingInteraction: 'none' as const }),
    onDidChange: () => ({ dispose: () => {} }),
  };
  readonly handle;
  constructor(readonly sessionId: string) {
    this.agents.push(this.main);
    const accessor = {
      get: (token: unknown): unknown => {
        if (token === IAgentLifecycleService) return this.lifecycle;
        if (token === ISessionInteractionService) return this.interactions;
        if (token === ISessionActivityView) return this.workView;
        // A rostered main agent (mirrors persisted session metadata) so the
        // backfill seeds it and graded subscribers receive a baseline reset.
        if (token === ISessionMetadata) {
          return { read: async () => ({ agents: { main: { type: 'main' } } }) };
        }
        return undefined;
      },
    };
    this.handle = { id: sessionId, kind: 1, accessor, dispose: () => {} };
  }
}

class FakeEventBus {
  private handlers: Array<(e: { type: string; payload: unknown }) => void> = [];
  subscribe(handler: (e: { type: string; payload: unknown }) => void) {
    this.handlers.push(handler);
    return {
      dispose: () => {
        const i = this.handlers.indexOf(handler);
        if (i >= 0) this.handlers.splice(i, 1);
      },
    };
  }
  emit(e: { type: string; payload: unknown }): void {
    for (const h of [...this.handlers]) h(e);
  }
}

/**
 * The process-wide live lookup keyed by the full ref — mirrors the real
 * `SessionLifecycleService` M6 semantics (`getByRef` exact, bare `get` only
 * answers a unique match).
 */
function makeCore(live: Map<string, FakeSession>, eventBus = new FakeEventBus()): Scope {
  const bareMatch = (sessionId: string): FakeSession | undefined => {
    let match: FakeSession | undefined;
    for (const session of live.values()) {
      if (session.sessionId !== sessionId) continue;
      if (match !== undefined) return undefined;
      match = session;
    }
    return match;
  };
  const accessor = {
    get(token: unknown): unknown {
      if (token === IEventService) return eventBus;
      if (token === IRuntimeSessionHostService) {
        return {
          onDidCloseSession: () => ({ dispose: () => {} }),
          onDidArchiveSession: () => ({ dispose: () => {} }),
        };
      }
      if (token === ISessionLifecycleService) {
        return {
          get: (sessionId: string) => bareMatch(sessionId)?.handle,
          getByRef: (ref: SessionRef) => live.get(sessionRefKey(ref))?.handle,
        };
      }
      return undefined;
    },
  };
  return { accessor } as unknown as Scope;
}

/** A resolver over an explicit sid → ref table (the WS edge tests drive every kind). */
function makeResolver(table: Map<string, SessionRef[]>, unavailable: string[] = []): IV1SessionRefResolver {
  return {
    resolve: async (sessionId: string) => {
      const matches = table.get(sessionId) ?? [];
      if (matches.length === 1) {
        return {
          kind: 'resolved',
          resolution: {
            ref: matches[0]!,
            runtime: undefined as never,
            descriptor: undefined as never,
          },
        };
      }
      if (matches.length > 1) return { kind: 'ambiguous' };
      if (unavailable.includes(sessionId)) return { kind: 'unavailable' };
      return { kind: 'not_found' };
    },
    listAll: async () => [],
    coldRead: async () => undefined,
  };
}

function collectingTarget(): { target: BroadcastTarget; envelopes: EventEnvelope[] } {
  const envelopes: EventEnvelope[] = [];
  return { target: { send: (envelope) => envelopes.push(envelope) }, envelopes };
}

function durableOf(
  envelopes: readonly EventEnvelope[],
  type: string,
): EventEnvelope[] {
  return envelopes.filter((e) => e.type === type && e.volatile !== true);
}

/** Poll until the journal's write-behind flush has created the file. */
async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`timeout waiting for journal file ${path}`);
}

// ---------------------------------------------------------------------------
// Broadcaster isolation
// ---------------------------------------------------------------------------

describe('multi-runtime same-name isolation (M6)', () => {
  let dir: string;
  let live: Map<string, FakeSession>;
  let eventBus: FakeEventBus;
  let bc: SessionEventBroadcaster;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kimi-multi-runtime-test-'));
    live = new Map([
      [sessionRefKey(refA), new FakeSession(SHARED_ID)],
      [sessionRefKey(refB), new FakeSession(SHARED_ID)],
    ]);
    eventBus = new FakeEventBus();
    bc = new SessionEventBroadcaster({
      eventsDir: dir,
      core: makeCore(live, eventBus),
      resolver: makeResolver(new Map([[SHARED_ID, [refA, refB]]])),
    });
  });

  afterEach(async () => {
    await bc.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('fans agent events out strictly per SessionRef and journals independently', async () => {
    const a = collectingTarget();
    const b = collectingTarget();
    expect(await bc.subscribe(refA, a.target)).toBe(true);
    expect(await bc.subscribe(refB, b.target)).toBe(true);

    // A's main agent emits; B stays silent.
    live.get(sessionRefKey(refA))!.main.bus.emit({ type: 'turn.started', turnId: 1 });
    live.get(sessionRefKey(refA))!.main.bus.emit({ type: 'turn.ended', turnId: 1, reason: 'completed' });
    expect((await bc.getCursor(refA)).seq).toBe(2);
    expect((await bc.getCursor(refB)).seq).toBe(0);

    // A's frames carry the bare wire id (the v1 projection is unchanged)…
    expect(durableOf(a.envelopes, 'turn.started')).toHaveLength(1);
    expect(durableOf(a.envelopes, 'turn.ended')).toHaveLength(1);
    expect(a.envelopes.every((e) => e.session_id === SHARED_ID)).toBe(true);
    // …and NOTHING of A's stream reaches B's target.
    expect(b.envelopes).toHaveLength(0);

    // B's stream is independent: its seq starts at 1 on its own first event.
    live.get(sessionRefKey(refB))!.main.bus.emit({ type: 'turn.started', turnId: 1 });
    expect((await bc.getCursor(refB)).seq).toBe(1);
    expect(durableOf(b.envelopes, 'turn.started')).toHaveLength(1);
    // A saw nothing new beyond its own two events.
    expect(a.envelopes.filter((e) => e.volatile !== true)).toHaveLength(2);

    // The journals live in per-runtime files with independent seq/epoch.
    // (Appends are write-behind: poll until the flushed files appear.)
    const pathA = sessionJournalPath(dir, refA);
    const pathB = sessionJournalPath(dir, refB);
    expect(pathA).not.toBe(pathB);
    await waitForFile(pathA);
    await waitForFile(pathB);
    const cursorA = await bc.getCursor(refA);
    const cursorB = await bc.getCursor(refB);
    expect(cursorA.seq).toBe(2);
    expect(cursorB.seq).toBe(1);
    expect(cursorA.epoch).not.toBe(cursorB.epoch);

    // Cursor replays are per-ref too: B's replay from seq 0 yields exactly
    // its own single event.
    const replay = await bc.getBufferedSince(refB, { seq: 0 });
    expect(replay.resyncRequired).toBe(false);
    expect(replay.events).toHaveLength(1);
    expect(replay.events[0]!.envelope.type).toBe('turn.started');
  });

  it('keeps transcript stores, op seqs and watermarks apart per SessionRef', async () => {
    await bc.close(); // replace the default broadcaster with a transcript-owning one
    const core = makeCore(live, eventBus);
    const service = new TranscriptService({ core, resolver: makeResolver(new Map()) });
    bc = new SessionEventBroadcaster({
      eventsDir: dir,
      core,
      resolver: makeResolver(new Map()),
      transcriptService: service,
    });

    const a = collectingTarget();
    const b = collectingTarget();
    expect(await bc.subscribe(refA, a.target, undefined, { '*': 'block' })).toBe(true);
    expect(await bc.subscribe(refB, b.target, undefined, { '*': 'block' })).toBe(true);

    // Each side got its own baseline reset for its own store.
    const resetsA = a.envelopes.filter((e) => e.type === 'transcript.reset');
    const resetsB = b.envelopes.filter((e) => e.type === 'transcript.reset');
    expect(resetsA.length).toBeGreaterThan(0);
    expect(resetsB.length).toBeGreaterThan(0);
    expect(resetsA.every((e) => e.session_id === SHARED_ID)).toBe(true);

    // Live ops stream per ref: A's turn produces ops only on A's target, and
    // the per-agent seq counters advance independently.
    const seqABefore = service.getSeqWatermark(refA, 'main');
    const seqBBefore = service.getSeqWatermark(refB, 'main');
    live.get(sessionRefKey(refA))!.main.bus.emit({ type: 'turn.started', turnId: 1 });
    await service.whenReady(refA);
    const opsA = a.envelopes.filter((e) => e.type === 'transcript.ops');
    const opsBAfter = b.envelopes.filter((e) => e.type === 'transcript.ops');
    expect(opsA.length).toBeGreaterThan(0);
    expect(opsBAfter).toHaveLength(0);
    expect(service.getSeqWatermark(refA, 'main')).toBeGreaterThan(seqABefore);
    expect(service.getSeqWatermark(refB, 'main')).toBe(seqBBefore);

    // Catch-up journals are per ref as well.
    expect(service.getOpsSince(refA, 'main', seqABefore)?.batches.length).toBeGreaterThan(0);
    expect(service.getOpsSince(refB, 'main', 0)?.batches ?? []).toHaveLength(0);

    // Dropping one ref's store leaves the other's fully intact.
    service.dropSession(refA);
    expect(service.forSessionLive(refB)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// WS edge ambiguity mapping
// ---------------------------------------------------------------------------

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  private readonly handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  on(event: string, cb: (...a: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    return this;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  emit(event: string, ...a: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...a);
  }
  frames(): { type: string; id?: string; code?: number; msg?: string; payload?: unknown }[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

describe('WS edge bare-id resolution (M6, plan §6.4)', () => {
  let dir: string;
  let live: Map<string, FakeSession>;
  let bc: SessionEventBroadcaster;
  let subscribed: SessionRef[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kimi-ws-ambiguity-test-'));
    live = new Map([
      [sessionRefKey(refA), new FakeSession(SHARED_ID)],
      [sessionRefKey(refB), new FakeSession(SHARED_ID)],
    ]);
    subscribed = [];
  });

  afterEach(async () => {
    await bc.close();
    await rm(dir, { recursive: true, force: true });
  });

  function makeConn(resolver: IV1SessionRefResolver): { conn: WsConnectionV1; socket: FakeSocket } {
    const core = makeCore(live);
    bc = new SessionEventBroadcaster({ eventsDir: dir, core, resolver });
    const inner = bc.subscribe.bind(bc);
    bc.subscribe = async (ref, target, filter, grades, opts) => {
      subscribed.push(ref);
      return inner(ref, target, filter, grades, opts);
    };
    const socket = new FakeSocket();
    const conn = new WsConnectionV1({
      socket: socket as unknown as WebSocket,
      broadcaster: bc,
      connectionRegistry: new ConnectionRegistry(),
      resolver,
      remoteAddress: null,
      userAgent: null,
    });
    return { conn, socket };
  }

  async function subscribeFrame(socket: FakeSocket, sid: string): Promise<void> {
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'subscribe',
      id: 'req-1',
      payload: { session_ids: [sid] },
    })));
    // The control queue resolves + attaches asynchronously (real journal IO);
    // poll for the ack rather than racing it.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (socket.frames().some((f) => f.type === 'ack' && f.id === 'req-1')) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('timeout waiting for the subscribe ack');
  }

  it('answers an ambiguous bare id with the 50001 ack and subscribes NO candidate', async () => {
    const { socket } = makeConn(makeResolver(new Map([[SHARED_ID, [refA, refB]]])));
    await subscribeFrame(socket, SHARED_ID);

    const ack = socket.frames().find((f) => f.type === 'ack' && f.id === 'req-1');
    expect(ack).toBeDefined();
    expect(ack!.code).toBe(50001);
    expect(ack!.msg).toBe(`session ${SHARED_ID} is ambiguous across runtimes`);
    expect(subscribed).toEqual([]);
  });

  it('answers an unavailable bare id with the 50001 ack and subscribes NO candidate', async () => {
    const { socket } = makeConn(makeResolver(new Map(), ['ghost-session']));
    await subscribeFrame(socket, 'ghost-session');

    const ack = socket.frames().find((f) => f.type === 'ack' && f.id === 'req-1');
    expect(ack).toBeDefined();
    expect(ack!.code).toBe(50001);
    expect(ack!.msg).toBe('session ghost-session is temporarily unavailable');
    expect(subscribed).toEqual([]);
  });

  it('keeps the not_found ack channel for a truly unknown id', async () => {
    const { socket } = makeConn(makeResolver(new Map()));
    await subscribeFrame(socket, 'ghost-session');

    const ack = socket.frames().find((f) => f.type === 'ack' && f.id === 'req-1');
    expect(ack).toBeDefined();
    expect(ack!.code).toBe(0);
    expect((ack!.payload as { not_found: string[] }).not_found).toEqual(['ghost-session']);
    expect(subscribed).toEqual([]);
  });

  it('pins the resolved ref: a unique match subscribes exactly that session', async () => {
    const { socket } = makeConn(makeResolver(new Map([[SHARED_ID, [refA]]])));
    await subscribeFrame(socket, SHARED_ID);

    const ack = socket.frames().find((f) => f.type === 'ack' && f.id === 'req-1');
    expect(ack).toBeDefined();
    expect(ack!.code).toBe(0);
    expect((ack!.payload as { accepted: string[] }).accepted).toEqual([SHARED_ID]);
    expect(subscribed).toEqual([refA]);
  });
});
