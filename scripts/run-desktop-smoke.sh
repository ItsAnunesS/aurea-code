#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Keep test metadata separate even when this script is run outside an ephemeral container.
export XDG_DATA_HOME
XDG_DATA_HOME=$(mktemp -d)
export GIT_CONFIG_GLOBAL="$XDG_DATA_HOME/test-gitconfig"
export GIT_CONFIG_NOSYSTEM=1
# Simulate the renamed desktop entry installed by Gear Lever.
export GIO_LAUNCHED_DESKTOP_FILE="$XDG_DATA_HOME/aurea_code.desktop"
trap 'rm -rf "$XDG_DATA_HOME"' EXIT
dbus-run-session -- xvfb-run -a -s '-screen 0 1440x1000x24' bash -c '
  set -euo pipefail
  # Force updater networking offline so smoke tests never install a remote release.
  export HTTPS_PROXY=http://127.0.0.1:9
  export https_proxy="$HTTPS_PROXY"
  driver_log=$(mktemp)
  tauri-driver > "$driver_log" 2>&1 &
  driver_pid=$!
  trap '\''kill "$driver_pid" 2>/dev/null || true; cat "$driver_log"; rm -f "$driver_log"'\'' EXIT
  python3 tests/desktop-smoke.py
'
