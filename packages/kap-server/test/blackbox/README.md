# kap-server black-box old/new comparison

A re-runnable black-box harness for the multi-Session-Host runtime refactor
(plan §9.8): the SAME scenario drives both the pre-branch baseline and the
current tree, and every observable wire surface — REST envelopes, WebSocket
frames, session export zip — is recorded, normalized, and deep-compared. Any
remaining difference is a wire-behavior difference between the two trees, not
a harness artifact.

## How to run

```sh
pnpm --filter @moonshot-ai/kap-server blackbox:compare
```

Exit codes: `0` = `BLACKBOX MATCH` (possibly with registered known
differences), `1` = records differ beyond the registered set (diff printed
and written to disk), `2` = infrastructure failure (server did not boot,
scenario step hard-failed, ...).

## Registered known differences

`compare.mts` carries a `KNOWN_DIFFERENCES` list: wire differences between the
baseline and the current tree that were triaged and ratified, each keyed by
scenario step + field suffix and carrying the milestone that introduced it
plus its justification. A matching diff is printed as `BLACKBOX KNOWN-DIFF`
and does not fail the run; any unregistered diff does. Current entry:

- `err_prompt_unknown_session` → `.response.body.stack` — M5c (pre-M6)
  dropped the ad-hoc `stack` field from the prompts route's resolver-mapped
  40401 envelope; the field leaks absolute server paths and is inherently
  unfreezable, so the drop is ratified as an intentional fix.

An entry whose diff stops appearing is stale — remove it (restored parity is
good news, not a failure). Never add an entry to silence an un-triaged diff.


## Layout

- `run-server.mts` — child-process shim. Reads `BB_TREE` / `BB_HOME` / `BB_CWD`
  from the environment, dynamically imports `packages/kap-server/src/start.ts`
  FROM THE TARGET TREE (old worktree or current), boots with
  `{ host: 127.0.0.1, port: 0, logLevel: 'silent', version: 'blackbox' }`,
  prints one `BB_READY {"port":N,"token":"..."}` line, shuts down on
  SIGTERM/SIGINT. Must never import anything from the hosting repo.
- `scenario.mts` — the scenario driver (imported by `compare.mts`, runs in the
  current tree only). Produces the raw record:
  `{ steps: [{ name, request, response }], wsFrames: [{ connection, frames }], export: { status, headers, entries } }`.
- `normalize.mts` — normalization + stable stringify, applied identically to
  both records at compare time.
- `compare.mts` — orchestrator: prepares the old tree, starts the fake
  provider, boots both servers, runs the scenario twice, normalizes, diffs.

## What it does

1. Baseline tree: `.tmp/blackbox/old-tree` is a `git worktree add` of commit
   `f79fde2b9` (first run only) plus `pnpm install --frozen-lockfile` (skipped
   when `node_modules` exists — the harness is fully re-runnable).
2. A fake OpenAI provider (`node:http`, ephemeral port) answers every
   `POST /v1/chat/completions` with a fixed SSE stream (`BLACKBOX` + `-REPLY`
   content chunks, `finish_reason: stop`, usage 11/2/13). Everything else 404s.
3. Per tree: fresh `mkdtemp` homeDir with a stub-provider `config.toml`
   (`max_context_size = 100000` to stay clear of compaction), server boot,
   then the scenario: meta → create session A (shared workspace dir
   `.tmp/blackbox/workdir`) → session lists/gets → WS conn 1
   (client_hello + subscribe_v2 block grade; `transcript.reset` arrives when
   the lazily-spawned `main` agent materializes on the first prompt) → prompt
   turn until the prompt flips to `completed` on the transcript channel →
   transcript / transcript ops / snapshot →
   profile rename (`session.meta.updated`) → fork to session B
   (`event.session.created`) → export zip → archive / list-archived / restore
   → WS conn 2 (cursor replay from conn1's ack cursor − 1, then a far-future
   subscribe expecting `resync_required`) → error envelopes (40401 / 40410)
   → live `/connections`.

