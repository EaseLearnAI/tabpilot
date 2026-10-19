// Tool implementations. Names must match bridge/schema.js.

import { devtools, pageCall, refObjectId, settle, statusLine, state, attach, delay } from './devtools.js';
import {
  resolveGroup, groupOfTab, touchTab, createTab, adoptTab, finishGroup, listGroups, groupsOfSession,
  activateIfManaged, LIMITS,
} from './tabs.js';
import { clickAt, moveTo, wheel, insertText, pressKeys } from './input.js';

// One action at a time per tab: concurrent calls on the same tab would race.
const queues = new Map();
function serial(tabId, fn) {
  const prev = queues.get(tabId) || Promise.resolve();
  const run = prev.then(fn, fn);
  queues.set(tabId, run.catch(() => {}));
  return run;
}

function tabTool(fn) {
  return (args) => {
    const tabId = Number(args.tabId);
    if (!Number.isFinite(tabId)) throw new Error('tabId is required (get one from group_status).');
    return serial(tabId, async () => {
      await activateIfManaged(tabId);
      const r = await fn(tabId, args);
      touchTab(tabId, { session: args.session, sessionTitle: args.sessionTitle }).catch(() => {});
      return r;
    });
  };
}

const toBool = (v) => v === true || v === 1 || /^(true|on|yes|1|checked)$/i.test(String(v));

async function clickRef(tabId, ref, { force = false } = {}) {
  const c = await pageCall(tabId, 'center', ref);
  if (c.w === 0 && c.h === 0) throw new Error(`${ref} has zero size (hidden).`);
  if (!c.ok) {
    if (!force) {
      throw new Error(`${ref} ${c.label} is covered by ${c.hit}. Close the overlay/dialog first, or retry with force=true (DOM click).`);
    }
    await pageCall(tabId, 'jsClick', ref);
    return { how: 'DOM click (forced)', c };
  }
  await clickAt(tabId, c.x, c.y);
  return { how: `click at (${Math.round(c.x)},${Math.round(c.y)})`, c };
}

