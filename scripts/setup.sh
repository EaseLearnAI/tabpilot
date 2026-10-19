#!/usr/bin/env bash
# Install / update the TabPilot local bridge.
# - Copies bridge/ to ~/.local/share/tabpilot/bridge (outside ~/Desktop & ~/Documents,
#   which macOS blocks browsers from executing).
# - Pins the absolute node binary (version managers like fnm/nvm use temporary shims).
# - Writes the per-profile manifest that lets the extension launch the relay (all Chromium browsers found).
# Re-run after changing anything in bridge/. Changes in extension/ only need
# "Reload" on chrome://extensions.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${TABPILOT_HOME:-$HOME/.local/share/tabpilot}"
HOST_NAME="com.tabpilot.bridge"

command -v node >/dev/null || { echo "node not found (need Node.js >= 18)"; exit 1; }
NODE="$(node -e 'process.stdout.write(require("fs").realpathSync(process.execPath))')"

echo "→ installing bridge dependencies"
(cd "$ROOT/bridge" && npm install --omit=dev --no-audit --no-fund --silent)

echo "→ copying bridge to $DEST/bridge"
mkdir -p "$DEST/bridge" "$DEST/logs"
cp -R "$ROOT/bridge/." "$DEST/bridge/"

LAUNCHER="$DEST/bridge/run-relay.sh"
cat > "$LAUNCHER" <<EOF
#!/bin/sh
exec "$NODE" "$DEST/bridge/relay.js" "\$@"
EOF
chmod +x "$LAUNCHER"

EXT_ID="$(node "$ROOT/scripts/ext-id.mjs")"

case "$(uname)" in
  Darwin)
    BROWSER_DIRS=(
      "$HOME/Library/Application Support/Google/Chrome"
      "$HOME/Library/Application Support/Google/Chrome Beta"
      "$HOME/Library/Application Support/Google/Chrome Canary"
      "$HOME/Library/Application Support/Chromium"
      "$HOME/Library/Application Support/Microsoft Edge"
      "$HOME/Library/Application Support/BraveSoftware/Brave-Browser"
      "$HOME/Library/Application Support/Arc/User Data"
    ) ;;
  Linux)
    BROWSER_DIRS=(
      "$HOME/.config/google-chrome"
      "$HOME/.config/chromium"
      "$HOME/.config/microsoft-edge"
      "$HOME/.config/BraveSoftware/Brave-Browser"
    ) ;;
  *) echo "Unsupported OS: $(uname)"; exit 1 ;;
esac

echo "→ registering native host $HOST_NAME for extension $EXT_ID"
registered=0
for dir in "${BROWSER_DIRS[@]}"; do
  [ -d "$dir" ] || continue
  mkdir -p "$dir/NativeMessagingHosts"
  cat > "$dir/NativeMessagingHosts/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "TabPilot local agent bridge",
  "path": "$LAUNCHER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
  echo "   ✓ $dir"
  registered=$((registered + 1))
done
[ "$registered" -gt 0 ] || echo "   (no Chromium browser profile directory found)"

cat <<EOF

Done.
  Extension (load unpacked once): $ROOT/extension   (id $EXT_ID)
  MCP server command:            "$NODE" "$DEST/bridge/server.js"
  Logs:                          $DEST/logs/
EOF