## Artifacts

All under `.tmp/blackbox/` (gitignored):

- `out/old.record.json`, `out/new.record.json` — raw records.
- `out/old.normalized.json`, `out/new.normalized.json` — post-normalization,
  stably stringified; diff these manually for full context.
- `out/diff.report.txt` — the structural diff (on mismatch only).
- `out/old.server.log`, `out/new.server.log` — child process output.
- `old-tree/`, `workdir/` — kept between runs on purpose; delete
  `.tmp/blackbox` entirely for a cold start.

## Normalization rules

Key-based (any depth): timestamp-ish keys (`created_at`, `updated_at`,
`resolved_at`, `dismissed_at`, `started_at`, `ended_at`, `timestamp`,
`createdAt`, `updatedAt`, `startedAt`, `endedAt`, `lastOpenedAt`,
`connectedAt`, `connected_at`, `request_id`, transcript marker `at`, prompt
`finishedAt` / `steeredAt`) → `"<TS>"`; numeric epoch-ms keys (`time`,
`since`) and numeric keys ending in `Ms` / `_ms` (turn `durationMs`, LLM
`timing.*Ms` latencies) → `"<MS>"`; export `content-length` → `"<LEN>"` (raw
zip bytes embed real timestamps, so the compressed length jitters);
`systemPromptHash` → `"<SHA>"` (content-addressed over a prompt that embeds
per-run literals, never itself transmitted).

Value-pattern (inside strings, and in object KEYS — cursor maps are keyed by
session id): ISO-8601 timestamps → `<TS>`; the run's homeDir (and its
realpath) → `<HOME>`; `session_<uuid>` → `<SID:n>`, `msg_<ulid|uuid>` →
`<MSG:n>`, bare ULIDs → `<ULID:n>`, bare uuids (step ids, `uuid`/`stepUuid`)
→ `<UUID:n>` (all first-appearance order, so session A/B map to
`<SID:1>`/`<SID:2>` in both records); `conn_*` → `<CONN>`; `ep_*` →
`<EPOCH>`; `127.0.0.1:<port>` → `127.0.0.1:<PORT>`; `::ffff:127.0.0.1` →
`127.0.0.1`; free-text `ttftMs=12`-style log key=value pairs → `key=<MS>`.
The export zip's text entries (`.json/.jsonl/.md/.txt/.log`) get the same
treatment per entry — JSON structurally, JSONL line-by-line, other text by
plain patterns; binary entries compare by name only, and entry mtimes are
ignored.

Deliberately NOT normalized (must match verbatim): `seq` / cursor values,
`protocol_version`, token counts, envelope `code` / `msg`, event type names,
turn ordinals, and the ORDER of recorded WS frames.

## Determinism / self-checks

Both trees are deterministic under this harness: `BB_TREES=new,new` and
`BB_TREES=old,old` (env override for the two tree slots; absolute paths also
accepted) both print `BLACKBOX MATCH`. Run a self-check first when a fresh
diff looks like an ordering race — if same-tree runs agree but old≠new, the
difference is a deterministic wire-behavior change between the trees.

## Known limitations

- `transcript.ops` batch segmentation is timing-sensitive in principle; the
  fake provider answers fast and deterministically, which so far produces
  identical batching on both trees. A segmentation-only diff is a scenario
  artifact (class b), not a wire regression — coalesce or settle further if
  one shows up.
- The scenario covers one straight-line turn (no tools, approvals,
  compaction, cancellation, or multi-agent traffic).
- Live-only transcript fields (usage/timing on steps, task result summaries)
  are present (the session is live in both runs) but the cold-rebuild path is
  not exercised.
- The provider's fixed usage numbers flow into usage projections verbatim;
  if a future kosong change alters that projection, the resulting diff is a
  REAL finding — do not "fix" it by editing the fixture numbers.
- The prompt body binds `model: 'stub'` explicitly (the server bakes in no
  default model; production clients bind the same way via `body.model`).