// Focus a text field the way a human does (real click), falling back to JS focus.
async function focusField(tabId, ref) {
  try {
    const c = await pageCall(tabId, 'center', ref);
    if (c.ok && c.w > 0) {
      await clickAt(tabId, c.x, c.y);
      return;
    }
  } catch {
    /* fall through */
  }
  await pageCall(tabId, 'focus', ref);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

async function blobToB64(blob) {
  const u8 = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function formatTab(t) {
  return `  • tabId ${t.id}: ${JSON.stringify(t.title || '')} (${t.url})${t.active ? ' [active]' : ''}`;
}

function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? 'just now' : `${m} min ago`;
}

function formatGroupHead(g) {
  return `"${g.meta.title}" (groupId ${g.groupId}, ${g.tabs.length} tab(s), last used ${ago(g.meta.lastUsed)}${g.meta.kept ? ', kept by user/agent' : ''})`;
}

function formatEvicted(ev) {
  return ev?.length
    ? `\n(Group limit is ${LIMITS.maxTabs} tabs — closed least-recently-used: ${ev.map((t) => `${t.id} ${JSON.stringify(t.title || t.url)}`).join(', ')})`
    : '';
}

// Group for a group-level call: explicit groupId, this conversation's group, or the task title.
function groupArgs(args, create = true) {
  return { groupId: args.groupId, session: args.session, task: args.task, sessionTitle: args.sessionTitle, create };
}

async function TOOLS_NAV(tabId, { url, timeoutMs = 15000 }, prefix = '') {
  await attach(tabId);
  if (url === 'back' || url === 'forward') {
    const h = await devtools(tabId, 'Page.getNavigationHistory');
    const e = h.entries[h.currentIndex + (url === 'back' ? -1 : 1)];
    if (!e) throw new Error(`No ${url} history entry.`);
    await devtools(tabId, 'Page.navigateToHistoryEntry', { entryId: e.id });
  } else if (url === 'reload') {
    await devtools(tabId, 'Page.reload', {});
  } else {
    const u = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
    const r = await devtools(tabId, 'Page.navigate', { url: u });
    if (r.errorText) throw new Error(`Navigation failed: ${r.errorText}`);
  }
  let st = await settle(tabId, { timeoutMs });
  let note = '';
  if (st.blank) {
    await devtools(tabId, 'Page.reload', {});
    st = await settle(tabId, { timeoutMs });
    note = st.blank
      ? '\n⚠️ Still blank after one automatic reload. Check console_logs / network_log or take a screenshot.'
      : '\n(Page was blank; recovered after one automatic reload.)';
  }
  try {
    const host = new URL(st.url || '').hostname.replace(/^www\./, '');
    if (host) await touchTab(tabId, { host: `🌐 ${host}` });
  } catch {
    /* non-http page */
  }
  return { text: `${prefix}${statusLine(st)}${note}\nNext: snapshot to get element refs.` };
}

// Tabs opened while `fn` runs (e.g. target=_blank links, window.open).
async function watchNewTabs(fn) {
  const opened = [];
  const onCreated = (t) => opened.push(t.id);
  chrome.tabs.onCreated.addListener(onCreated);
  try {
    const r = await fn();
    await delay(400);
    return { r, opened };
  } finally {
    chrome.tabs.onCreated.removeListener(onCreated);
  }
}

export const TOOLS = {
  async reload_extension() {
    // Dev loop: pick up edited extension files without touching chrome://extensions.
    setTimeout(() => chrome.runtime.reload(), 200);
    return { text: `Reloading TabPilot extension v${chrome.runtime.getManifest().version}; it reconnects in ~2s.` };
  },

  async version() {
    return { text: `TabPilot extension v${chrome.runtime.getManifest().version}` };
  },

  async group_status(args) {
    const { all = false, autoCreate = true } = args;
    const g = await resolveGroup(groupArgs(args, autoCreate !== false));
    const lines = [];
    if (g) {
      lines.push(`Your TabPilot tab group ${formatGroupHead(g)} — in the agent window; the user can watch and take over here:`);
      g.tabs.forEach((t) => lines.push(formatTab(t)));
      lines.push(
        '',
        `Work only in these tabs (use goto in the existing tab; tab_open only when you really need a second page). ` +
          `Max ${LIMITS.maxTabs} tabs per group — older ones get closed. ` +
          `When the browser part of the task is done, call group_done (keep=true only if the user should look at the result).`,
      );
    } else {
      lines.push('No TabPilot group for this task yet. Call group_status with autoCreate=true (default).');
    }
    const others = (await listGroups()).filter((o) => !g || o.groupId !== g.groupId);
    if (others.length) {
      lines.push('', `Other TabPilot groups (belong to other conversations — do not touch): ${others.map((o) => `"${o.meta.title}"`).join(', ')}`);
    }
    if (all) {
      const managed = new Set([g?.groupId, ...others.map((o) => o.groupId)]);
      const tabs = await chrome.tabs.query({});
      lines.push('', 'User\'s own browser tabs (act on them by tabId, or tab_adopt to move one into your group):');
      tabs.filter((t) => !managed.has(t.groupId)).forEach((t) => lines.push(formatTab(t)));
    }
    return { text: lines.join('\n') };
  },

  async tab_open(args) {
    const g = await resolveGroup(groupArgs(args));
    const { tab, evicted } = await createTab(g);
    const head = `Created tabId ${tab.id} in group "${g.meta.title}".${formatEvicted(evicted)}\n`;
    // Create blank, then load the URL through CDP so settle waits for the real page
    // (settling right after tabs.create only sees the initial about:blank).
    if (args.url && args.url !== 'about:blank') {
      return serial(tab.id, () => TOOLS_NAV(tab.id, { url: args.url }, head));
    }
    return { text: `${head.trim()} (about:blank)` };
  },

  async tab_close(args) {
    if (args.tabId != null) {
      const tabId = Number(args.tabId);
      await chrome.tabs.remove(tabId);
      return { text: `Closed tab ${tabId}.` };
    }
    if (args.groupId != null) {
      const r = await finishGroup(String(args.groupId));
      return { text: `Closed group "${r.title}" (${r.closed} tab(s)).` };
    }
    throw new Error('Provide tabId (one tab) or groupId (whole group). To end your task, use group_done.');
  },

  async group_done(args) {
    const g = await resolveGroup(groupArgs(args, false));
    if (!g) return { text: 'Nothing to clean up: this conversation has no open TabPilot group.' };
    const r = await finishGroup(String(g.groupId), { keep: args.keep === true });
    return {
      text: r.kept
        ? `Kept ${r.kept} tab(s) in group "${r.title}" (collapsed, excluded from auto-cleanup). Tell the user where to look.`
        : `Done: closed group "${r.title}" (${r.closed} tab(s)).`,
    };
  },

  async tab_adopt(args) {
    const g = await resolveGroup(groupArgs(args));
    const { tab, evicted } = await adoptTab(Number(args.tabId), g);
    return { text: `Moved tab ${tab.id} (${tab.url}) into group "${g.meta.title}".${formatEvicted(evicted)}` };
  },

  // Internal (not an MCP tool): called by the plugin's SessionEnd hook.
  async session_end({ session, keepKept = true }) {
    if (!session) throw new Error('session is required');
    const groups = await groupsOfSession(session);
    const closed = [];
    for (const g of groups) {
      if (keepKept && g.meta.kept) continue;
      const r = await finishGroup(String(g.groupId)).catch(() => null);
      if (r) closed.push(`${r.title} (${r.closed})`);
    }
    return { text: closed.length ? `Closed: ${closed.join(', ')}` : 'No open groups for this session.' };
  },

  goto: tabTool((tabId, args) => TOOLS_NAV(tabId, args)),

  snapshot: tabTool(async (tabId, { filter = 'interactive', maxChars = 25000 }) => {
    const r = await pageCall(tabId, 'snapshot', { filter, maxChars });
    const head = `URL: ${r.url}\nTitle: ${r.title}\nViewport ${r.vw}x${r.vh}, scrollY ${r.sy} of ${r.sh}${r.truncated ? '\n(truncated — use locate for specific elements, or scroll)' : ''}`;
    return { text: `${head}\n\n${r.text}` };
  }),

  locate: tabTool(async (tabId, { query, limit = 30 }) => {
    const r = await pageCall(tabId, 'locate', query, limit);
    return { text: r.count ? `${r.count} match(es):\n${r.text}` : `No element matches ${JSON.stringify(query)}. Try snapshot, a shorter query, or scroll.` };
  }),

  click: tabTool(async (tabId, { ref, x, y, button = 'left', double = false, force = false }) => {
    const before = (await chrome.tabs.get(tabId)).url;
    const { r: desc, opened } = await watchNewTabs(async () => {
      if (ref) {
        if (double || button !== 'left') {
          const c = await pageCall(tabId, 'center', ref);
          if (!c.ok && !force) throw new Error(`${ref} is covered by ${c.hit}.`);
          await clickAt(tabId, c.x, c.y, { button, clickCount: double ? 2 : 1 });
          return `${ref} ${c.label}`;
        }
        const r = await clickRef(tabId, ref, { force });
        return `${ref} ${r.c.label} via ${r.how}`;
      }
      if (x != null && y != null) {
        await clickAt(tabId, Number(x), Number(y), { button, clickCount: double ? 2 : 1 });
        return `(${x},${y})`;
      }
      throw new Error('Provide ref, or x and y.');
    });
    let extra = '';
    if (opened.length) {
      const lines = [];
      const home = await groupOfTab(tabId);
      for (const id of opened) {
        try {
          if (home) {
            const { evicted } = await adoptTab(id, { groupId: home.groupId }); // keep it inside this task's group
            if (evicted.length) lines.push(`  (closed old tab(s) ${evicted.map((t) => t.id).join(', ')} — group limit)`);
          }
          await settle(id, { timeoutMs: 12000 });
          const t = await chrome.tabs.get(id);
          lines.push(`  • tabId ${id}: ${JSON.stringify(t.title || '')} (${t.url})`);
        } catch {
          lines.push(`  • tabId ${id}`);
        }
      }
      extra = `\nOpened ${opened.length} new tab(s) — continue there:\n${lines.join('\n')}`;
    }
    const st = await settle(tabId, { timeoutMs: 5000 });
    const nav = st.url && st.url !== before ? `\nNavigated → ${st.url}` : '';
    return { text: `Clicked ${desc}.${nav}${extra}\n${statusLine(st)}` };
  }),

  hover: tabTool(async (tabId, { ref, x, y }) => {
    let px = x;
    let py = y;
    if (ref) {
      const c = await pageCall(tabId, 'center', ref);
      px = c.x;
      py = c.y;
    }
    if (px == null || py == null) throw new Error('Provide ref, or x and y.');
    await moveTo(tabId, Number(px), Number(py));
    await delay(300);
    return { text: `Hovering at (${Math.round(px)},${Math.round(py)}).` };
  }),

  type: tabTool(async (tabId, { text, ref, clear = false, submit = false }) => {
    if (ref) {
      await focusField(tabId, ref);
      if (!clear) await pageCall(tabId, 'caretEnd', ref);
    }
    if (clear) {
      await pageCall(tabId, 'selectAll', ref || null);
      if (!text) await pressKeys(tabId, 'Backspace');
    }
    if (text) await insertText(tabId, String(text));
    if (submit) await pressKeys(tabId, 'Enter');
    const st = await settle(tabId, { timeoutMs: submit ? 8000 : 1500 });
    let val = '';
    if (ref) {
      try {
        const info = await pageCall(tabId, 'fieldInfo', ref);
        val = info.masked ? ' Current value: (masked)' : ` Current value: ${JSON.stringify(await pageCall(tabId, 'valueOf', ref))}`;
      } catch {
        /* element may be gone after submit */
      }
    }
    return { text: `Typed ${String(text || '').length} chars${ref ? ` into ${ref}` : ''}${submit ? ' + Enter' : ''}.${val}\n${statusLine(st)}` };
  }),

  fill_form: tabTool(async (tabId, { fields, mode = 'type' }) => {
    const out = [];
    const finalChecks = [];
    for (const f of fields || []) {
      try {
        const info = await pageCall(tabId, 'fieldInfo', f.ref);
        let res;
        if (info.kind === 'select') {
          res = await pageCall(tabId, 'selectOption', f.ref, String(f.value));
        } else if (info.kind === 'toggle') {
          const want = toBool(f.value);
          if (info.checked !== want) await clickRef(tabId, f.ref).catch(() => pageCall(tabId, 'jsClick', f.ref));
          let now = await pageCall(tabId, 'fieldInfo', f.ref);
          if (now.checked !== want) {
            await pageCall(tabId, 'jsClick', f.ref);
            now = await pageCall(tabId, 'fieldInfo', f.ref);
          }
          if (now.checked !== want) throw new Error(`could not set checked=${want}`);
          res = `checked=${now.checked}`;
        } else if (info.kind === 'text' || info.kind === 'editable') {
          const v = String(f.value ?? '');
          if (mode === 'set' && info.kind === 'text') {
            await pageCall(tabId, 'setValue', f.ref, v);
          } else {
            await focusField(tabId, f.ref);
            await pageCall(tabId, 'selectAll', f.ref);
            if (v === '') await pressKeys(tabId, 'Backspace');
            else await insertText(tabId, v);
          }
          let got = await pageCall(tabId, 'valueOf', f.ref);
          if (info.kind === 'text' && got !== v) {
            await pageCall(tabId, 'setValue', f.ref, v); // fallback for picky widgets
            got = await pageCall(tabId, 'valueOf', f.ref);
          }
          const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
          if (info.masked) res = 'filled (masked)';
          else res = `value=${JSON.stringify(got)}${norm(got) !== norm(v) ? ' ⚠️ differs from requested (field may format/limit input)' : ''}`;
        } else if (info.kind === 'file') {
          throw new Error('file input — use attach_files');
        } else {
          throw new Error(`${info.role} is not a native form field (custom widget). Operate it with click + snapshot.`);
        }
        out.push(`✓ ${f.ref}${info.label ? ` ${JSON.stringify(info.label)}` : ''} ${res}`);
        if (info.kind === 'text' && !info.masked) finalChecks.push({ i: out.length - 1, ref: f.ref, want: String(f.value ?? '') });
      } catch (e) {
        out.push(`✗ ${f.ref}: ${e.message}`);
      }
    }
    await pageCall(tabId, 'blurActive').catch(() => {});
    await delay(300);
    // Final pass: widgets (date pickers, masks, autocompletes) may clear or rewrite
    // a value on blur. Catch that here instead of finding out on submit.
    const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
    for (const c of finalChecks) {
      try {
        const got = await pageCall(tabId, 'valueOf', c.ref);
        if (norm(got) !== norm(c.want)) {
          out[c.i] = `✗ ${c.ref}: value changed after leaving the field → ${JSON.stringify(got)} (widget rejected/reformatted it; try its own UI, e.g. click + pick, or a different format)`;
        }
      } catch {
        /* element gone */
      }
    }
    const st = await settle(tabId, { timeoutMs: 2000 });
    return { text: `${out.join('\n')}\n${statusLine(st)}` };
  }),

  press_key: tabTool(async (tabId, { keys }) => {
    await pressKeys(tabId, keys);
    const st = await settle(tabId, { timeoutMs: /enter/i.test(keys) ? 6000 : 1500 });
    return { text: `Pressed ${keys}.\n${statusLine(st)}` };
  }),

  scroll: tabTool(async (tabId, { ref, direction = 'down', amount = 5 }) => {
    let info;
    if (ref) {
      info = await pageCall(tabId, 'revealRef', ref);
    } else {
      const m = await pageCall(tabId, 'metrics');
      const px = Number(amount) * 100;
      const dx = direction === 'left' ? -px : direction === 'right' ? px : 0;
      const dy = direction === 'up' ? -px : direction === 'down' ? px : 0;
      await wheel(tabId, m.vw / 2, m.vh / 2, dx, dy);
      await delay(350);
      info = await pageCall(tabId, 'scrollInfo');
    }
    return { text: `Scrolled. Position y=${info.y} of ${info.h} (viewport ${info.vh}). Take a new snapshot for refs.` };
  }),

  read_text: tabTool(async (tabId, { maxChars = 30000 }) => {
    const r = await pageCall(tabId, 'text', maxChars);
    return { text: `URL: ${r.url}\nTitle: ${r.title}${r.truncated ? '\n(truncated)' : ''}\n\n${r.text}` };
  }),

  screenshot: tabTool(async (tabId) => {
    const m = await pageCall(tabId, 'metrics');
    const shot = await devtools(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: 75 });
    let data = shot.data;
    let w = Math.round(m.vw);
    let h = Math.round(m.vh);
    // Downscale to CSS pixels so x,y read off the image can be clicked directly.
    try {
      const bmp = await createImageBitmap(new Blob([b64ToBytes(shot.data)], { type: 'image/jpeg' }));
      if (bmp.width !== w) {
        const canvas = new OffscreenCanvas(w, h);
        canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
        data = await blobToB64(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.75 }));
      } else {
        w = bmp.width;
        h = bmp.height;
      }
    } catch {
      w = 0; // unknown scale
    }
    const note = w ? `Screenshot ${w}x${h} in CSS pixels — x,y on this image can be passed to click directly.` : 'Screenshot (device pixels).';
    return { text: note, image: { data, mimeType: 'image/jpeg' } };
  }),

  evaluate: tabTool(async (tabId, { expression }) => {
    const r = await devtools(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) {
      throw new Error(String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).split('\n')[0]);
    }
    const v = r.result?.value;
    const s = v === undefined ? String(r.result?.description ?? 'undefined') : typeof v === 'string' ? v : JSON.stringify(v, null, 2);
    return { text: s.length > 20000 ? `${s.slice(0, 20000)}\n…(truncated)` : s };
  }),

  wait_for: tabTool(async (tabId, { text, selector, gone = false, timeoutMs = 15000 }) => {
    const start = Date.now();
    for (;;) {
      let found = false;
      try {
        found = await pageCall(tabId, 'check', { text, selector });
      } catch (e) {
        if (/Invalid selector/.test(e.message)) throw e;
      }
      if (found !== gone) {
        return { text: `Condition met after ${Date.now() - start}ms (${gone ? 'gone' : 'present'}: ${text || selector || 'load'}).` };
      }
      if (Date.now() - start > timeoutMs) {
        const st = await settle(tabId, { timeoutMs: 1, minMs: 0 });
        throw new Error(`Timed out after ${timeoutMs}ms waiting for ${gone ? 'absence of' : ''} ${JSON.stringify(text || selector)}.\n${statusLine(st)}`);
      }
      await delay(250);
    }
  }),

  page_health: tabTool(async (tabId) => {
    const st = await settle(tabId, { timeoutMs: 1, minMs: 0 });
    const s = state(tabId);
    const errors = s.console.filter((c) => /error|exception/i.test(c.level));
    const failed = s.network.filter((n) => n.failed || (n.status && n.status >= 400));
    const lines = [
      statusLine(st),
      `In-flight requests: ${s.inflight.size}`,
      `Console errors (since attach): ${errors.length}${errors.length ? `\n  last: ${errors[errors.length - 1].text.slice(0, 300)}` : ''}`,
      `Failed/4xx/5xx requests: ${failed.length}${failed.slice(-5).map((n) => `\n  ${n.status || n.failed} ${n.method} ${n.url.slice(0, 160)}`).join('')}`,
    ];
    if (s.detachReason) lines.push(`Debugger was detached earlier: ${s.detachReason}`);
    return { text: lines.join('\n') };
  }),

  console_logs: tabTool(async (tabId, { regex, errorsOnly = false, limit = 50 }) => {
    await attach(tabId);
    let list = state(tabId).console;
    if (errorsOnly) list = list.filter((c) => /error|exception/i.test(c.level));
    if (regex) {
      const re = new RegExp(regex, 'i');
      list = list.filter((c) => re.test(c.text));
    }
    list = list.slice(-limit);
    return { text: list.length ? list.map((c) => `[${c.level}] ${c.text}`).join('\n') : 'No matching console messages (only captured since TabPilot attached to this tab).' };
  }),

  network_log: tabTool(async (tabId, { urlContains, failedOnly = false, limit = 50 }) => {
    await attach(tabId);
    let list = state(tabId).network;
    if (failedOnly) list = list.filter((n) => n.failed || (n.status && n.status >= 400));
    if (urlContains) list = list.filter((n) => n.url.includes(urlContains));
    list = list.slice(-limit);
    return {
      text: list.length
        ? list.map((n) => `${n.status ?? (n.failed ? 'FAIL' : '…')} ${n.method} ${n.type || ''} ${n.url.slice(0, 200)}${n.failed ? ` (${n.failed})` : ''}`).join('\n')
        : 'No matching requests (only captured since TabPilot attached to this tab).',
    };
  }),

  attach_files: tabTool(async (tabId, { ref, paths }) => {
    const objectId = await refObjectId(tabId, ref);
    await devtools(tabId, 'DOM.setFileInputFiles', { files: paths, objectId });
    const st = await settle(tabId, { timeoutMs: 3000 });
    return { text: `Attached ${paths.length} file(s) to ${ref}.\n${statusLine(st)}` };
  }),
};

