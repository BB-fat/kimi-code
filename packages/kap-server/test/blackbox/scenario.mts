/**
 * Black-box scenario driver.
 *
 * Imported by `compare.mts` (never run standalone). Drives one kap-server
 * instance — old-tree or current-tree — through a fixed sequence of REST + WS
 * interactions against a deterministic fake provider and returns everything
 * observable on the wire as a structured record. The SAME code runs against
 * both trees, so any old-vs-new difference in the records is a wire-surface
 * difference, not a test-harness artifact.
 *
 * Records are RAW: normalization (timestamps, ids, ports, paths) happens in
 * `compare.mts` / `normalize.mts` at diff time, not here.
 */

import { inflateRawSync } from 'node:zlib';

import { WebSocket } from 'ws';

// ---------------------------------------------------------------------------
// Record shapes.
// ---------------------------------------------------------------------------

export interface ScenarioOptions {
  readonly baseUrl: string;
  readonly token: string;
  /** Process cwd the server child was spawned with (recorded for context). */
  readonly cwd: string;
  /** Shared workspace directory used as the session's cwd. */
  readonly workDir: string;
}

export interface RecordedStep {
  readonly name: string;
  readonly request: { method: string; path: string; body?: unknown };
  readonly response: { status: number; body: unknown };
}

export interface RecordedWsConnection {
  readonly connection: string;
  readonly frames: unknown[];
}

export interface RecordedExportEntry {
  readonly name: string;
  readonly kind: 'text' | 'binary';
  readonly content?: string;
}

export interface RecordedExport {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly entries: RecordedExportEntry[];
}

export interface ScenarioRecord {
  readonly steps: RecordedStep[];
  readonly wsFrames: RecordedWsConnection[];
  readonly export: RecordedExport;
}

interface Frame {
  type?: string;
  id?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// WebSocket client — records every inbound frame in arrival order; sequential
// `waitFor` scans (cursor-based, non-destructive) drive the scenario; `quiet`
// settles async fan-out frames deterministically before a phase ends.
// ---------------------------------------------------------------------------

class WsConn {
  readonly frames: Frame[] = [];
  private readonly ws: WebSocket;
  private waiter: {
    pred: (f: Frame) => boolean;
    resolve: (f: Frame) => void;
    timer: NodeJS.Timeout;
  } | null = null;
  private cursor = 0;
  private lastFrameAt = Date.now();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data: Buffer) => {
      let frame: Frame;
      try {
        frame = JSON.parse(data.toString()) as Frame;
      } catch {
        return;
      }
      this.frames.push(frame);
      this.lastFrameAt = Date.now();
      const w = this.waiter;
      if (w !== null && w.pred(frame)) {
        this.waiter = null;
        clearTimeout(w.timer);
        this.cursor = this.frames.length;
        w.resolve(frame);
      }
    });
  }

  static open(url: string, token: string): Promise<WsConn> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, [`kimi-code.bearer.${token}`]);
      const conn = new WsConn(ws);
      ws.once('open', () => {
        resolve(conn);
      });
      ws.once('error', reject);
    });
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  /** Resolve when no new frame has arrived for `ms`. */
  quiet(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        const since = Date.now() - this.lastFrameAt;
        if (since >= ms) {
          resolve();
          return;
        }
        setTimeout(check, ms - since);
      };
      check();
    });
  }

  waitFor(pred: (f: Frame) => boolean, timeoutMs: number, label: string): Promise<Frame> {
    for (let i = this.cursor; i < this.frames.length; i++) {
      const frame = this.frames[i]!;
      if (pred(frame)) {
        this.cursor = i + 1;
        return Promise.resolve(frame);
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        const seen = this.frames
          .map((f) => JSON.stringify(f).slice(0, 400))
          .join('\n  ');
        reject(new Error(`timeout waiting for ${label}; frames so far:\n  ${seen}`));
      }, timeoutMs);
      this.waiter = { pred, resolve, timer };
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      this.ws.once('close', () => {
        resolve();
      });
      this.ws.close();
      // Never hang the run on a stuck close handshake.
      setTimeout(resolve, 3000);
    });
  }
}

// ---------------------------------------------------------------------------
// Minimal zip reader (central-directory walk + raw inflate). yazl-produced
// archives carry real sizes in the central directory, which is all we need;
// entry mtimes are ignored by the caller.
// ---------------------------------------------------------------------------

interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

function readZip(buf: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('export payload is not a zip (no EOCD)');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`bad central directory entry ${n}`);
    }
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`bad local header for ${name}`);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataOffset, dataOffset + compressedSize);
    let data: Buffer;
    if (method === 0) {
      data = raw;
    } else if (method === 8) {
      data = inflateRawSync(raw);
    } else {
      throw new Error(`unsupported zip compression method ${method} for ${name}`);
    }
    entries.push({ name, data });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const TEXT_ENTRY = /\.(json|jsonl|md|txt|log)$/;

