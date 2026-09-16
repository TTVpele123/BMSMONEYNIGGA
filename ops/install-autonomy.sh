#!/usr/bin/env bash
# Load the 5-minute HTTP tick. Safe to re-run. Does not touch Deal OS plists.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.bmsmoneynigga.autonomy"
DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
UID_NUM="$(id -u)"

cat > "$DEST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${ROOT}/ops/autonomy.sh</string>
  </array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${HOME}/.bmsmoneynigga/autonomy.stdout.log</string>
  <key>StandardErrorPath</key><string>${HOME}/.bmsmoneynigga/autonomy.stderr.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/${UID_NUM}" "$DEST"
launchctl enable "gui/${UID_NUM}/${LABEL}"
echo "loaded ${LABEL} → ${DEST}"
launchctl print "gui/${UID_NUM}/${LABEL}" 2>/dev/null | awk '/state =|pid =|runs =|last exit/'
