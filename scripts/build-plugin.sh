#!/usr/bin/env bash
# Build the MiniMax Code plugin package and install it locally.
#   plugin/                     → source of the plugin package (manifest, hooks, skill, icons)
#   bridge/server.js + deps   → bundled into plugin/server/tabpilot.mjs (single file, no node_modules)
# Installs to $MINIMAX_DATA_DIR/plugins/tabpilot (default ~/.minimax/plugins/tabpilot).
# The Chrome side (native host + extension) is still installed by scripts/setup.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${MINIMAX_DATA_DIR:-${MAVIS_DATA_DIR:-$HOME/.minimax}}"
DEST="$DATA_DIR/plugins/tabpilot"

echo "→ installing bridge dependencies"
(cd "$ROOT/bridge" && npm install --no-audit --no-fund --silent)

echo "→ bundling MCP server"
mkdir -p "$ROOT/plugin/server"
(cd "$ROOT/bridge" && npx --yes esbuild@0.24.2 server.js \
  --bundle --platform=node --format=esm --target=node18 --log-level=warning \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$ROOT/plugin/server/tabpilot.mjs")

node --check "$ROOT/plugin/server/tabpilot.mjs"
node --check "$ROOT/plugin/scripts/hook.mjs"

echo "→ installing plugin to $DEST"
mkdir -p "$DEST"
rsync -a --delete --exclude '.DS_Store' "$ROOT/plugin/" "$DEST/"

echo "Done. MiniMax Code rescans local plugins automatically."
