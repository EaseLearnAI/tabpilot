# TabPilot

Let a local AI agent (MiniMax Code, or any MCP client) drive **your own logged-in Chrome** —
in a dedicated, visible window where **every conversation gets its own named, colored tab group**
(named after the conversation), and tabs are cleaned up when the work is done.

Personal project, written from scratch.

## Install

```bash
./scripts/setup.sh            # installs the local bridge, registers it with Chrome/Edge/Brave/Arc
```

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → select `extension/`
   (id is fixed: `ppdfpijfpfcjnaimfhhdkpdpjbjmlohl`). The toolbar badge shows **ON** when connected.
2. Add the MCP server to your agent with the command printed by `setup.sh`, e.g.
   `node ~/.local/share/tabpilot/bridge/server.js`.

## MiniMax Code plugin

```bash
./scripts/build-plugin.sh       # bundles the MCP server and installs the plugin to ~/.minimax/plugins/tabpilot
```

The plugin bundles the MCP server, a usage Skill, and two hooks:

- `PreToolUse` injects the conversation id + title into every TabPilot call → one group per conversation, named after it.
- `SessionEnd` (archive / 30 min idle) closes that conversation's group.

## Tab lifecycle (v0.3)

| Rule | Behavior |
| - | - |
| One group per conversation | Title = `task` passed by the agent › conversation title › `🌐 host` of the first page › `MCode`. Colors rotate. |
| Reuse, don't pile up | `tab_open` reuses the group's blank tab; max 6 tabs per group, least-recently-used is closed. Links opening new tabs stay in the same group. |
| Explicit finish | `group_done` closes the whole group; `keep=true` collapses it, marks it ✓ and exempts it from cleanup. |
| Automatic cleanup | Group idle for 30 min → closed (unless the user is looking at it). Conversation ends → closed. |
| User takes over | Drag a tab out of the group, or rename the group → TabPilot never closes it. |

## Dev loop

| You changed | Do |
| - | - |
| `extension/*` | chrome://extensions → TabPilot → Reload |
| `bridge/*` | `./scripts/setup.sh`, then restart the MCP server in your agent |

Checks: `node test/smoke-mcp.mjs` (MCP handshake) · `node test/bridge-loopback.mjs` (bridge round trip, no browser).
Logs: `~/.local/share/tabpilot/logs/`.

See `docs/architecture.md` for the design and `cases/` for the real-world task library.
