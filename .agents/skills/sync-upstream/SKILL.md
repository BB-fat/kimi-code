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

## Step 5 — Restart the kimi-web service

The dev server in tmux is still running the old code. Restart it:

```bash
tmux send-keys -t kimi-web:0 C-c
sleep 2
tmux send-keys -t kimi-web:0 'kimi-fork web --host' Enter
```

Wait a few seconds, then verify with `tmux capture-pane -t kimi-web:0 -p | tail -20`:

- Expect the `Kimi server ready` banner with fresh `Local:` / `Network:` URLs.
- The access token is regenerated on each start — report the new URL (including token) to the user, since old bookmarks stop working.
- If the banner does not appear, capture more of the pane, diagnose the startup error, and fix or report.

## Aborting

If the user decides to abandon mid-merge: `git merge --abort` restores the pre-merge state. Anything already pushed cannot be undone quietly — flag it explicitly instead of force-pushing.
