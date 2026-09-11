#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export OUTBOUND_MODE="${OUTBOUND_MODE:-dry_run}"
export KILL_SWITCH="${KILL_SWITCH:-false}"
if [[ ! -d node_modules ]]; then
  npm install
fi
npx tsx scripts/migrate.ts
echo "BMSMONEYNIGGA starting on :3222  mode=$OUTBOUND_MODE  kill=$KILL_SWITCH"
exec npm run dev
