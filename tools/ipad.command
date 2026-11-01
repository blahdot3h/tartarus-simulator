#!/bin/zsh
# Tartarus hints for the iPad (QuickTime mode), in one double-click:
# QuickTime's Movie Recording (the iPad over its cable), the local site, and
# analyze.html?quicktime=1 in the browser, which connects to the window.
set -eu
repo="$(cd "$(dirname "$0")/.." && pwd)"
port="${TARTARUS_PORT:-8765}"
# The default browser opens the page; TARTARUS_BROWSER names another
# (a Chromium one: "Google Chrome", "Microsoft Edge").
browser="${TARTARUS_BROWSER:-}"
url="http://localhost:$port/analyze.html?quicktime=1&autostart=1"

# QuickTime keeps the camera last chosen: pick the iPad there once.
/usr/bin/osascript >/dev/null <<'OSA' || print 'QuickTime did not open: use File → New Movie Recording by hand.'
tell application "QuickTime Player"
  activate
  if (count of documents) is 0 then new movie recording
end tell
OSA

show() { if [[ -n "$browser" ]]; then /usr/bin/open -a "$browser" "$1"; else /usr/bin/open "$1"; fi; }
served() { /usr/bin/curl --fail --silent --max-time 1 "http://localhost:$port/js/quicktime.js" >/dev/null; }
if served; then show "$url"; exit 0; fi

node_bin="$(command -v node || true)"
if [[ -z "$node_bin" ]]; then
  print 'Node.js not found (brew install node).'
  read -r '?Press Enter to close.'; exit 1
fi
cd "$repo"
"$node_bin" tools/serve.js --port "$port" &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT INT TERM
for i in {1..30}; do
  if served; then
    show "$url"
    print 'The helper is open. Keep this window open; Ctrl+C stops the server.'
    wait "$server"; exit 0
  fi
  /bin/sleep 0.2
done
print 'The local server did not answer.'; exit 1
