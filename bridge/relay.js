#!/usr/bin/env node
// Native messaging host. Chrome launches it when the extension connects.
// It owns a user-private unix socket that MCP servers (one per agent session) connect to,
// and routes tool calls between them and the extension.

import net from 'node:net';
import fs from 'node:fs';
import { SOCKET_PATH, ensureDirs, makeLogger, lineReader } from './shared.js';

const log = makeLogger('relay');
ensureDirs();

// ---- Chrome native messaging framing (uint32 LE length + JSON) ----
function toExtension(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

let inBuf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  inBuf = Buffer.concat([inBuf, chunk]);
  while (inBuf.length >= 4) {
    const len = inBuf.readUInt32LE(0);
    if (inBuf.length < 4 + len) break;
    const body = inBuf.subarray(4, 4 + len);
    inBuf = inBuf.subarray(4 + len);
    try {
      onExtensionMessage(JSON.parse(body.toString('utf8')));
    } catch (e) {
      log('bad message from extension', e.message);
    }
  }
});
process.stdin.on('end', () => shutdown('extension disconnected (stdin closed)'));

// ---- routing ----
const clients = new Map(); // cid -> socket
const pending = new Map(); // routedId -> { cid, id, tool, t }
let nextCid = 1;

function onExtensionMessage(msg) {
  if (msg.type !== 'result') return;
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  log(msg.ok ? 'ok ' : 'err', p.tool, `${Date.now() - p.t}ms`, msg.ok ? '' : String(msg.error).slice(0, 300));
  const sock = clients.get(p.cid);
  if (sock && !sock.destroyed) {
    sock.write(`${JSON.stringify({ id: p.id, ok: msg.ok, result: msg.result, error: msg.error })}\n`);
  }
}

let myIno = null;

function listen() {
  try {
    fs.unlinkSync(SOCKET_PATH); // stale socket from a previous host
  } catch {
    /* none */
  }
  const server = net.createServer((sock) => {
    const cid = nextCid++;
    clients.set(cid, sock);
    log('client connected', cid);
    sock.on('data', lineReader((msg) => {
      if (msg.type === 'ping') {
        sock.write(`${JSON.stringify({ type: 'pong' })}\n`);
        return;
      }
      if (!msg.id || !msg.tool) return;
      const rid = `${cid}:${msg.id}`;
      pending.set(rid, { cid, id: msg.id, tool: msg.tool, t: Date.now() });
      toExtension({ type: 'call', id: rid, tool: msg.tool, args: msg.args || {} });
    }));
    sock.on('close', () => {
      clients.delete(cid);
      for (const [k, v] of pending) if (v.cid === cid) pending.delete(k);
      log('client closed', cid);
    });
    sock.on('error', () => {});
  });
  server.on('error', (e) => {
    log('server error', e.message);
    shutdown('listen failed');
  });
  server.listen(SOCKET_PATH, () => {
    try {
      fs.chmodSync(SOCKET_PATH, 0o600);
      myIno = fs.statSync(SOCKET_PATH).ino;
    } catch {
      /* ignore */
    }
    log('listening on', SOCKET_PATH);
    toExtension({ type: 'hello', pid: process.pid });
  });
}

function shutdown(reason) {
  log('shutdown:', reason);
  try {
    if (myIno != null && fs.statSync(SOCKET_PATH).ino === myIno) fs.unlinkSync(SOCKET_PATH);
  } catch {
    /* ignore */
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => log('uncaught', e.stack || String(e)));

listen();
