// Smoke test: MCP handshake + tools/list against the installed server.
// Usage: node test/smoke-mcp.mjs [path/to/server.js]
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const server = process.argv[2] || path.join(os.homedir(), '.local/share/tabpilot/bridge/server.js');
const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const timer = setTimeout(() => {
  console.error('FAIL: no tools/list response within 8s');
  child.kill();
  process.exit(1);
}, 8000);

child.stdout.on('data', (d) => {
  buf += d;
  for (const line of buf.split('\n')) {
    try {
      const m = JSON.parse(line);
      if (m.id === 2) {
        const names = m.result.tools.map((t) => t.name);
        console.log(`OK: ${names.length} tools — ${names.join(', ')}`);
        clearTimeout(timer);
        child.kill();
        process.exit(0);
      }
    } catch {
      /* partial line */
    }
  }
});

const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } });
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
