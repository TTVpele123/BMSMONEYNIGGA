#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
# Do not export OUTBOUND_MODE. Runtime mode is settings.outbound_mode (default dry_run).
# Exporting it here used to pin dry_run over a killswitch live flip.
export KILL_SWITCH="${KILL_SWITCH:-false}"
if [[ ! -d node_modules ]]; then
  npm install
fi
npx tsx scripts/migrate.ts
echo "BMSMONEYNIGGA starting on :3222  outbound_mode=settings (default dry_run)  kill=$KILL_SWITCH"
exec npm run dev
