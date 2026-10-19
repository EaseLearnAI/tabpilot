// Loopback test of the bridge without a browser:
// fake extension <-native messaging-> relay <-unix socket-> server <-stdio-> this script.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const bridgeDir = process.argv[2] || path.join(os.homedir(), '.local/share/tabpilot/bridge');
const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tp-')), 'b.sock');
const env = { ...process.env, TABPILOT_SOCKET: sock };
const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };
setTimeout(() => fail('timeout'), 10000);

// 1) relay, driven by a fake extension
const relay = spawn(process.execPath, [path.join(bridgeDir, 'relay.js')], { env, stdio: ['pipe', 'pipe', 'inherit'] });
let hbuf = Buffer.alloc(0);
const toRelay = (m) => {
  const b = Buffer.from(JSON.stringify(m));
  const h = Buffer.alloc(4);
  h.writeUInt32LE(b.length);
  relay.stdin.write(Buffer.concat([h, b]));
};
let mcp;
relay.stdout.on('data', (d) => {
  hbuf = Buffer.concat([hbuf, d]);
  while (hbuf.length >= 4) {
    const n = hbuf.readUInt32LE(0);
    if (hbuf.length < 4 + n) break;
    const msg = JSON.parse(hbuf.subarray(4, 4 + n));
    hbuf = hbuf.subarray(4 + n);
    if (msg.type === 'hello') startMcp();
    if (msg.type === 'call') toRelay({ type: 'result', id: msg.id, ok: true, result: { text: `echo:${msg.tool}:${JSON.stringify(msg.args)}` } });
  }
});

// 2) MCP server, driven over stdio
function startMcp() {
  mcp = spawn(process.execPath, [path.join(bridgeDir, 'server.js')], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  mcp.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const m = JSON.parse(line);
      if (m.id === 2) {
        const text = m.result?.content?.[0]?.text;
        if (text !== 'echo:group_status:{"all":true}') fail(`unexpected: ${JSON.stringify(m)}`);
        console.log(`OK: round trip → ${text}`);
        mcp.kill();
        relay.stdin.end();
        process.exit(0);
      }
    }
  });
  const send = (m) => mcp.stdin.write(`${JSON.stringify(m)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'group_status', arguments: { all: true } } });
}
