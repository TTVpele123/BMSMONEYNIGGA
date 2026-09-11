#!/usr/bin/env bash
# HTTP health watchdog. Run from ~/Projects/BMSMONEYNIGGA — never Desktop.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if ! curl -fsS "http://127.0.0.1:3222/api/health" >/dev/null; then
  echo "$(date -u +%FT%TZ) unhealthy — restarting" >> "${HOME}/.bmsmoneynigga/watchdog.log"
  cd "$ROOT"
  nohup ./start.sh >> "${HOME}/.bmsmoneynigga/server.log" 2>&1 &
fi
