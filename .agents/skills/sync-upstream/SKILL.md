---
name: sync-upstream
description: Sync this fork (BB-fat/kimi-code) with the official upstream (MoonshotAI/kimi-code) — merge origin/main into local main, resolve conflicts, run tests and build, push to fork main, and restart the kimi-web tmux service. Use whenever the user asks to 同步上游, sync/merge upstream, pull official updates into the fork, 更新 fork, or mentions that the upstream repo has new commits to bring in.
---

# Sync Upstream

This repository is a fork. Remote layout (already configured, do not re-add):

- `origin` → `https://github.com/MoonshotAI/kimi-code.git` — the official upstream
- `fork` → `https://github.com/BB-fat/kimi-code.git` — the user's fork, the push target

The integration branch is `main`: upstream updates land in local `main`, and `main` is what gets pushed to `fork`.

A tmux session named `kimi-web` (window 0) runs the dev web server `kimi-fork web --host` from this working copy. After a sync, that process still runs the OLD code, so it must be restarted as the final step.

The user invoking this skill is the standing authorization for the merge commit and the push to `fork main` — do not re-ask for those specific actions. DO stop and ask whenever reality deviates from the happy path described below.

## Step 0 — Check working state (before touching anything)

1. Run `git status --short` and `git branch --show-current`. The branch must be `main` and the tree must be clean. If there are uncommitted changes or a different branch is checked out, stop and ask the user what to do — do not stash, commit, or discard anything on your own.
2. Check for in-flight work: list background tasks (`TaskList`) and any running agents. If anything is still running, tell the user what is running and ask whether to continue. A sync changes the code under a running agent's feet; proceeding without consent can corrupt its work.

## Step 1 — Fetch and assess

```bash
git fetch origin
git log --oneline main..origin/main
```

- If the range is empty, the fork is already up to date — say so and skip to Step 4 only if the tmux service is actually stale (usually it is not; just stop).
- Otherwise show the user a short summary of incoming commits (count + notable subjects) so they know what is being merged.

## Step 2 — Merge

```bash
git merge origin/main --no-edit
```

Outcome handling:

- **Clean merge** → continue to Step 3.
- **Mechanical conflicts** — resolve on your own, they have known-correct answers:
  - `pnpm-lock.yaml`: take either side, then run `pnpm install` to regenerate the lockfile.
  - `CHANGELOG.md` / `.changeset/` / version bumps in `package.json`: regenerate or take upstream and re-apply the fork's unreleased entries on top.
- **Logic conflicts — STOP.** A logic conflict is one where upstream and the fork changed the same behavior in genuinely different ways (different algorithms, divergent feature implementations, conflicting semantics) — i.e. picking a side or blending them requires a product/design decision, not just text splicing. When you hit one:
  1. Do NOT commit. Leave the merge in progress (or `git merge --abort` if the user prefers to defer).
  2. Present each conflicted hunk to the user: file, what upstream does, what the fork does, and how the two intents differ.
  3. Let the user decide per conflict. Only after their decision do you apply it and continue.

When in doubt about whether a conflict is mechanical or logical, treat it as logical and ask.

## Step 3 — Verify before committing

If `pnpm-lock.yaml` changed in the merge, run `pnpm install` first.

Then run, in order:

```bash
pnpm test
pnpm build
```

- Both must pass. `pnpm test` is `vitest run` at the repo root; `pnpm build` is `pnpm -r run build`.
- If something fails: diagnose whether it is a merge artifact (fix it), an upstream regression (report it to the user with evidence — do not silently patch upstream behavior), or a pre-existing failure on the fork (verify by checking whether it fails on the pre-merge commit; if pre-existing, report and continue only with the user's consent).
- Only commit the merge (if not auto-committed) after both are green.

## Step 4 — Push

```bash
git push fork main
```

Report the pushed range (`git log --oneline <old>..fork/main`).

## Step 5 — Restart the kimi-web service (detached — do not Ctrl-C inline)

The dev server in tmux is still running the old code and must be restarted.
**Never restart it synchronously from the agent.** The Web UI agent session is
hosted by that same `kimi-fork web` process: a live `tmux send-keys … C-c`
kills the host mid-turn, so the follow-up start never runs and the agent dies
with the work unfinished.

Always hand the restart to the detached helper next to this skill. It
`sleep`s briefly (so the agent can finish its final message), then stops and
starts the server. It does **not** write a result file — the source of truth
is the tmux pane banner.

```bash
SKILL_DIR=".agents/skills/sync-upstream"   # repo-relative; use absolute if cwd differs
setsid bash "$SKILL_DIR/restart-kimi-web.sh" </dev/null >/dev/null 2>&1 &
echo "restart pid=$!"
```

Then:

1. **Immediately tell the user** that restart is scheduled out-of-process:
   - If they are on the Web UI, this session will disconnect in a few seconds —
     that is expected. Re-open after ~10s from the new URL shown in the
     `kimi-web` tmux pane (`tmux capture-pane -t kimi-web:0 -p | tail -20`).
2. **If this agent is still alive** (CLI / TUI path, not hosted by the web
   server), poll the pane for up to ~50s:
   `tmux capture-pane -t kimi-web:0 -p | tail -30`.
   On `Kimi server ready`, report the new `Local:` / `Network:` URLs and token.
   If the banner never appears, capture more of the pane and diagnose.
3. **If this agent is about to die with the web server**, do not wait — the
   helper continues independently. End the turn after the user-facing notice
   in (1); do not issue further tool calls that depend on the server.

Notes:

- Token is regenerated on every start — old bookmarks stop working.
- Helper knobs (optional env): `KIMI_WEB_TMUX_TARGET` (default `kimi-web:0`),
  `KIMI_WEB_START_CMD` (default `kimi-fork web --host`),
  `KIMI_WEB_RESTART_DELAY` (default `3`), `KIMI_WEB_READY_TIMEOUT` (default `45`).
- Do **not** fall back to inline `tmux send-keys C-c` even when you believe the
  agent is CLI-hosted — always use the detached path so one recipe covers both.

## Aborting

If the user decides to abandon mid-merge: `git merge --abort` restores the pre-merge state. Anything already pushed cannot be undone quietly — flag it explicitly instead of force-pushing.
