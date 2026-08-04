#!/usr/bin/env bash
# Detached restart for the kimi-web tmux service.
#
# Why this exists: the Web UI agent session is hosted by `kimi-fork web --host`
# inside tmux session `kimi-web`. A synchronous Ctrl+C from that agent kills
# the host process mid-turn, so the restart never runs. This script is meant
# to be launched with `setsid` so it outlives the dying server/agent.
#
# Usage (from the skill, always via setsid + background):
#   setsid bash /path/to/restart-kimi-web.sh </dev/null >/dev/null 2>&1 &
#
# Does not write any result file. Success is visible in the tmux pane
# (`Kimi server ready` banner). Progress goes to stderr for optional capture.

set -u

TMUX_TARGET="${KIMI_WEB_TMUX_TARGET:-kimi-web:0}"
START_CMD="${KIMI_WEB_START_CMD:-kimi-fork web --host}"
DELAY_SECS="${KIMI_WEB_RESTART_DELAY:-3}"
READY_TIMEOUT="${KIMI_WEB_READY_TIMEOUT:-45}"
STOP_WAIT="${KIMI_WEB_STOP_WAIT:-2}"

timestamp() { date -Iseconds; }

echo "[$(timestamp)] restart-kimi-web: delay ${DELAY_SECS}s, target=${TMUX_TARGET}" >&2

# Give the agent a moment to finish its final user-facing message before we
# tear down the server that may be hosting it.
sleep "$DELAY_SECS"

if ! tmux has-session -t "${TMUX_TARGET%%:*}" 2>/dev/null; then
  echo "[$(timestamp)] RESTART FAILED: tmux session '${TMUX_TARGET%%:*}' does not exist" >&2
  exit 1
fi

echo "[$(timestamp)] sending Ctrl-C to ${TMUX_TARGET}" >&2
tmux send-keys -t "$TMUX_TARGET" C-c
sleep "$STOP_WAIT"

# If the pane is still busy (server ignored SIGINT), send a second Ctrl-C.
# Do not escalate to kill — the skill owns a shared dev pane.
if tmux list-panes -t "$TMUX_TARGET" -F '#{pane_current_command}' 2>/dev/null \
  | rg -q 'node|tsx|kimi'; then
  echo "[$(timestamp)] pane still running server-ish process, second Ctrl-C" >&2
  tmux send-keys -t "$TMUX_TARGET" C-c
  sleep "$STOP_WAIT"
fi

# Drop scrollback so a later "Kimi server ready" match cannot hit a stale banner
# from the previous run. A marker line makes the post-start wait unambiguous.
tmux clear-history -t "$TMUX_TARGET" 2>/dev/null || true
MARKER="__kimi_web_restart_marker_$(date +%s)__"
tmux send-keys -t "$TMUX_TARGET" "echo ${MARKER}" Enter
sleep 0.5

echo "[$(timestamp)] starting: ${START_CMD}" >&2
tmux send-keys -t "$TMUX_TARGET" "$START_CMD" Enter

for _ in $(seq 1 "$READY_TIMEOUT"); do
  sleep 1
  pane="$(tmux capture-pane -t "$TMUX_TARGET" -p -S -300 2>/dev/null || true)"
  # Require the marker (post-stop) AND a ready banner after it.
  if printf '%s\n' "$pane" | awk -v m="$MARKER" '
      $0 ~ m { seen=1; next }
      seen && /Kimi server ready/ { found=1; exit }
      END { exit found ? 0 : 1 }
    '; then
    echo "[$(timestamp)] RESTART OK" >&2
    exit 0
  fi
done

echo "[$(timestamp)] RESTART FAILED: timed out after ${READY_TIMEOUT}s waiting for ready banner" >&2
exit 1
