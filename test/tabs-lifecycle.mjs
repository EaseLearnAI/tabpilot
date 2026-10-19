// Logic check for extension/tabs.js + the tab tools in extension/tools.js against a fake chrome API.
// Usage: node test/tabs-lifecycle.mjs   (no browser needed)
import assert from 'node:assert/strict';

let nextId = 100;
const tabs = new Map(); // id -> tab
const groups = new Map(); // id -> group
const windows = new Map();
const store = {};
const listeners = { created: [] };
const ok = (v) => Promise.resolve(v);
const groupTabs = (gid) => [...tabs.values()].filter((t) => t.groupId === gid);
function gcGroups() {
  for (const g of groups.values()) if (!groupTabs(g.id).length) groups.delete(g.id);
}

globalThis.chrome = {
  runtime: { getManifest: () => ({ version: 'test' }) },
  storage: {
    local: {
      get: async (k) => ({ [k]: store[k] && structuredClone(store[k]) }),
      set: async (o) => Object.assign(store, structuredClone(o)),
      remove: async (k) => delete store[k],
    },
  },
  windows: {
    create: async () => {
      const w = { id: nextId++, focused: false };
      windows.set(w.id, w);
      const t = { id: nextId++, windowId: w.id, url: 'about:blank', title: '', groupId: -1, active: true, lastAccessed: Date.now() };
      tabs.set(t.id, t);
      return { ...w, tabs: [t] };
    },
    get: async (id) => {
      if (!windows.has(id)) throw new Error('no window');
      return windows.get(id);
    },
  },
  tabs: {
    create: async ({ windowId, url, active }) => {
      const t = { id: nextId++, windowId, url, title: '', groupId: -1, active: !!active, lastAccessed: Date.now() + nextId };
      if (active) for (const o of tabs.values()) if (o.windowId === windowId) o.active = false;
      tabs.set(t.id, t);
      listeners.created.forEach((f) => f(t));
      return { ...t };
    },
    get: async (id) => {
      if (!tabs.has(id)) throw new Error(`No tab with id: ${id}`);
      return { ...tabs.get(id) };
    },
    query: async ({ groupId, windowId, active } = {}) =>
      [...tabs.values()]
        .filter((t) => (groupId == null || t.groupId === groupId) && (windowId == null || t.windowId === windowId) && (active == null || t.active === active))
        .map((t) => ({ ...t })),
    group: async ({ tabIds, groupId, createProperties }) => {
      let gid = groupId;
      if (gid == null) {
        gid = nextId++;
        groups.set(gid, { id: gid, title: '', color: 'grey', windowId: createProperties.windowId, collapsed: false });
      }
      for (const id of [].concat(tabIds)) tabs.get(id).groupId = gid;
      gcGroups();
      return gid;
    },
    update: async (id, p) => {
      const t = tabs.get(id);
      if (p.active) for (const o of tabs.values()) if (o.windowId === t.windowId) o.active = false;
      Object.assign(t, p, { lastAccessed: Date.now() + nextId++ });
      return { ...t };
    },
    move: async (id, { windowId }) => Object.assign(tabs.get(id), { windowId }),
    remove: async (ids) => {
      for (const id of [].concat(ids)) tabs.delete(id);
      gcGroups();
    },
    onCreated: { addListener: (f) => listeners.created.push(f), removeListener: (f) => (listeners.created = listeners.created.filter((x) => x !== f)) },
  },
  tabGroups: {
    get: async (id) => {
      if (!groups.has(id)) throw new Error(`No group with id: ${id}`);
      return { ...groups.get(id) };
    },
    update: async (id, p) => Object.assign(groups.get(id), p),
    query: async ({ title } = {}) => [...groups.values()].filter((g) => title == null || g.title === title),
  },
  debugger: { onDetach: { addListener() {} }, onEvent: { addListener() {} } },
};

const T = await import('../extension/tabs.js');
const { TOOLS } = await import('../extension/tools.js');
const titleOf = (gid) => groups.get(gid)?.title;
const gidOf = (text) => Number(/groupId (\d+)/.exec(text)?.[1]);