/** Deep-scan a `transcript.ops` frame for a `prompt.upsert` reaching `completed`. */
function promptCompletedIn(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(promptCompletedIn);
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (record['op'] === 'prompt.upsert') {
      const prompt = record['prompt'];
      if (
        typeof prompt === 'object' &&
        prompt !== null &&
        (prompt as Record<string, unknown>)['status'] === 'completed'
      ) {
        return true;
      }
    }
    return Object.values(record).some(promptCompletedIn);
  }
  return false;
}

// ---------------------------------------------------------------------------
// REST helper.
// ---------------------------------------------------------------------------

interface ApiResult {
  readonly status: number;
  readonly body: unknown;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`expected object for ${what}`);
  }
  return value as Record<string, unknown>;
}

function envelopeData(body: unknown, step: string): Record<string, unknown> {
  const envelope = asRecord(body, `${step} envelope`);
  if (envelope['code'] !== 0) {
    throw new Error(
      `step ${step} failed: code=${String(envelope['code'])} msg=${String(envelope['msg'])}`,
    );
  }
  return asRecord(envelope['data'], `${step} data`);
}

/** Hard-fail the run when a WS control frame is rejected — a rejected
 * handshake would make every later wait meaningless. */
function requireAckOk(frame: Frame, label: string): void {
  if (frame['code'] !== 0) {
    throw new Error(`${label} rejected by server: ${JSON.stringify(frame)}`);
  }
}

// ---------------------------------------------------------------------------
// The scenario.
// ---------------------------------------------------------------------------

