// Agent tab groups.
//
// v0.3: one named, colored group per agent conversation ("session") or task, all inside
// one dedicated agent window. Groups are cleaned up:
//   - explicitly by group_done / tab_close(groupId),
//   - when the conversation ends (plugin SessionEnd hook → session_end),
//   - by an idle reaper (no tool call on the group for IDLE_MINUTES),
//   - and each group is capped at MAX_TABS (least-recently-used tab is closed first).
// Tabs the user drags out of a group are no longer managed and are never closed by us.

const KEY = 'tabpilotState'; // { windowId, groups: { [groupId]: Meta } }
export const LIMITS = { maxTabs: 6, idleMinutes: 30 };
const COLORS = ['blue', 'green', 'purple', 'orange', 'cyan', 'pink', 'red', 'yellow', 'grey'];
const DEFAULT_TITLE = 'MCode';
const MAX_TITLE = 18;

// Title sources, weakest → strongest. A stronger source may replace a weaker title.
export const RANK = { default: 0, host: 1, session: 2, task: 3 };

// Meta: { title, rank, session, color, created, lastUsed, kept }

let lock = Promise.resolve();
function locked(fn) {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

async function loadRaw() {
  const s = (await chrome.storage.local.get(KEY))[KEY];
  return s && typeof s === 'object' ? { windowId: s.windowId ?? null, groups: s.groups || {} } : { windowId: null, groups: {} };
}
async function save(s) {
  await chrome.storage.local.set({ [KEY]: s });
}

// Drop metadata for groups that no longer exist. Group ids are only unique per browser
// session, so also require the live title to match — never adopt a user's own group.
async function load() {
  const s = await loadRaw();
  let dirty = false;
  for (const [gid, meta] of Object.entries(s.groups)) {
    let g = null;
    try {
      g = await chrome.tabGroups.get(Number(gid));
    } catch {
      /* gone */
    }
    if (!g || g.title !== meta.title) {
      delete s.groups[gid];
      dirty = true;
    }
  }
  if (dirty) await save(s);
  return s;
}

export function cleanTitle(t) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const chars = Array.from(s);
  return chars.length > MAX_TITLE ? `${chars.slice(0, MAX_TITLE - 1).join('')}…` : s;
}

function pickColor(s) {
  const used = new Map(COLORS.map((c) => [c, 0]));
  for (const m of Object.values(s.groups)) used.set(m.color, (used.get(m.color) || 0) + 1);
  return COLORS.reduce((best, c) => (used.get(c) < used.get(best) ? c : best), COLORS[0]);
}

async function agentWindow(s) {
  if (s.windowId != null) {
    try {
      const w = await chrome.windows.get(s.windowId, { populate: true });
      if (w) return { windowId: w.id, fresh: null };
    } catch {
      /* closed */
    }
  }
  // A separate window: agent tabs stay visible (not throttled) and never steal the user's tabs.
  const win = await chrome.windows.create({ url: 'about:blank', focused: false, width: 1400, height: 900, type: 'normal' });
  s.windowId = win.id;
  return { windowId: win.id, fresh: win.tabs[0] };
}

async function groupTabs(groupId) {
  return chrome.tabs.query({ groupId: Number(groupId) });
}

export async function describeGroup(groupId, meta) {
  const tabs = await groupTabs(groupId);
  return { groupId: Number(groupId), meta, tabs };
}

// Find the group for a call. Order: explicit groupId → this conversation's group → task title.
// `naming` = { task, sessionTitle } is used to create or (re)name the group.
export function resolveGroup({ groupId, session, task, sessionTitle, create = true } = {}) {
  return locked(async () => {
    const s = await load();
    const entries = Object.entries(s.groups);
    let gid = null;
    if (groupId != null && s.groups[groupId]) gid = String(groupId);
    if (!gid && session) gid = entries.find(([, m]) => m.session === session)?.[0] ?? null;
    const t = cleanTitle(task);
    if (!gid && t) gid = entries.find(([, m]) => !m.session && m.title === t)?.[0] ?? null;
    // No identity at all (plugin hook not active, no task): reuse the most recent anonymous group.
    if (!gid && !session && !t && groupId == null) {
      gid = entries.filter(([, m]) => !m.session).sort((a, b) => b[1].lastUsed - a[1].lastUsed)[0]?.[0] ?? null;
    }

    if (gid) {
      const meta = s.groups[gid];
      meta.lastUsed = Date.now();
      if (meta.kept && (task || sessionTitle)) meta.kept = false; // reused → managed again
      await maybeRename(gid, meta, { task, sessionTitle });
      await save(s);
      return describeGroup(gid, meta);
    }
    if (!create) return null;

    const { windowId, fresh } = await agentWindow(s);
    const tab = fresh || (await chrome.tabs.create({ windowId, url: 'about:blank', active: true }));
    const newId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId } });
    let title = DEFAULT_TITLE;
    let rank = RANK.default;
    if (t) {
      title = t;
      rank = RANK.task;
    } else if (cleanTitle(sessionTitle)) {
      title = cleanTitle(sessionTitle);
      rank = RANK.session;
    }
    const meta = { title, rank, session: session || null, color: pickColor(s), created: Date.now(), lastUsed: Date.now(), kept: false };
    await chrome.tabGroups.update(newId, { title, color: meta.color, collapsed: false });
    s.groups[String(newId)] = meta;
    await save(s);
    return describeGroup(newId, meta);
  });
}

