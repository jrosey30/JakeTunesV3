#!/bin/bash
# The nightly re-describe, on an Ollama server of its own.
#
# 2026-11-10: on homemini (16 GB) this job took 18 GB and swap went from 4 GB
# to 19 GB every night. The model is 8 GB. The other 8 GB was the model
# server's prompt cache: llama-server keeps the finished state of every prompt
# it has seen, up to 8,192 MB, in case a later prompt starts the same way.
# Every song here is a different prompt and none is ever asked twice, so the
# cache filled to its limit in about 30 songs and was never read
# ("cache state: 28 prompts, 8102 MiB" in Ollama's server.log, all night).
#
# The Ollama app's own server has no switch for it, and restarting it with a
# new environment would change it for everything else on the machine. So this
# job starts a second `ollama serve` on its own port, with the prompt cache
# off, for the length of the run, and stops it at the end. Same binary, same
# model file, same context (4,096), same sampling: only the unused cache goes.
# Measured on homemini: about 10 GB instead of 18, swap steady near 5 GB
# instead of climbing to 19.
#
# If the private server cannot start, the job does NOT fall back to the app's
# server (that is the 18 GB path). It exits 1 and says why.
#
# A last line of defence, whatever the trainer itself does: if swap in use
# passes JT_REDESCRIBE_HARD_SWAP_MB (12 GB; homemini stands at 4 to 6) the run
# is not started, or is ended for the night with the model unloaded. What the
# trainer had saved stays (it saves every 50 songs and at every step-aside)
# and the next night goes on from there. The trainer's own, softer step-aside
# is at 10 GB.
#
# Usage: brain-redescribe-run.sh <node> <repo> [trainer args...]
set -u

NODE_BIN="${1:?node path}"; REPO_DIR="${2:?repo dir}"; shift 2
PORT="${JT_REDESCRIBE_OLLAMA_PORT:-11436}"
OLLAMA_BIN="${JT_REDESCRIBE_OLLAMA_BIN:-/Applications/Ollama.app/Contents/Resources/ollama}"
SERVE_LOG="${JT_REDESCRIBE_OLLAMA_LOG:-$HOME/Library/Logs/jaketunes-brain-redescribe-ollama.log}"

HARD_SWAP_MB="${JT_REDESCRIBE_HARD_SWAP_MB:-12000}"
# Whole megabytes of swap in use, or nothing when it cannot be read.
swap_used_mb() { ${JT_REDESCRIBE_SWAP_CMD:-/usr/sbin/sysctl -n vm.swapusage} 2>/dev/null | sed -nE 's/.*used = ([0-9]+)(\.[0-9]+)?M.*/\1/p'; }

say() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [brain-redescribe-run] $*"; }

sw="$(swap_used_mb)"
if [ -n "$sw" ] && [ "$sw" -gt "$HARD_SWAP_MB" ]; then
  say "swap in use is ${sw} MB (limit ${HARD_SWAP_MB}): not running tonight"
  exit 0
fi
if [ ! -x "$OLLAMA_BIN" ]; then
  say "no ollama at $OLLAMA_BIN: not running (the app's server would take 18 GB)"
  exit 1
fi
if curl -fs -m 3 "http://127.0.0.1:$PORT/api/version" >/dev/null 2>&1; then
  say "port $PORT already answers: another run is using it, not starting a second"
  exit 1
fi

# One night's server log is enough (it logs every token at this verbosity).
: > "$SERVE_LOG"
OLLAMA_HOST="127.0.0.1:$PORT" \
OLLAMA_NUM_PARALLEL=1 \
OLLAMA_MAX_LOADED_MODELS=1 \
LLAMA_ARG_CACHE_RAM=0 \
  "$OLLAMA_BIN" serve >> "$SERVE_LOG" 2>&1 &
SERVE_PID=$!

stop_server() {
  curl -s -m 10 "http://127.0.0.1:$PORT/api/generate" \
    -d "{\"model\":\"${GEMMA_MODEL:-gemma4:12b}\",\"keep_alive\":0}" >/dev/null 2>&1
  kill "$SERVE_PID" 2>/dev/null
  wait "$SERVE_PID" 2>/dev/null
}
trap 'stop_server' EXIT
trap 'exit 143' TERM INT

up=0
for _ in $(seq 1 30); do
  if curl -fs -m 2 "http://127.0.0.1:$PORT/api/version" >/dev/null 2>&1; then up=1; break; fi
  kill -0 "$SERVE_PID" 2>/dev/null || break
  sleep 1
done
if [ "$up" != 1 ]; then
  say "the private ollama server did not come up on port $PORT (see $SERVE_LOG): not running"
  exit 1
fi
say "private ollama server up on 127.0.0.1:$PORT (pid $SERVE_PID), prompt cache off"

GEMMA_URL="http://127.0.0.1:$PORT/api/generate" "$NODE_BIN" "$REPO_DIR/scripts/brain-trainer.mjs" "$@" &
JOB_PID=$!
trap 'kill "$JOB_PID" 2>/dev/null; wait "$JOB_PID" 2>/dev/null; exit 143' TERM INT
while kill -0 "$JOB_PID" 2>/dev/null; do
  sw="$(swap_used_mb)"
  if [ -n "$sw" ] && [ "$sw" -gt "$HARD_SWAP_MB" ]; then
    say "swap in use is ${sw} MB (limit ${HARD_SWAP_MB}): ending tonight's run"
    kill "$JOB_PID" 2>/dev/null
    break
  fi
  sleep 30 &
  wait $!
done
wait "$JOB_PID"
rc=$?
say "re-describe ended (exit $rc)"
exit "$rc"
