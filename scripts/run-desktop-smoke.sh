#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Keep test metadata separate even when this script is run outside an ephemeral container.
export XDG_DATA_HOME
XDG_DATA_HOME=$(mktemp -d)
trap 'rm -rf "$XDG_DATA_HOME"' EXIT
dbus-run-session -- xvfb-run -a -s '-screen 0 1440x1000x24' bash -c '
  set -euo pipefail
  driver_log=$(mktemp)
  tauri-driver > "$driver_log" 2>&1 &
  driver_pid=$!
  trap '\''kill "$driver_pid" 2>/dev/null || true; cat "$driver_log"; rm -f "$driver_log"'\'' EXIT
  python3 tests/desktop-smoke.py
'
