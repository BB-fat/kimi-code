/**
 * Record normalization for the black-box comparison.
 *
 * Both scenario records (old tree + current tree) pass through the SAME
 * normalizer before the deep compare, each with its own context (per-run
 * homeDir literals, per-record id maps). Two families of rules:
 *
 *   - key-based: object keys that always carry nondeterministic values
 *     (timestamps, request ids, millisecond timings, zip byte length);
 *   - value-pattern: regex replacements inside strings (ISO timestamps,
 *     session / message / connection / epoch / ULID ids, host:port, home
 *     directory literals).
 *
 * Id replacements that need cross-occurrence stability (`session_<uuid>`,
 * `msg_<uuid>`, ULIDs) map to `<KIND:n>` tokens in first-appearance order, so
 * the two records refer to `<SID:1>` / `<SID:2>` for the same logical session
 * as long as the scenario creates them in the same order.
 *
 * Deliberately NOT normalized (must match verbatim): `seq`, cursor values,
 * `protocol_version`, token counts, envelope `code` / `msg`, event type
 * names, turn ordinals.
 */

export interface NormalizeContext {
  /** Literal path strings replaced with `<HOME>` (longest first). */
  readonly homeLiterals: readonly string[];
  readonly sidMap: Map<string, string>;
  readonly msgMap: Map<string, string>;
  readonly ulidMap: Map<string, string>;
  readonly uuidMap: Map<string, string>;
}

export function createNormalizeContext(homeLiterals: readonly string[]): NormalizeContext {
  return {
    homeLiterals: [...homeLiterals].toSorted((a, b) => b.length - a.length),
    sidMap: new Map(),
    msgMap: new Map(),
    ulidMap: new Map(),
    uuidMap: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Key-based rules.
// ---------------------------------------------------------------------------

const TIMESTAMP_KEYS: ReadonlySet<string> = new Set([
  'created_at',
  'updated_at',
  'resolved_at',
  'dismissed_at',
  'started_at',
  'ended_at',
  'timestamp',
  'createdAt',
  'updatedAt',
  'startedAt',
  'endedAt',
  'lastOpenedAt',
  'connectedAt',
  'connected_at',
  'request_id',
  // Transcript markers / taskrefs carry a bare `at` ISO timestamp.
  'at',
  // Prompt entity lifecycle timestamps.
  'finishedAt',
  'steeredAt',
]);

function normalizeKeyed(key: string, value: unknown): unknown {
  if (TIMESTAMP_KEYS.has(key)) return '<TS>';
  if (key === 'content-length') return '<LEN>';
  // The system-prompt hash is content-addressed over a prompt that embeds
  // per-run literals (homeDir, timestamps) and is never itself transmitted —
  // unfit for cross-run comparison.
  if (key === 'systemPromptHash') return '<SHA>';
  // Millisecond timings: durationMs, llmFirstTokenLatencyMs, llmStreamDurationMs,
  // llmRequestBuildMs, ... — wall-clock, never comparable across runs. The
  // agent-phase `since` and wire-record `time` are epoch-ms as well.
  if (
    typeof value === 'number' &&
    (key.endsWith('Ms') || key.endsWith('_ms') || key === 'since' || key === 'time')
  ) {
    return '<MS>';
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Value-pattern rules.
// ---------------------------------------------------------------------------

const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g;
const SESSION_ID = /session_[0-9a-fA-F-]{36}/g;
// Message / prompt ids: `msg_<ulid>` (current) or `msg_<uuid>` (legacy).
const MESSAGE_ID = /msg_(?:[0-9A-HJKMNP-TV-Z]{26}|[0-9a-fA-F-]{36})/g;
const CONN_ID = /conn_[0-9A-Za-z_-]+/g;
const EPOCH_ID = /ep_[0-9A-Za-z_-]+/g;
const ULID = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g;
// Bare uuids (step ids, `uuid` / `stepUuid` fields in wire records). Applied
// AFTER the prefixed id patterns so `session_<uuid>` / `msg_<uuid>` are
// consumed by their own maps first.
const BARE_UUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
// Free-text log lines carry `ttftMs=12`-style millisecond key=value pairs.
const MS_KV = /(\b\w*Ms)=\d+/g;
const LOOPBACK_PORT = /127\.0\.0\.1:\d+/g;
const V4_MAPPED_V6 = /::ffff:127\.0\.0\.1/g;

function mapped(map: Map<string, string>, prefix: string, id: string): string {
  let token = map.get(id);
  if (token === undefined) {
    token = `<${prefix}:${map.size + 1}>`;
    map.set(id, token);
  }
  return token;
}

export function normalizeString(input: string, ctx: NormalizeContext): string {
  let out = input;
  for (const literal of ctx.homeLiterals) {
    if (literal.length > 0 && out.includes(literal)) {
      out = out.split(literal).join('<HOME>');
    }
  }
  return out
    .replace(V4_MAPPED_V6, '127.0.0.1')
    .replace(LOOPBACK_PORT, '127.0.0.1:<PORT>')
    .replace(ISO_TIMESTAMP, '<TS>')
    .replace(SESSION_ID, (id) => mapped(ctx.sidMap, 'SID', id))
    .replace(MESSAGE_ID, (id) => mapped(ctx.msgMap, 'MSG', id))
    .replace(CONN_ID, '<CONN>')
    .replace(EPOCH_ID, '<EPOCH>')
    .replace(BARE_UUID, (id) => mapped(ctx.uuidMap, 'UUID', id))
    .replace(ULID, (id) => mapped(ctx.ulidMap, 'ULID', id))
    .replace(MS_KV, '$1=<MS>');
}

// ---------------------------------------------------------------------------
// Recursive structural normalization.
// ---------------------------------------------------------------------------

export function normalizeValue(value: unknown, ctx: NormalizeContext, key?: string): unknown {
  if (key !== undefined) {
    const keyed = normalizeKeyed(key, value);
    if (keyed !== undefined) return keyed;
  }
  if (typeof value === 'string') return normalizeString(value, ctx);
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item, ctx));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Object KEYS are normalized too — cursor maps and the like are keyed
      // by session ids (`cursors: { session_<uuid>: { seq, epoch } }`).
      out[normalizeString(k, ctx)] = normalizeValue(v, ctx, k);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Export zip text-entry normalization: JSON documents are normalized
// structurally, JSONL line-by-line, anything else by plain value patterns.
// ---------------------------------------------------------------------------

function tryParseJson(text: string): { ok: boolean; value?: unknown } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

export function normalizeExportContent(content: string, ctx: NormalizeContext): string {
  const whole = tryParseJson(content);
  if (whole.ok) {
    return stableStringify(normalizeValue(whole.value, ctx));
  }
  const lines = content.split('\n');
  const parsed = lines.map((line) => (line.trim() === '' ? { ok: true, value: '' } : tryParseJson(line)));
  if (parsed.every((p) => p.ok)) {
    return lines
      .map((line, i) => {
        if (line.trim() === '') return '';
        const p = parsed[i]!;
        return stableStringify(normalizeValue(p.value, ctx));
      })
      .join('\n');
  }
  return normalizeString(content, ctx);
}

// ---------------------------------------------------------------------------
// Stable stringify (sorted object keys) — canonical text for diffing.
// ---------------------------------------------------------------------------

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).toSorted()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value), null, 2);
}
