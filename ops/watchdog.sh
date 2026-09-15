#!/usr/bin/env bash
# Thin wrapper. Real overnight clock is ops/autonomy.sh (launchd every 5 min).
set -euo pipefail
exec "$(cd "$(dirname "$0")" && pwd)/autonomy.sh"
