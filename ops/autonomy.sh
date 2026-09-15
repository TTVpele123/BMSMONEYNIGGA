#!/usr/bin/env bash
# Overnight clock: keep :3222 up, then POST the same scheduler cycle the UI uses.
# launchd PATH is tiny — do not assume nvm is loaded.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${HOME}/.bmsmoneynigga"
mkdir -p "$LOG_DIR"
TICK_LOG="${LOG_DIR}/tick.log"
SERVER_LOG="${LOG_DIR}/server.log"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH}"
if [[ -s "${HOME}/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  . "${HOME}/.nvm/nvm.sh"
fi

health() {
  curl -fsS --max-time 5 "http://127.0.0.1:3222/api/health" >/dev/null
}

if ! health; then
  echo "$(date -u +%FT%TZ) autonomy: :3222 down — starting" >> "$TICK_LOG"
  cd "$ROOT"
  nohup ./start.sh >> "$SERVER_LOG" 2>&1 &
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    if health; then break; fi
    sleep 5
  done
fi

if ! health; then
  echo "$(date -u +%FT%TZ) autonomy: health still down — no tick" >> "$TICK_LOG"
  exit 0
fi

if curl -fsS --max-time 180 -X POST "http://127.0.0.1:3222/api/jobs/tick" >/dev/null; then
  echo "$(date -u +%FT%TZ) autonomy: tick ok" >> "$TICK_LOG"
else
  echo "$(date -u +%FT%TZ) autonomy: tick failed" >> "$TICK_LOG"
fi