async function maybeRename(gid, meta, { task, sessionTitle, host }) {
  let next = null;
  let rank = meta.rank ?? RANK.default;
  const t = cleanTitle(task);
  const st = cleanTitle(sessionTitle);
  if (t && (RANK.task > rank || (RANK.task === rank && t !== meta.title))) [next, rank] = [t, RANK.task];
  else if (st && (RANK.session > rank || (RANK.session === rank && st !== meta.title))) [next, rank] = [st, RANK.session];
  else if (host && RANK.host > rank) [next, rank] = [cleanTitle(host), RANK.host];
  if (!next || next === meta.title) return false;
  try {
    await chrome.tabGroups.update(Number(gid), { title: next });
    meta.title = next;
    meta.rank = rank;
    return true;
  } catch {
    return false;
  }
}

// Managed group a tab belongs to (or null).
export function groupOfTab(tabId) {
  return locked(async () => {
    const s = await load();
    try {
      const t = await chrome.tabs.get(tabId);
      return s.groups[t.groupId] ? { groupId: t.groupId, meta: s.groups[t.groupId] } : null;
    } catch {
      return null;
    }
  });
}

// Record activity on a tab's group; optionally improve its title (host after navigation,
// session title once the conversation gets one).
export function touchTab(tabId, naming = {}) {
  return locked(async () => {
    const s = await loadRaw();
    let t;
    try {
      t = await chrome.tabs.get(tabId);
    } catch {
      return;
    }
    const meta = s.groups[t.groupId];
    if (!meta) return;
    meta.lastUsed = Date.now();
    // Only fill in a session title for the conversation that owns the group.
    const sessionTitle = naming.session && naming.session === meta.session ? naming.sessionTitle : null;
    await maybeRename(t.groupId, meta, { sessionTitle, host: naming.host });
    await save(s);
  });
}

// Close least-recently-used tabs so the group has room for `incoming` more.
async function evict(groupId, incoming, keepIds = []) {
  const tabs = await groupTabs(groupId);
  const over = tabs.length + incoming - LIMITS.maxTabs;
  if (over <= 0) return [];
  const victims = tabs
    .filter((t) => !keepIds.includes(t.id))
    .sort((a, b) => (a.active ? 1 : 0) - (b.active ? 1 : 0) || (a.lastAccessed || 0) - (b.lastAccessed || 0))
    .slice(0, over);
  if (!victims.length) return [];
  await chrome.tabs.remove(victims.map((t) => t.id));
  return victims.map((t) => ({ id: t.id, title: t.title, url: t.url }));
}

// New tab inside the group. Reuses the group's untouched about:blank tab when there is one.
export async function createTab(group) {
  const tabs = await groupTabs(group.groupId);
  const blank = tabs.find((t) => (t.url === 'about:blank' || t.url === '') && (!t.pendingUrl || t.pendingUrl === 'about:blank'));
  if (blank) {
    await chrome.tabs.update(blank.id, { active: true });
    return { tab: await chrome.tabs.get(blank.id), evicted: [] };
  }
  const evicted = await evict(group.groupId, 1);
  const windowId = (await chrome.tabGroups.get(group.groupId)).windowId;
  const tab = await chrome.tabs.create({ windowId, url: 'about:blank', active: true });
  await chrome.tabs.group({ tabIds: [tab.id], groupId: group.groupId });
  return { tab, evicted };
}

