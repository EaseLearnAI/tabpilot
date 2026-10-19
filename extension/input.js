// Trusted (isTrusted=true) mouse & keyboard input via CDP Input domain.

import { devtools } from './devtools.js';

const BUTTON_MASK = { left: 1, right: 2, middle: 4 };

export async function moveTo(tabId, x, y) {
  await devtools(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
}

export async function clickAt(tabId, x, y, { button = 'left', clickCount = 1 } = {}) {
  await moveTo(tabId, x, y);
  for (let i = 1; i <= clickCount; i++) {
    await devtools(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button, buttons: BUTTON_MASK[button] || 1, clickCount: i,
    });
    await devtools(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button, buttons: 0, clickCount: i,
    });
  }
}

export async function wheel(tabId, x, y, deltaX, deltaY) {
  await devtools(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
}

export async function insertText(tabId, text) {
  await devtools(tabId, 'Input.insertText', { text });
}

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};
const MODIFIERS = { alt: 1, option: 1, ctrl: 2, control: 2, cmd: 4, meta: 4, command: 4, shift: 8 };
// Editing shortcuts need explicit commands; CDP key events alone don't trigger them on macOS.
const COMMANDS = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo' };

function keyDef(k) {
  if (KEYS[k]) return KEYS[k];
  const named = Object.keys(KEYS).find((n) => n.toLowerCase() === k.toLowerCase());
  if (named) return KEYS[named];
  if (k.length === 1) {
    const up = k.toUpperCase();
    const code = /[a-z]/i.test(k) ? `Key${up}` : /[0-9]/.test(k) ? `Digit${k}` : '';
    return { key: k, code, keyCode: up.charCodeAt(0), text: k };
  }
  if (/^F\d{1,2}$/i.test(k)) {
    const n = Number(k.slice(1));
    return { key: `F${n}`, code: `F${n}`, keyCode: 111 + n };
  }
  throw new Error(`Unknown key "${k}"`);
}

// spec: space-separated sequence, each item a key or combo, e.g. "Tab Tab Enter", "cmd+a Backspace".
export async function pressKeys(tabId, spec) {
  for (const combo of String(spec).trim().split(/\s+/)) {
    const parts = combo.split('+');
    const main = parts.pop();
    let modifiers = 0;
    for (const p of parts) {
      const m = MODIFIERS[p.toLowerCase()];
      if (m == null) throw new Error(`Unknown modifier "${p}" in "${combo}"`);
      modifiers |= m;
    }
    const d = keyDef(main);
    const commands = (modifiers & 6) && COMMANDS[main.toLowerCase()] ? [COMMANDS[main.toLowerCase()]] : undefined;
    const hasText = !!d.text && !(modifiers & 7);
    const text = hasText ? (modifiers & 8 && d.text.length === 1 ? d.text.toUpperCase() : d.text) : undefined;
    const base = { modifiers, key: d.key, code: d.code, windowsVirtualKeyCode: d.keyCode, nativeVirtualKeyCode: d.keyCode };
    await devtools(tabId, 'Input.dispatchKeyEvent', {
      ...base, type: hasText ? 'keyDown' : 'rawKeyDown', text, unmodifiedText: text, commands,
    });
    await devtools(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  }
}
