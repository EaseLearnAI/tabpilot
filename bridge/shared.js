// Shared paths, logging and line framing for the native host and MCP server.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOST_NAME = 'com.tabpilot.bridge';
export const BASE_DIR = process.env.TABPILOT_HOME || path.join(os.homedir(), '.local', 'share', 'tabpilot');
export const RUN_DIR = path.join(BASE_DIR, 'run');
export const LOG_DIR = path.join(BASE_DIR, 'logs');
export const SOCKET_PATH = process.env.TABPILOT_SOCKET || path.join(RUN_DIR, 'bridge.sock');

export function ensureDirs() {
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(RUN_DIR, 0o700);
  } catch {
    /* ignore */
  }
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

export function makeLogger(name) {
  const file = path.join(LOG_DIR, `${name}.log`);
  try {
    ensureDirs();
    if (fs.statSync(file).size > 2_000_000) fs.truncateSync(file, 0);
  } catch {
    /* new file */
  }
  return (...parts) => {
    const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
    try {
      fs.appendFileSync(file, `${new Date().toISOString()} [${process.pid}] ${line}\n`);
    } catch {
      /* ignore */
    }
  };
}

// Newline-delimited JSON reader; one instance per stream.
export function lineReader(onMessage) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      onMessage(msg);
    }
  };
}

// ---- Conversation identity side channel ----
// MiniMax Code rejects hook-rewritten MCP tool input, so the plugin's PreToolUse hook drops a
// small "pending" record (tool + args fingerprint + session) here and the MCP server claims it.
export const PENDING_DIR = path.join(RUN_DIR, 'pending');
const PENDING_TTL_MS = 60_000;

export function shortToolName(name) {
  return String(name || '').replace(/^mcp__.*?__/, '');
}

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

export function argsKey(args) {
  return JSON.stringify(canon(args || {}));
}

export function claimPending(tool, args) {
  let files;
  try {
    files = fs.readdirSync(PENDING_DIR).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return null;
  }
  const key = argsKey(args);
  const now = Date.now();
  const entries = [];
  for (const f of files) {
    const file = path.join(PENDING_DIR, f);
    try {
      const e = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (now - e.t > PENDING_TTL_MS) {
        fs.rmSync(file, { force: true });
        continue;
      }
      if (e.tool === tool) entries.push({ file, e });
    } catch {
      /* partially written or already claimed */
    }
  }
  // Exact fingerprint first (oldest first), then the newest same-tool record from the last 5s.
  const pick = entries.find((x) => x.e.key === key) || entries.filter((x) => now - x.e.t < 5000).pop();
  if (!pick) return null;
  try {
    fs.rmSync(pick.file);
  } catch {
    return null; // claimed by another server process
  }
  return pick.e;
}
