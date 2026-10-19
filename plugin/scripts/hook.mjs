#!/usr/bin/env node
// TabPilot plugin hook (MiniMax Code).
//
// PreToolUse (tabpilot tools): record which conversation (id + title) is making this call in a
//   small side-channel file; the TabPilot MCP server claims it and the extension gives every
//   conversation its own tab group, named after the conversation. (We cannot use updatedInput:
//   MiniMax Code rejects hook-rewritten MCP tool input with "Unknown type".)
// SessionEnd: tell the extension to close that conversation's tab group.
//
// Node built-ins only. Fails open: any error → no output, exit 0.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const TOOL_RE = /tabpilot/i;
const DATA_DIR = process.env.MAVIS_DATA_DIR || process.env.MINIMAX_DATA_DIR || path.join(os.homedir(), '.minimax');
const TABPILOT_HOME = process.env.TABPILOT_HOME || path.join(os.homedir(), '.local', 'share', 'tabpilot');
const SOCKET_PATH = process.env.TABPILOT_SOCKET || path.join(TABPILOT_HOME, 'run', 'bridge.sock');
const PENDING_DIR = path.join(TABPILOT_HOME, 'run', 'pending');

// Must match bridge/shared.js argsKey().
function canon(v) {
  if (v == null) return undefined;
  if (Array.isArray(v)) return v.map(canon);
  if (typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) {
      if (k === 'session' || k === 'sessionTitle') continue;
      const c = canon(v[k]);
      if (c !== undefined) o[k] = c;
    }
    return o;
  }
  return String(v);
}

function writePending(record) {
  fs.mkdirSync(PENDING_DIR, { recursive: true, mode: 0o700 });
  const name = `${String(record.t).padStart(15, '0')}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const tmp = path.join(PENDING_DIR, `${name}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(tmp, path.join(PENDING_DIR, `${name}.json`)); // atomic: the server never sees a partial file
}
const PLACEHOLDER_TITLES = /^(new (chat|conversation|session)|untitled|新对话|新会话|新建对话|未命名)$/i;

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function debug(...parts) {
  const dir = process.env.PLUGIN_DATA;
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'hook.log');
    if (fs.existsSync(f) && fs.statSync(f).size > 200_000) fs.truncateSync(f, 0);
    fs.appendFileSync(path.join(dir, 'hook.log'), `${new Date().toISOString()} ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`);
  } catch {
    /* ignore */
  }
}

async function sessionTitle(sessionId) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(DATA_DIR, 'v2', 'sqlite', 'runtime-state.sqlite'), { readOnly: true });
    try {
      const row = db.prepare('SELECT title FROM local_runtime_sessions WHERE session_id = ?').get(sessionId);
      const t = String(row?.title || '').trim();
      return t && !PLACEHOLDER_TITLES.test(t) ? t : '';
    } finally {
      db.close();
    }
  } catch {
    return '';
  }
}

function bridgeCall(tool, args, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = net.createConnection(SOCKET_PATH);
    const done = (v) => {
      clearTimeout(timer);
      sock.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    let buf = '';
    sock.on('error', () => done(null));
    sock.on('connect', () => sock.write(`${JSON.stringify({ id: 'hook-1', tool, args })}\n`));
    sock.on('data', (c) => {
      buf += c.toString('utf8');
      const i = buf.indexOf('\n');
      if (i >= 0) {
        try {
          done(JSON.parse(buf.slice(0, i)));
        } catch {
          done(null);
        }
      }
    });
  });
}

async function main() {
  const input = readStdin();
  const event = input.hook_event_name;
  const sessionId = input.session_id;
  if (!sessionId) return;

  if (event === 'PreToolUse') {
    if (!TOOL_RE.test(String(input.tool_name || ''))) return;
    const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
    const title = await sessionTitle(sessionId);
    const tool = String(input.tool_name).replace(/^mcp__.*?__/, '');
    writePending({ t: Date.now(), tool, key: JSON.stringify(canon(toolInput)), session: sessionId, title });
    debug('pre', tool, sessionId, title);
    return; // no stdout: never rewrite the tool input
  }

  if (event === 'SessionEnd') {
    if (!fs.existsSync(SOCKET_PATH)) return; // browser bridge not running → nothing open
    const r = await bridgeCall('session_end', { session: sessionId }, 2000);
    debug('end', sessionId, input.reason, r?.result?.text || r?.error || 'no reply');
  }
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
