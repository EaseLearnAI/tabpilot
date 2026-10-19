// Service worker: keeps a native-messaging link to the local bridge and runs tool calls.

import { TOOLS } from './tools.js';
import { initDevtoolsEvents } from './devtools.js';
import { reapIdle, adoptLegacyGroups, remapAfterRestart } from './tabs.js';

const HOST_NAME = 'com.tabpilot.bridge';
let port = null;

initDevtoolsEvents();

function showLinkState(on) {
  chrome.action.setBadgeText({ text: on ? 'ON' : 'OFF' });
  chrome.action.setBadgeBackgroundColor({ color: on ? '#16a34a' : '#9ca3af' });
  chrome.action.setTitle({ title: on ? 'TabPilot: connected to local agent bridge' : 'TabPilot: bridge not connected (run scripts/setup.sh?)' });
}

async function handleCall(msg) {
  const { id, tool, args } = msg;
  const impl = TOOLS[tool];
  let reply;
  if (!impl) {
    reply = { type: 'result', id, ok: false, error: `No such TabPilot tool "${tool}"` };
  } else {
    try {
      reply = { type: 'result', id, ok: true, result: await impl(args || {}) };
    } catch (e) {
      reply = { type: 'result', id, ok: false, error: e?.message || String(e) };
    }
  }
  try {
    port?.postMessage(reply);
  } catch (e) {
    console.warn('[tabpilot] failed to post result', e);
  }
}

function connect() {
  if (port) return;
  let p;
  try {
    p = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    showLinkState(false);
    setTimeout(connect, 2000);
    return;
  }
  port = p;
  p.onMessage.addListener((msg) => {
    if (msg?.type === 'hello') showLinkState(true);
    else if (msg?.type === 'call') handleCall(msg);
  });
  p.onDisconnect.addListener(() => {
    console.warn('[tabpilot] native host disconnected:', chrome.runtime.lastError?.message);
    if (port === p) port = null;
    showLinkState(false);
    setTimeout(connect, 1500);
  });
}

chrome.runtime.onStartup.addListener(() => {
  remapAfterRestart().catch((e) => console.warn('[tabpilot] remap failed', e));
  connect();
});
chrome.runtime.onInstalled.addListener((d) => {
  if (d.reason === 'update') adoptLegacyGroups().catch(() => {});
  connect();
});
chrome.alarms.create('tabpilot-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.create('tabpilot-reaper', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'tabpilot-keepalive' && !port) connect();
  if (a.name === 'tabpilot-reaper') {
    reapIdle()
      .then((closed) => closed.length && console.info('[tabpilot] closed idle groups:', closed))
      .catch((e) => console.warn('[tabpilot] reaper failed', e));
  }
});
chrome.action.onClicked.addListener(() => {
  if (!port) connect();
});

showLinkState(false);
connect();
