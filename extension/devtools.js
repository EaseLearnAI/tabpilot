// CDP layer: debugger attachment, per-tab event buffers, page-helper calls,
// and the "settle" logic that decides when a page is ready for the next step.

import { installHelper } from './page-helper.js';

const attached = new Set();
const tabState = new Map();

const HELPER_SRC = `(${installHelper.toString()})()`;
const SETTLE_TYPES = new Set(['Document', 'Stylesheet', 'Script', 'XHR', 'Fetch', 'Font']);
// A request still open after this long is treated as a long poll / stream, not page loading.
const STALE_INFLIGHT_MS = 4000;

export const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function state(tabId) {
  let s = tabState.get(tabId);
  if (!s) {
    s = { lastNet: 0, inflight: new Map(), console: [], network: [], netById: new Map(), detachReason: null };
    tabState.set(tabId, s);
  }
  return s;
}

function pushConsole(s, level, text) {
  s.console.push({ level, text: String(text ?? '').slice(0, 2000), t: Date.now() });
  if (s.console.length > 300) s.console.shift();
}

function fmtArg(a) {
  if (!a) return '';
  if (a.value !== undefined) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
  return a.description || a.type || '';
}

export function initDevtoolsEvents() {
  chrome.debugger.onDetach.addListener((src, reason) => {
    if (src.tabId == null) return;
    attached.delete(src.tabId);
    state(src.tabId).detachReason = reason;
  });

  chrome.debugger.onEvent.addListener((src, method, params) => {
    const tabId = src.tabId;
    if (tabId == null) return;
    const s = state(tabId);
    const now = Date.now();
    switch (method) {
      case 'Network.requestWillBeSent': {
        // Only "page-building" requests count toward network quiet. Long polls,
        // EventSource/WebSocket, beacons and media keep many SPAs (X, Gmail…)
        // permanently busy and must not block settle.
        if (SETTLE_TYPES.has(params.type)) {
          s.lastNet = now;
          s.inflight.set(params.requestId, now);
        }
        const e = {
          id: params.requestId,
          method: params.request?.method,
          url: params.request?.url,
          type: params.type,
          status: null,
          failed: null,
          t: now,
        };
        s.netById.set(params.requestId, e);
        s.network.push(e);
        if (s.network.length > 300) s.netById.delete(s.network.shift().id);
        break;
      }
      case 'Network.responseReceived': {
        if (s.inflight.has(params.requestId)) s.lastNet = now;
        const e = s.netById.get(params.requestId);
        if (e) e.status = params.response?.status;
        break;
      }
      case 'Network.loadingFinished':
        if (s.inflight.delete(params.requestId)) s.lastNet = now;
        break;
      case 'Network.loadingFailed': {
        if (s.inflight.delete(params.requestId)) s.lastNet = now;
        const e = s.netById.get(params.requestId);
        if (e) e.failed = params.errorText || 'failed';
        break;
      }
      case 'Runtime.consoleAPICalled':
        pushConsole(s, params.type, (params.args || []).map(fmtArg).join(' '));
        break;
      case 'Runtime.exceptionThrown': {
        const d = params.exceptionDetails || {};
        pushConsole(s, 'exception', d.exception?.description || d.text);
        break;
      }
      case 'Log.entryAdded':
        pushConsole(s, params.entry?.level, `${params.entry?.text}${params.entry?.url ? ` (${params.entry.url})` : ''}`);
        break;
      default:
        break;
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    attached.delete(tabId);
    tabState.delete(tabId);
  });
}

async function rawSend(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params || {});
}

export async function attach(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    const m = String(e?.message || e);
    if (!/already attached/i.test(m)) {
      if (/cannot access|chrome:\/\/|chrome-extension:\/\//i.test(m)) {
        throw new Error(`This page cannot be controlled (${m}). chrome:// pages and the Web Store are off-limits.`);
      }
      throw new Error(`Failed to attach to tab ${tabId}: ${m}`);
    }
  }
  attached.add(tabId);
  state(tabId).detachReason = null;
  await Promise.allSettled([
    rawSend(tabId, 'Page.enable'),
    rawSend(tabId, 'Runtime.enable'),
    rawSend(tabId, 'Network.enable'),
    rawSend(tabId, 'Log.enable'),
    // Make the page believe it is focused so background tabs keep rendering
    // and SPAs do not stall (a common cause of "white screen").
    rawSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }),
  ]);
}

export async function devtools(tabId, method, params) {
  await attach(tabId);
  try {
    return await rawSend(tabId, method, params);
  } catch (e) {
    const m = String(e?.message || e);
    if (/not attached|detached/i.test(m)) {
      attached.delete(tabId);
      await attach(tabId);
      return rawSend(tabId, method, params);
    }
    throw new Error(`${method}: ${m}`);
  }
}

// Call a function on window.__tp inside the page (main frame, main world).
export async function pageCall(tabId, fn, ...args) {
  const expression = `${HELPER_SRC};\nwindow.__tp.${fn}(...${JSON.stringify(args)})`;
  const r = await devtools(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    const msg = String(d.exception?.description || d.text || 'page error').split('\n')[0];
    throw new Error(msg.replace(/^Error:\s*/, ''));
  }
  return r.result?.value;
}

// Returns the remote objectId of a ref'd element (for DOM.* commands).
export async function refObjectId(tabId, ref) {
  const r = await devtools(tabId, 'Runtime.evaluate', {
    expression: `${HELPER_SRC};\nwindow.__tp.resolve(${JSON.stringify(ref)})`,
    returnByValue: false,
  });
  if (r.exceptionDetails) {
    throw new Error(String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).split('\n')[0]);
  }
  return r.result.objectId;
}

// Wait until the page is "settled": document complete, network quiet and DOM
// quiet for `quietMs`, or until timeout. Never throws; reports what it saw.
export async function settle(tabId, { timeoutMs = 8000, quietMs = 500, minMs = 150 } = {}) {
  const start = Date.now();
  await delay(minMs);
  const s = state(tabId);
  let info = null;
  for (;;) {
    try {
      info = await pageCall(tabId, 'status');
    } catch {
      info = null; // mid-navigation: context destroyed, try again
    }
    const now = Date.now();
    let fresh = 0;
    for (const t of s.inflight.values()) if (now - t < STALE_INFLIGHT_MS) fresh += 1;
    const netQuiet = fresh === 0 && now - s.lastNet >= quietMs;
    // Some SPAs never reach "complete" (a hung subresource); after 3s accept "interactive".
    const loaded = !!info && (info.readyState === 'complete' || (info.readyState === 'interactive' && now - start >= 3000));
    const ok = loaded && netQuiet && info.mutationQuietMs >= quietMs;
    if (ok || now - start >= timeoutMs) {
      return {
        settled: ok,
        ms: now - start,
        url: info?.url,
        title: info?.title,
        readyState: info?.readyState,
        blank: info?.blank ?? false,
        inflight: fresh,
      };
    }
    await delay(150);
  }
}

export function statusLine(st) {
  const state = st.settled
    ? `settled in ${st.ms}ms`
    : `still busy after ${st.ms}ms (readyState=${st.readyState ?? '?'}, inflight=${st.inflight})`;
  return `URL: ${st.url ?? '?'}\nTitle: ${st.title ?? ''}\nPage: ${state}${st.blank ? '\n⚠️ Page looks blank (nothing rendered).' : ''}`;
}
