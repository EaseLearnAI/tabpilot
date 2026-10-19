// Side channel check: plugin hook writes a pending record, host claims it (no browser needed).
// Usage: node test/side-channel.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tabpilot-sc-'));
process.env.TABPILOT_HOME = home;
const { claimPending, PENDING_DIR } = await import('../bridge/shared.js');
const hook = new URL('../plugin/scripts/hook.mjs', import.meta.url).pathname;
const runHook = (input) =>
  execFileSync(process.execPath, ['--no-warnings', hook], { input: JSON.stringify(input), env: { ...process.env, TABPILOT_HOME: home } }).toString();

// Hook must never print (stdout would be treated as a decision).
assert.equal(runHook({ hook_event_name: 'PreToolUse', session_id: 'S1', tool_name: 'mcp__tabpilot_2__goto', tool_input: { tabId: 12, url: 'x.com' } }), '');
runHook({ hook_event_name: 'PreToolUse', session_id: 'S2', tool_name: 'mcp__tabpilot_2__goto', tool_input: { tabId: '13', url: 'github.com' } });
runHook({ hook_event_name: 'PreToolUse', session_id: 'S3', tool_name: 'bash', tool_input: { command: 'ls' } }); // ignored
assert.equal(fs.readdirSync(PENDING_DIR).length, 2);

// Server sees zod-coerced args (numbers); fingerprints still match, out of order.
assert.equal(claimPending('goto', { url: 'github.com', tabId: 13 }).session, 'S2');
assert.equal(claimPending('goto', { tabId: 12, url: 'x.com' }).session, 'S1');
assert.equal(claimPending('goto', { tabId: 12, url: 'x.com' }), null, 'claimed once');
assert.equal(fs.readdirSync(PENDING_DIR).length, 0);

// Fallback: args differ (e.g. extra key stripped by schema) → newest same-tool record from last 5s.
runHook({ hook_event_name: 'PreToolUse', session_id: 'S4', tool_name: 'mcp__tabpilot__group_status', tool_input: { bogus: 1 } });
assert.equal(claimPending('group_status', {}).session, 'S4');
assert.equal(claimPending('snapshot', { tabId: 1 }), null);

fs.rmSync(home, { recursive: true, force: true });
console.log('side channel checks passed');
