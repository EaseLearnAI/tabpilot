#!/usr/bin/env node
// MCP server (stdio). Started by the agent (MiniMax Code etc.); talks to the
// native host over a user-private unix socket.

import net from 'node:net';
import { spawn } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SOCKET_PATH, makeLogger, lineReader, claimPending } from './shared.js';
import { TOOLS } from './schema.js';

const log = makeLogger('server');

class Bridge {
  constructor() {
    this.sock = null;
    this.pending = new Map();
    this.seq = 0;
    this.triedLaunch = false;
  }

  connectOnce() {
    return new Promise((resolve, reject) => {
      const s = net.createConnection(SOCKET_PATH);
      s.once('error', reject);
      s.once('connect', () => {
        s.removeListener('error', reject);
        s.on('error', () => {});
        s.on('data', lineReader((m) => this.onMessage(m)));
        s.on('close', () => {
          if (this.sock === s) this.sock = null;
          for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.reject(new Error('Bridge closed mid-call (browser or extension restarted). Check the page state before retrying.'));
          }
          this.pending.clear();
        });
        this.sock = s;
        resolve();
      });
    });
  }

  async ensure() {
    if (this.sock && !this.sock.destroyed) return;
    const deadline = Date.now() + 12000;
    let lastErr;
    while (Date.now() < deadline) {
      try {
        await this.connectOnce();
        return;
      } catch (e) {
        lastErr = e;
        if (!this.triedLaunch && process.platform === 'darwin') {
          this.triedLaunch = true;
          log('bridge not available, launching Chrome');
          try {
            spawn('open', ['-g', '-a', 'Google Chrome'], { stdio: 'ignore', detached: true }).unref();
          } catch {
            /* ignore */
          }
        }
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    throw new Error(
      `Browser not connected (${lastErr?.code || lastErr?.message}). Make sure Chrome is running and the TabPilot extension is loaded and enabled (its badge shows ON).`,
    );
  }

  onMessage(m) {
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok) p.resolve(m.result);
    else p.reject(new Error(m.error || 'Unknown error'));
  }

  async call(tool, args, timeoutMs = 90000) {
    await this.ensure();
    this.seq += 1;
    const id = String(this.seq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the browser (${tool}).`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sock.write(`${JSON.stringify({ id, tool, args })}\n`);
    });
  }
}

function toContent(r) {
  if (r == null) return { content: [{ type: 'text', text: 'ok' }] };
  if (typeof r === 'string') return { content: [{ type: 'text', text: r }] };
  const content = [];
  if (r.text) content.push({ type: 'text', text: r.text });
  if (r.image) content.push({ type: 'image', data: r.image.data, mimeType: r.image.mimeType });
  if (!content.length) content.push({ type: 'text', text: JSON.stringify(r) });
  return { content };
}

const bridge = new Bridge();
const server = new McpServer({ name: 'tabpilot', version: '0.4.0' });

for (const t of TOOLS) {
  server.registerTool(t.name, { description: t.description, inputSchema: t.input }, async (args, extra) => {
    const started = Date.now();
    const a = { ...(args || {}) };
    // Conversation identity: from the plugin hook's side channel, or from request _meta.
    if (!a.session) {
      const p = claimPending(t.name, args);
      if (p) {
        a.session = p.session;
        if (p.title) a.sessionTitle = p.title;
      } else {
        const meta = extra?._meta || {};
        a.session = meta.sessionId || meta.session_id || undefined;
        log('no session for', t.name, '_meta keys:', Object.keys(meta).join(',') || '-');
      }
    }
    try {
      const r = await bridge.call(t.name, a, t.timeoutMs);
      log('ok ', t.name, `${Date.now() - started}ms`);
      return toContent(r);
    } catch (e) {
      log('err', t.name, `${Date.now() - started}ms`, e.message);
      return { isError: true, content: [{ type: 'text', text: `TabPilot error: ${e.message}` }] };
    }
  });
}

process.stdin.on('end', () => process.exit(0));
await server.connect(new StdioServerTransport());
log('started');