export async function adoptTab(tabId, group) {
  const g = await chrome.tabGroups.get(group.groupId);
  const tab = await chrome.tabs.get(tabId);
  if (tab.groupId === g.id) return { tab, evicted: [] };
  const evicted = await evict(g.id, 1, [tabId]);
  if (tab.windowId !== g.windowId) await chrome.tabs.move(tabId, { windowId: g.windowId, index: -1 });
  await chrome.tabs.group({ tabIds: [tabId], groupId: g.id });
  await chrome.tabs.update(tabId, { active: true });
  return { tab: await chrome.tabs.get(tabId), evicted };
}

// Finish a group: close all its tabs, or keep them (collapsed, marked ✓, excluded from cleanup).
export function finishGroup(groupId, { keep = false } = {}) {
  return locked(async () => {
    const s = await loadRaw();
    const meta = s.groups[groupId];
    if (!meta) throw new Error(`Group ${groupId} is not a TabPilot group (already closed?).`);
    const tabs = await groupTabs(groupId);
    if (keep) {
      meta.kept = true;
      const title = meta.title.startsWith('✓') ? meta.title : cleanTitle(`✓ ${meta.title}`);
      await chrome.tabGroups.update(Number(groupId), { title, collapsed: true });
      meta.title = title;
      await save(s);
      return { closed: 0, kept: tabs.length, title };
    }
    delete s.groups[groupId];
    await save(s);
    if (tabs.length) await chrome.tabs.remove(tabs.map((t) => t.id)).catch(() => {});
    return { closed: tabs.length, kept: 0, title: meta.title };
  });
}

export async function listGroups() {
  const s = await load();
  const out = [];
  for (const [gid, meta] of Object.entries(s.groups)) out.push(await describeGroup(gid, meta));
  return out;
}

export async function groupsOfSession(session) {
  const s = await load();
  return Object.entries(s.groups)
    .filter(([, m]) => m.session === session)
    .map(([gid, m]) => ({ groupId: Number(gid), meta: m }));
}

// Is the user looking at this group right now? (agent window focused + its active tab is in the group)
async function userIsViewing(groupId) {
  try {
    const g = await chrome.tabGroups.get(Number(groupId));
    const w = await chrome.windows.get(g.windowId);
    if (!w.focused) return false;
    const [active] = await chrome.tabs.query({ windowId: g.windowId, active: true });
    return active?.groupId === g.id;
  } catch {
    return false;
  }
}

// Idle cleanup. Kept groups and the group the user is currently looking at are skipped.
export async function reapIdle() {
  const s = await load();
  const now = Date.now();
  const closed = [];
  for (const [gid, meta] of Object.entries(s.groups)) {
    if (meta.kept) continue;
    if (now - (meta.lastUsed || 0) < LIMITS.idleMinutes * 60_000) continue;
    if (await userIsViewing(gid)) {
      meta.lastUsed = now; // check again later
      await locked(async () => {
        const cur = await loadRaw();
        if (cur.groups[gid]) cur.groups[gid].lastUsed = now;
        await save(cur);
      });
      continue;
    }
    try {
      await finishGroup(gid);
      closed.push(meta.title);
    } catch {
      /* already gone */
    }
  }
  return closed;
}

// Bring a managed tab to the front of the agent window (never touches the user's own windows).
export async function activateIfManaged(tabId) {
  try {
    const s = await loadRaw();
    const t = await chrome.tabs.get(tabId);
    if (!t.active && s.groups[t.groupId]) await chrome.tabs.update(tabId, { active: true });
  } catch {
    /* tab gone; the tool call will report it */
  }
}

// After an update from v0.2: adopt the old single "MCode" group so the reaper cleans it up.
export async function adoptLegacyGroups() {
  await locked(async () => {
    const s = await loadRaw();
    const groups = await chrome.tabGroups.query({ title: DEFAULT_TITLE });
    for (const g of groups) {
      if (s.groups[g.id]) continue;
      s.groups[String(g.id)] = { title: g.title, rank: RANK.default, session: null, color: g.color, created: Date.now(), lastUsed: Date.now(), kept: false };
      if (s.windowId == null) s.windowId = g.windowId;
    }
    await save(s);
  });
}

// Browser restart: group/window ids change. Re-attach stored groups to restored groups with the
// same title + color (session restore); forget the rest. Never claims a user group otherwise.
export async function remapAfterRestart() {
  await locked(async () => {
    const s = await loadRaw();
    const live = await chrome.tabGroups.query({});
    const next = { windowId: null, groups: {} };
    for (const meta of Object.values(s.groups)) {
      const g = live.find((x) => x.title === meta.title && x.color === meta.color && !next.groups[x.id]);
      if (!g) continue;
      next.groups[String(g.id)] = { ...meta, lastUsed: Date.now() };
      next.windowId = g.windowId;
    }
    await save(next);
  });
}