// 1. Two conversations → two groups, named after the conversation, different colors, same window.
let r = await TOOLS.group_status({ session: 'A', sessionTitle: '华为登录排查问题和修复方案' });
const gA = gidOf(r.text);
assert.equal(titleOf(gA), '华为登录排查问题和修复方案');
r = await TOOLS.group_status({ session: 'B', sessionTitle: '新对话' });
const gB = gidOf(r.text);
assert.notEqual(gA, gB);
assert.notEqual(groups.get(gA).color, groups.get(gB).color);
assert.equal(groups.get(gA).windowId, groups.get(gB).windowId);
assert.match(r.text, /Other TabPilot groups.*华为登录/);
console.log('✓ one group per conversation, named + colored');

// 2. Same conversation → same group; title fills in later; task overrides.
r = await TOOLS.group_status({ session: 'B', sessionTitle: 'X 研究' });
assert.equal(gidOf(r.text), gB);
assert.equal(titleOf(gB), 'X 研究');
await TOOLS.group_status({ session: 'B', task: '收藏与深度解析' });
assert.equal(titleOf(gB), '收藏与深度解析');
await TOOLS.group_status({ session: 'B', sessionTitle: 'X 研究' }); // weaker source must not override task
assert.equal(titleOf(gB), '收藏与深度解析');
console.log('✓ reuse + rename priority (task > session title)');

// 3. tab_open reuses the blank tab, then caps the group at maxTabs (LRU eviction).
r = await TOOLS.tab_open({ session: 'A' });
assert.equal(groupTabs(gA).length, 1, 'blank tab reused');
for (const t of groupTabs(gA)) t.url = 'https://example.com/0';
for (let i = 1; i <= 7; i++) {
  r = await TOOLS.tab_open({ session: 'A' });
  const id = Number(/tabId (\d+)/.exec(r.text)[1]);
  tabs.get(id).url = `https://example.com/${i}`;
}
assert.equal(groupTabs(gA).length, T.LIMITS.maxTabs);
assert.match(r.text, /closed least-recently-used/);
console.log(`✓ max ${T.LIMITS.maxTabs} tabs per group with LRU eviction`);

// 4. group_done closes the whole group; keep=true collapses + marks ✓ + exempts from reaper.
r = await TOOLS.group_done({ session: 'A' });
assert.match(r.text, /closed group/);
assert.equal(groups.has(gA), false);
r = await TOOLS.group_done({ session: 'A' });
assert.match(r.text, /Nothing to clean up/);
r = await TOOLS.group_done({ session: 'B', keep: true });
assert.equal(groups.get(gB).collapsed, true);
assert.ok(titleOf(gB).startsWith('✓'));
console.log('✓ group_done close / keep');

// 5. Idle reaper closes idle groups, skips kept ones.
r = await TOOLS.group_status({ session: 'C', sessionTitle: '支付宝 VPS 部署' });
const gC = gidOf(r.text);
store.tabpilotState.groups[gC].lastUsed = Date.now() - 31 * 60_000;
store.tabpilotState.groups[gB].lastUsed = Date.now() - 31 * 60_000;
const closed = await T.reapIdle();
assert.deepEqual(closed, ['支付宝 VPS 部署']);
assert.equal(groups.has(gC), false);
assert.equal(groups.has(gB), true, 'kept group survives');
console.log('✓ idle reaper (kept groups exempt)');

// 6. session_end closes that conversation's groups only.
r = await TOOLS.group_status({ session: 'D', sessionTitle: 'Memo Web 原型' });
const gD = gidOf(r.text);
r = await TOOLS.group_status({ session: 'E', sessionTitle: 'HTML 复刻' });
const gE = gidOf(r.text);
r = await TOOLS.session_end({ session: 'D' });
assert.equal(groups.has(gD), false);
assert.equal(groups.has(gE), true);
console.log('✓ session_end');

// 7. User renamed a group → no longer managed, never closed by us.
groups.get(gE).title = '我的东西';
store.tabpilotState.groups[gE].lastUsed = 0;
await T.reapIdle();
assert.equal(groups.has(gE), true);
r = await TOOLS.group_status({ session: 'E', sessionTitle: 'HTML 复刻' });
assert.notEqual(gidOf(r.text), gE, 'gets a fresh group');
console.log('✓ user takeover respected');

// 8. Long titles are truncated.
assert.equal(Array.from(T.cleanTitle('一二三四五六七八九十一二三四五六七八九十')).length, 18);
console.log('✓ title truncation\n\nall lifecycle checks passed');
