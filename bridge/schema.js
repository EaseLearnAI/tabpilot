// MCP tool definitions (names must match extension/tools.js).

import { z } from 'zod';

// Conversation identity (session / sessionTitle) is not part of the tool schemas: the MCP server
// adds it from the plugin hook's side channel (see common.js claimPending).

const tabId = z.coerce.number().int().describe('Tab id from group_status');
const ref = z.string().describe('Element ref from snapshot/locate, e.g. "e12"');

const task = z
  .string()
  .optional()
  .describe('Optional short name (2–6 words) for the tab group, e.g. "X 研究". By default the group is named after this conversation.');
const groupId = z.coerce.number().int().optional().describe('Target a specific TabPilot group (from group_status). Usually omit.');

export const TOOLS = [
  {
    name: 'group_status',
    description:
      'START HERE. Returns YOUR TabPilot tab group: one named, colored group per conversation, inside a dedicated window of the user\'s own logged-in Chrome ' +
      '(the user can watch and take over). Other conversations have their own groups — never touch them. ' +
      'Typical loop: group_status → goto (reuse the existing tab) → snapshot (refs like e12) → click / type / fill_form by ref → snapshot again. ' +
      'Prefer refs over x,y. Before irreversible actions (submit for review, publish, pay, delete, send) stop and get explicit user confirmation. ' +
      'ALWAYS call group_done when the browser part of the task is done, so the agent window stays tidy.',
    input: {
      task,
      autoCreate: z.boolean().optional().describe('Create the group if missing (default true)'),
      all: z.boolean().optional().describe('Also list the user\'s own tabs'),
    },
  },
  {
    name: 'tab_open',
    description:
      'Open a new tab in your group (optionally at a URL, waits for it to settle). Prefer navigating your existing tab; only open another tab when you need two pages at once. ' +
      'Each group holds at most 6 tabs — the least-recently-used one is closed automatically.',
    input: { url: z.string().optional(), task, groupId },
  },
  {
    name: 'tab_close',
    description: 'Close one tab (tabId) or a whole group (groupId). To finish your task use group_done.',
    input: { tabId: tabId.optional(), groupId },
  },
  {
    name: 'group_done',
    description:
      'Call when the browser part of the task is done: closes all tabs of your group. ' +
      'keep=true leaves them open (group collapsed and marked ✓, never auto-closed) — only when the user asked to see/continue on the page.',
    input: { keep: z.boolean().optional(), groupId },
  },
  {
    name: 'tab_adopt',
    description: 'Move one of the user\'s existing tabs (e.g. a page they already opened and logged into) into your group.',
    input: { tabId, task, groupId },
  },
  {
    name: 'goto',
    description:
      'Go to a URL (or "back" / "forward" / "reload") and wait until the page settles (load + network quiet + DOM quiet). ' +
      'Automatically reloads once if the page renders blank.',
    input: { tabId, url: z.string(), timeoutMs: z.coerce.number().optional() },
    timeoutMs: 120000,
  },
  {
    name: 'snapshot',
    description:
      'List the page as compact lines with stable refs: interactive elements with role, name and state (value, checked, disabled, required, invalid), ' +
      'plus headings and dialogs. filter="all" also includes visible text. Includes same-origin iframes and open shadow DOM.',
    input: {
      tabId,
      filter: z.enum(['interactive', 'all']).optional(),
      maxChars: z.coerce.number().optional(),
    },
  },
  {
    name: 'locate',
    description: 'Find elements whose role/name/state/text contain all words of the query (case-insensitive). Cheaper than a full snapshot on big pages.',
    input: { tabId, query: z.string(), limit: z.coerce.number().optional() },
  },
  {
    name: 'click',
    description:
      'Real mouse click on an element (by ref, scrolled into view, checked for overlays) or at x,y (CSS px, as in screenshot). ' +
      'force=true uses a DOM click when the element is covered.',
    input: {
      tabId,
      ref: ref.optional(),
      x: z.coerce.number().optional(),
      y: z.coerce.number().optional(),
      button: z.enum(['left', 'right', 'middle']).optional(),
      double: z.boolean().optional(),
      force: z.boolean().optional(),
    },
  },
  { name: 'hover', description: 'Move the mouse over an element or x,y.', input: { tabId, ref: ref.optional(), x: z.coerce.number().optional(), y: z.coerce.number().optional() } },
  {
    name: 'type',
    description:
      'Type text with real input events. With ref: focuses the field first (caret at end unless clear=true). clear=true replaces existing content. submit=true presses Enter after.',
    input: { tabId, text: z.string(), ref: ref.optional(), clear: z.boolean().optional(), submit: z.boolean().optional() },
  },
  {
    name: 'fill_form',
    description:
      'Fill several fields in one call and verify each by reading the value back. Handles text inputs, textareas, contenteditable, <select> (by value or visible text), ' +
      'checkboxes/radios/switches (value true/false). mode="type" (default) types like a human; "set" writes values directly (faster). Reports ✓/✗ per field.',
    input: {
      tabId,
      fields: z.array(z.object({ ref, value: z.union([z.string(), z.number(), z.boolean()]) })).min(1),
      mode: z.enum(['type', 'set']).optional(),
    },
  },
  {
    name: 'press_key',
    description: 'Press keys. Space-separated sequence; combos with +. Examples: "Enter", "Tab Tab", "cmd+a Backspace", "Escape".',
    input: { tabId, keys: z.string() },
  },
  {
    name: 'scroll',
    description: 'Scroll an element into view (ref) or scroll the page by amount×100px in a direction.',
    input: {
      tabId,
      ref: ref.optional(),
      direction: z.enum(['up', 'down', 'left', 'right']).optional(),
      amount: z.coerce.number().optional(),
    },
  },
  { name: 'read_text', description: 'Readable text of the page (main/article if present).', input: { tabId, maxChars: z.coerce.number().optional() } },
  { name: 'screenshot', description: 'Viewport screenshot in CSS pixels (coordinates usable by click x,y). Use when snapshot is not enough (canvas, cross-origin iframes, visual checks).', input: { tabId } },
  { name: 'evaluate', description: 'Run a JavaScript expression in the page and return the JSON result (awaits promises).', input: { tabId, expression: z.string() } },
  {
    name: 'wait_for',
    description: 'Wait until text (or a CSS selector) appears — or disappears with gone=true.',
    input: {
      tabId,
      text: z.string().optional(),
      selector: z.string().optional(),
      gone: z.boolean().optional(),
      timeoutMs: z.coerce.number().optional(),
    },
    timeoutMs: 120000,
  },
  { name: 'page_health', description: 'Diagnose a stuck/blank page: load state, blank detection, in-flight requests, console errors, failed requests.', input: { tabId } },
  {
    name: 'console_logs',
    description: 'Console messages and exceptions captured since TabPilot attached to the tab.',
    input: { tabId, regex: z.string().optional(), errorsOnly: z.boolean().optional(), limit: z.coerce.number().optional() },
  },
  {
    name: 'network_log',
    description: 'Network requests captured since TabPilot attached to the tab (status, method, url).',
    input: { tabId, urlContains: z.string().optional(), failedOnly: z.boolean().optional(), limit: z.coerce.number().optional() },
  },
  {
    name: 'attach_files',
    description: 'Attach local files (absolute paths) to an <input type=file> ref.',
    input: { tabId, ref, paths: z.array(z.string()).min(1) },
  },
  {
    name: 'reload_extension',
    description: 'Developer tool: reload the TabPilot extension so edited extension files take effect. Open tabs stay; refs become stale.',
    input: {},
  },
  { name: 'version', description: 'Report the running TabPilot extension version.', input: {} },
];