export async function runScenario(opts: ScenarioOptions): Promise<ScenarioRecord> {
  const { baseUrl, token } = opts;
  const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/api/v1/ws`;
  const steps: RecordedStep[] = [];
  const wsFrames: RecordedWsConnection[] = [];
  let exportRecord: RecordedExport | null = null;

  const api = async (method: string, path: string, body?: unknown): Promise<ApiResult> => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  };

  const step = async (
    name: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ApiResult> => {
    const result = await api(method, path, body);
    steps.push({
      name,
      request: body === undefined ? { method, path } : { method, path, body },
      response: result,
    });
    return result;
  };

  // 1. Server metadata.
  await step('meta', 'GET', '/api/v1/meta');

  // 2. Create session A in the shared fixture workspace.
  const created = await step('create_session', 'POST', '/api/v1/sessions', {
    metadata: { cwd: opts.workDir },
  });
  const sessionA = envelopeData(created.body, 'create_session');
  const sidA = sessionA['id'] as string;
  const workspaceId = sessionA['workspace_id'] as string;

  // 3. Session listing / lookup shapes.
  await step('list_sessions', 'GET', '/api/v1/sessions');
  await step('list_sessions_by_workspace', 'GET', `/api/v1/sessions?workspace_id=${workspaceId}`);
  await step('get_session', 'GET', `/api/v1/sessions/${sidA}`);

  // 4. WS connection 1: handshake, legacy subscription, transcript grade.
  // The empty transcript store exists from session creation, so the
  // `transcript.reset` baseline lands right after the subscribe_v2 ack; the
  // turn's ops stream later when the prompt runs.
  const conn1 = await WsConn.open(wsUrl, token);
  wsFrames.push({ connection: 'conn1', frames: conn1.frames });
  await conn1.waitFor((f) => f.type === 'server_hello', 5000, 'server_hello (conn1)');
  conn1.send({
    type: 'client_hello',
    id: 'ch1',
    payload: { client_id: 'blackbox', subscriptions: [sidA] },
  });
  const ack1 = await conn1.waitFor((f) => f.type === 'ack' && f.id === 'ch1', 5000, 'ack ch1');
  requireAckOk(ack1, 'client_hello (conn1)');
  conn1.send({
    type: 'subscribe_v2',
    id: 'sv1',
    payload: { session_id: sidA, transcript: { '*': 'block' } },
  });
  const ackSv1 = await conn1.waitFor((f) => f.type === 'ack' && f.id === 'sv1', 5000, 'ack sv1');
  requireAckOk(ackSv1, 'subscribe_v2 (conn1)');
  await conn1.quiet(400);

  // 5. Prompt turn: submit, then collect frames until completion. The prompt
  // body carries `model: 'stub'` — the server intentionally bakes in no
  // default model (see transport/mainAgent.ts), so the edge binds one on the
  // first prompt, exactly like the production clients do. With a block-grade
  // transcript subscription the `prompt.completed` session event is suppressed
  // (it is transcript-projected) on BOTH trees, so completion is detected on
  // the transcript channel itself: a `transcript.ops` batch whose
  // `prompt.upsert` op flips the prompt status to `completed`.
  await step('prompt', 'POST', `/api/v1/sessions/${sidA}/prompts`, {
    content: [{ type: 'text', text: 'Say BLACKBOX' }],
    model: 'stub',
  });
  await conn1.waitFor(
    (f) => f.type === 'prompt.completed' || (f.type === 'transcript.ops' && promptCompletedIn(f)),
    30_000,
    'prompt completion (prompt.completed | transcript.ops prompt.upsert completed)',
  );
  await conn1.quiet(600);

  // 6. Read surfaces after the turn.
  await step('transcript', 'GET', `/api/v1/sessions/${sidA}/transcript?agent_id=main`);
  await step('transcript_ops', 'GET', `/api/v1/sessions/${sidA}/transcript/ops?agent_id=main&since_seq=0`);
  await step('snapshot', 'GET', `/api/v1/sessions/${sidA}/snapshot`);

  // 7. Profile rename → meta broadcast.
  await step('profile', 'POST', `/api/v1/sessions/${sidA}/profile`, { title: 'BB Title' });
  await conn1.waitFor((f) => f.type === 'session.meta.updated', 5000, 'session.meta.updated');
  await conn1.quiet(400);

  // 8. Fork → session B + creation broadcast.
  const forked = await step('fork', 'POST', `/api/v1/sessions/${sidA}:fork`, {});
  const sidB = envelopeData(forked.body, 'fork')['id'] as string;
  await conn1.waitFor((f) => f.type === 'event.session.created', 5000, 'event.session.created');
  await conn1.quiet(400);
  await step('get_forked_session', 'GET', `/api/v1/sessions/${sidB}`);

  // 9. Export session A as a zip; record headers + entry list + text content.
  {
    const res = await fetch(`${baseUrl}/api/v1/sessions/${sidA}/export`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const headers: Record<string, string> = {};
    for (const name of ['content-type', 'content-disposition', 'content-length', 'cache-control']) {
      const value = res.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    const entries: RecordedExportEntry[] = readZip(buf)
      .map((entry): RecordedExportEntry => {
        if (TEXT_ENTRY.test(entry.name)) {
          return { name: entry.name, kind: 'text', content: entry.data.toString('utf8') };
        }
        return { name: entry.name, kind: 'binary' };
      })
      .toSorted((a, b) => a.name.localeCompare(b.name));
    exportRecord = { status: res.status, headers, entries };
  }

  // 10. Archive / list / restore.
  await step('archive', 'POST', `/api/v1/sessions/${sidA}:archive`, {});
  await step('list_archived', 'GET', '/api/v1/sessions?archived_only=true');
  await step('restore', 'POST', `/api/v1/sessions/${sidA}:restore`, {});
  await conn1.quiet(500);

  // 11. WS connection 2: cursor replay, then an out-of-journal subscribe.
  const ack1Payload = asRecord(ack1['payload'], 'ack ch1 payload');
  const ack1Cursors = asRecord(ack1Payload['cursors'] ?? {}, 'ack ch1 cursors');
  const cursorA = asRecord(ack1Cursors[sidA] ?? {}, 'ack ch1 cursor for A');
  const conn2 = await WsConn.open(wsUrl, token);
  wsFrames.push({ connection: 'conn2', frames: conn2.frames });
  await conn2.waitFor((f) => f.type === 'server_hello', 5000, 'server_hello (conn2)');
  conn2.send({
    type: 'client_hello',
    id: 'ch2',
    payload: {
      client_id: 'blackbox',
      subscriptions: [sidA],
      cursors: {
        [sidA]: {
          seq: ((cursorA['seq'] as number | undefined) ?? 0) - 1,
          epoch: cursorA['epoch'] as string | undefined,
        },
      },
    },
  });
  const ack2 = await conn2.waitFor((f) => f.type === 'ack' && f.id === 'ch2', 5000, 'ack ch2');
  requireAckOk(ack2, 'client_hello (conn2)');
  await conn2.quiet(600);
  conn2.send({
    type: 'subscribe',
    id: 'sub2',
    payload: { session_ids: [sidA], cursors: { [sidA]: { seq: 999999 } } },
  });
  await conn2.waitFor((f) => f.type === 'resync_required', 5000, 'resync_required (conn2)');
  await conn2.quiet(400);

  // 12. Error-envelope mapping.
  await step(
    'err_transcript_unknown_session',
    'GET',
    '/api/v1/sessions/session_00000000-0000-0000-0000-000000000000/transcript?agent_id=main',
  );
  await step('err_prompt_unknown_session', 'POST', '/api/v1/sessions/session_00000000-0000-0000-0000-000000000001/prompts', {
    content: [{ type: 'text', text: 'nope' }],
  });
  await step('err_unknown_workspace', 'GET', '/api/v1/sessions?workspace_id=nonexistent-ws');

  // 13. Live connection registry while conn2 is still attached.
  await step('connections', 'GET', '/api/v1/connections');

  await conn1.close();
  await conn2.close();

  if (exportRecord === null) {
    throw new Error('export step did not run');
  }
  return { steps, wsFrames, export: exportRecord };
}
