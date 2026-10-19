// Injected into the page via Runtime.evaluate (serialized with toString()).
// MUST be fully self-contained: no references to module scope.
// Installs window.__tp once per document; later calls are no-ops.

export function installHelper() {
  if (window.__tp && window.__tp.v === 1) return;

  const LIMIT = 25000;
  const refs = new Map();
  const ids = new WeakMap();
  let seq = 0;
  const st = { lastMutation: Date.now() };
  try {
    new MutationObserver(() => {
      st.lastMutation = Date.now();
    }).observe(document.documentElement || document, { subtree: true, childList: true });
  } catch (e) {
    /* ignore */
  }

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const q = (s) => JSON.stringify(s);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE']);
  const INPUT_ROLE = {
    checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button',
    image: 'button', range: 'slider', file: 'file', search: 'searchbox', number: 'spinbutton',
    color: 'button', hidden: null,
  };
  const INTERACTIVE = new Set([
    'link', 'button', 'textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'slider',
    'spinbutton', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'file', 'treeitem',
  ]);

  function refOf(el) {
    let r = ids.get(el);
    if (!r) {
      seq += 1;
      r = `e${seq}`;
      ids.set(el, r);
      refs.set(r, new WeakRef(el));
    }
    return r;
  }

  function resolve(ref) {
    const key = String(ref).replace(/^\[|\]$/g, '').trim();
    const w = refs.get(key);
    const el = w && w.deref();
    if (!el || !el.isConnected) throw new Error(`Ref ${key} is stale or unknown (the page changed). Call snapshot again.`);
    return el;
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0];
    const t = el.tagName;
    switch (t) {
      case 'A':
      case 'AREA':
        return el.hasAttribute('href') ? 'link' : null;
      case 'BUTTON':
      case 'SUMMARY':
        return 'button';
      case 'SELECT':
        return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      case 'TEXTAREA':
        return 'textbox';
      case 'INPUT': {
        const ty = (el.getAttribute('type') || 'text').toLowerCase();
        return ty in INPUT_ROLE ? INPUT_ROLE[ty] : 'textbox';
      }
      case 'IMG':
        return 'img';
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6':
        return 'heading';
      case 'DIALOG':
        return 'dialog';
      case 'OPTION':
        return 'option';
      case 'IFRAME':
      case 'FRAME':
        return 'iframe';
      default:
        break;
    }
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return 'textbox';
    return null;
  }

  function labelledBy(el) {
    const v = el.getAttribute('aria-labelledby');
    if (!v) return '';
    return clean(
      v.split(/\s+/).map((id) => {
        const n = el.ownerDocument.getElementById(id);
        return n ? n.innerText || n.textContent : '';
      }).join(' '),
    );
  }

  function nameOf(el) {
    const al = clean(el.getAttribute('aria-label'));
    if (al) return al;
    const lb = labelledBy(el);
    if (lb) return lb;
    const t = el.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') {
      if (el.labels && el.labels.length) {
        const s = clean([...el.labels].map((l) => l.innerText).join(' '));
        if (s) return s;
      }
      if (t === 'INPUT' && /^(button|submit|reset)$/i.test(el.type)) return clean(el.value) || el.type;
      return clean(el.getAttribute('placeholder') || el.getAttribute('aria-placeholder') || el.getAttribute('title') || el.getAttribute('name'));
    }
    if (t === 'IMG') return clean(el.getAttribute('alt') || el.getAttribute('title'));
    if (t === 'IFRAME' || t === 'FRAME') return clean(el.getAttribute('title') || el.getAttribute('name'));
    const txt = clean(el.innerText || el.textContent);
    if (txt) return txt;
    const img = el.querySelector && el.querySelector('img[alt]');
    const svgTitle = el.querySelector && el.querySelector('svg title');
    return clean(el.getAttribute('title') || (img && img.getAttribute('alt')) || (svgTitle && svgTitle.textContent));
  }

  function shortUrl(href) {
    try {
      const u = new URL(href);
      return u.origin === location.origin ? u.pathname + u.search : u.href;
    } catch (e) {
      return href;
    }
  }

  function stateOf(el) {
    const s = [];
    const t = el.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA') {
      const ty = (el.type || '').toLowerCase();
      if (ty === 'checkbox' || ty === 'radio') s.push(el.checked ? 'checked' : 'unchecked');
      else if (ty === 'password') s.push(el.value ? 'value=••••' : 'empty');
      else if (ty === 'file') s.push(el.files && el.files.length ? `files=${[...el.files].map((f) => f.name).join(',')}` : 'no file');
      else s.push(el.value ? `value=${q(cut(el.value, 80))}` : 'empty');
    } else if (t === 'SELECT') {
      const o = el.selectedOptions && el.selectedOptions[0];
      s.push(`selected=${q(o ? clean(o.text) : '')}`, `${el.options.length} options`);
    } else if (el.isContentEditable) {
      const v = clean(el.innerText);
      s.push(v ? `text=${q(cut(v, 80))}` : 'empty');
    }
    const ac = el.getAttribute('aria-checked');
    if (ac) s.push(ac === 'true' ? 'checked' : ac === 'false' ? 'unchecked' : `checked=${ac}`);
    const ae = el.getAttribute('aria-expanded');
    if (ae) s.push(ae === 'true' ? 'expanded' : 'collapsed');
    if (el.getAttribute('aria-selected') === 'true') s.push('selected');
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') s.push('disabled');
    if (el.required || el.getAttribute('aria-required') === 'true') s.push('required');
    if (el.getAttribute('aria-invalid') === 'true') s.push('invalid');
    if (t === 'A' && el.href && !el.href.startsWith('javascript:')) s.push(`→ ${cut(shortUrl(el.href), 80)}`);
    return s;
  }

  function dialogName(el) {
    const n = clean(el.getAttribute('aria-label')) || labelledBy(el);
    if (n) return n;
    const h = el.querySelector('h1,h2,h3,h4,[role=heading]');
    return h ? clean(h.innerText) : '';
  }

  // Walk the rendered DOM (incl. open shadow roots and same-origin iframes).
  function walk(opts) {
    const all = opts && opts.filter === 'all';
    const out = [];
    let visited = 0;
    const emit = (line, extra) => out.push({ line, hay: `${line} ${extra || ''}`.toLowerCase() });

    function visit(root, ctx) {
      const kids = root.children;
      if (!kids) return;
      for (let i = 0; i < kids.length; i++) {
        visited += 1;
        if (visited > LIMIT) return;
        const el = kids[i];
        const tag = el.tagName;
        if (SKIP.has(tag)) continue;
        let cs = null;
        const vis = el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : true;
        if (!vis) {
          cs = getComputedStyle(el);
          if (cs.display !== 'contents') continue;
        }
        if (el.getAttribute('aria-hidden') === 'true') continue;

        const role = roleOf(el);
        let interactive = !!role && INTERACTIVE.has(role);
        let pointer = ctx.pointer;
        if (!interactive && !ctx.inInteractive) {
          cs = cs || getComputedStyle(el);
          pointer = cs.cursor === 'pointer';
          if ((pointer && !ctx.pointer) || el.hasAttribute('onclick') || (el.hasAttribute('tabindex') && el.tabIndex >= 0)) {
            interactive = true;
          }
        }
        const isDialog = role === 'dialog' || role === 'alertdialog' || el.getAttribute('aria-modal') === 'true';
        const needRect = interactive || role === 'heading' || role === 'iframe' || isDialog || all;
        const r = needRect ? el.getBoundingClientRect() : null;
        const hasBox = !!r && (r.width > 0 || r.height > 0);
        const view = el.ownerDocument.defaultView || window;

        if (role === 'iframe') {
          if (!hasBox) continue;
          const ref = refOf(el);
          let doc = null;
          try {
            doc = el.contentDocument;
          } catch (e) {
            doc = null;
          }
          if (doc && doc.documentElement) {
            emit(`[${ref}] frame ${q(cut(nameOf(el) || el.src || '', 80))} {`);
            visit(doc.documentElement, { inInteractive: false, pointer: false });
            emit('}');
          } else {
            let host = '';
            try {
              host = new URL(el.src, location.href).host;
            } catch (e) {
              /* ignore */
            }
            emit(`[${ref}] iframe (cross-origin ${host}) at (${Math.round(r.left)},${Math.round(r.top)}) ${Math.round(r.width)}x${Math.round(r.height)} — inner elements are not in the snapshot; use screenshot + click x,y`);
          }
          continue;
        }

        if (role === 'heading' && hasBox) {
          const n = cut(nameOf(el), 120);
          const lvl = Number(el.getAttribute('aria-level')) || Number(tag[1]) || 2;
          if (n) emit(`${'#'.repeat(Math.min(Math.max(lvl, 1), 6))} ${n}`);
        } else if (isDialog && hasBox) {
          emit(`[dialog ${q(cut(dialogName(el), 80))}]`);
        } else if (interactive && hasBox) {
          const ref = refOf(el);
          const name = cut(nameOf(el), 100);
          const s = stateOf(el);
          const off = r.bottom < 0 || r.top > view.innerHeight || r.right < 0 || r.left > view.innerWidth;
          const line = `[${ref}] ${role || 'clickable'}${name ? ` ${q(name)}` : ''}${s.length ? ` (${s.join(', ')})` : ''}${off ? ' (offscreen)' : ''}`;
          emit(line, `${el.id || ''} ${el.getAttribute('name') || ''} ${el.getAttribute('placeholder') || ''}`);
        } else if (all && !ctx.inInteractive && hasBox) {
          let own = '';
          for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent;
          own = clean(own);
          if (own.length >= 2) emit(`[${refOf(el)}] text ${q(cut(own, 200))}`);
        }

        if (el instanceof view.SVGElement) continue;
        const childCtx = { inInteractive: ctx.inInteractive || interactive, pointer };
        if (el.shadowRoot) visit(el.shadowRoot, childCtx);
        visit(el, childCtx);
      }
    }

    if (document.documentElement) visit(document.documentElement, { inInteractive: false, pointer: false });
    return { entries: out, limited: visited > LIMIT };
  }

  function snapshot(opts) {
    const o = opts || {};
    const max = o.maxChars || 25000;
    const { entries, limited } = walk(o);
    let text = '';
    let truncated = limited;
    for (const e of entries) {
      if (text.length + e.line.length + 1 > max) {
        truncated = true;
        break;
      }
      text += `${e.line}\n`;
    }
    if (!entries.length) text = '(nothing interactive found — the page may still be loading; try wait_for or screenshot)\n';
    return {
      url: location.href,
      title: document.title,
      vw: innerWidth,
      vh: innerHeight,
      sy: Math.round(scrollY),
      sh: document.documentElement ? document.documentElement.scrollHeight : 0,
      truncated,
      count: entries.length,
      text,
    };
  }

  function locate(query, max) {
    const toks = clean(query).toLowerCase().split(' ').filter(Boolean);
    const { entries } = walk({ filter: 'all' });
    const hits = entries.filter((e) => e.line.startsWith('[e') && toks.every((t) => e.hay.includes(t)));
    return { count: hits.length, text: hits.slice(0, max || 30).map((e) => e.line).join('\n') };
  }

  function summarize(el) {
    if (!el) return 'nothing';
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : '';
    const txt = cut(clean(el.innerText || el.textContent), 40);
    return `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls}>${txt ? ` ${q(txt)}` : ''}`;
  }

  // Scroll into view (if needed) and return the click point in top-level viewport coords.
  function center(ref) {
    const el = resolve(ref);
    let r = el.getBoundingClientRect();
    const view = el.ownerDocument.defaultView || window;
    if (r.top < 0 || r.left < 0 || r.bottom > view.innerHeight || r.right > view.innerWidth) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      r = el.getBoundingClientRect();
    }
    const lx = r.left + r.width / 2;
    const ly = r.top + r.height / 2;
    let x = lx;
    let y = ly;
    let w = view;
    while (w && w !== window && w.frameElement) {
      const fr = w.frameElement.getBoundingClientRect();
      x += fr.left;
      y += fr.top;
      w = w.parent;
    }
    const root = el.getRootNode();
    const hit = (root.elementFromPoint ? root : el.ownerDocument).elementFromPoint(lx, ly);
    const ok = !!hit && (hit === el || el.contains(hit) || hit.contains(el));
    return { x, y, w: r.width, h: r.height, ok, hit: ok ? null : summarize(hit), label: summarize(el) };
  }

  function jsClick(ref) {
    resolve(ref).click();
    return true;
  }

  function focus(ref) {
    const el = resolve(ref);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus({ preventScroll: true });
    return el.ownerDocument.activeElement === el;
  }

  function caretEnd(ref) {
    const el = resolve(ref);
    try {
      if (typeof el.setSelectionRange === 'function') {
        const n = (el.value || '').length;
        el.setSelectionRange(n, n);
        return true;
      }
    } catch (e) {
      /* email/number inputs don't support selection */
    }
    if (el.isContentEditable) {
      const sel = el.ownerDocument.getSelection();
      const range = el.ownerDocument.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    return true;
  }

  function selectAll(ref) {
    const el = ref ? resolve(ref) : document.activeElement;
    if (!el) return false;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.focus();
      el.select();
      return true;
    }
    if (el.isContentEditable) {
      el.focus();
      const sel = el.ownerDocument.getSelection();
      const range = el.ownerDocument.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    }
    document.execCommand('selectAll');
    return true;
  }

  function fieldInfo(ref) {
    const el = resolve(ref);
    const t = el.tagName;
    const label = cut(nameOf(el), 60);
    const role = roleOf(el);
    if (t === 'SELECT') return { kind: 'select', label };
    if (t === 'TEXTAREA') return { kind: 'text', label };
    if (t === 'INPUT') {
      const ty = (el.type || 'text').toLowerCase();
      if (ty === 'checkbox' || ty === 'radio') return { kind: 'toggle', label, checked: el.checked };
      if (ty === 'file') return { kind: 'file', label };
      if (/^(button|submit|reset|image|hidden)$/.test(ty)) return { kind: 'other', label, role };
      return { kind: 'text', label, masked: ty === 'password' };
    }
    if (el.isContentEditable) return { kind: 'editable', label };
    if (role === 'checkbox' || role === 'switch' || role === 'radio' || role === 'menuitemcheckbox') {
      return { kind: 'toggle', label, checked: el.getAttribute('aria-checked') === 'true' };
    }
    return { kind: 'other', label, role: role || t.toLowerCase() };
  }

  function valueOf(ref) {
    const el = resolve(ref);
    if (el.tagName === 'SELECT') {
      const o = el.selectedOptions[0];
      return o ? clean(o.text) : '';
    }
    if (el.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(el.type)) return el.checked;
    if ('value' in el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return el.value;
    return clean(el.innerText);
  }

  // Framework-safe value set (React/Vue track the native setter + input event).
  function setValue(ref, value) {
    const el = resolve(ref);
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    el.focus();
    if (desc && desc.set) desc.set.call(el, String(value));
    else el.value = String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  }

  function selectOption(ref, value) {
    const el = resolve(ref);
    const v = String(value);
    const opts = [...el.options];
    const lv = v.toLowerCase();
    const o = opts.find((x) => x.value === v)
      || opts.find((x) => clean(x.text) === v)
      || opts.find((x) => clean(x.text).toLowerCase().includes(lv));
    if (!o) throw new Error(`Option ${q(v)} not found. Options: ${opts.map((x) => clean(x.text)).slice(0, 40).join(' | ')}`);
    el.focus();
    el.value = o.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return `selected=${q(clean(o.text))}`;
  }

  function blurActive() {
    const a = document.activeElement;
    if (a && a !== document.body && a.blur) a.blur();
    return true;
  }

  function revealRef(ref) {
    resolve(ref).scrollIntoView({ block: 'center', behavior: 'instant' });
    return scrollInfo();
  }

  function scrollInfo() {
    const de = document.documentElement;
    return { x: Math.round(scrollX), y: Math.round(scrollY), h: de ? de.scrollHeight : 0, vh: innerHeight };
  }

  function metrics() {
    return { vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio || 1 };
  }

  function isBlank() {
    const b = document.body;
    if (!b) return document.readyState === 'complete';
    if (clean(b.innerText).length > 20) return false;
    return !b.querySelector('img,svg,canvas,video,input,button,select,textarea,iframe,embed,object');
  }

  function status() {
    return {
      readyState: document.readyState,
      mutationQuietMs: Date.now() - st.lastMutation,
      url: location.href,
      title: document.title,
      blank: isBlank(),
    };
  }

  function text(maxChars) {
    const max = maxChars || 30000;
    const main = document.querySelector('main, [role=main], article');
    const src = main && clean(main.innerText).length > 200 ? main : document.body;
    const t = String((src && src.innerText) || '').replace(/\n{3,}/g, '\n\n').trim();
    return { url: location.href, title: document.title, truncated: t.length > max, text: t.slice(0, max) };
  }

  function check(o) {
    if (o.selector) {
      try {
        const el = document.querySelector(o.selector);
        if (!el) return false;
        return el.checkVisibility ? el.checkVisibility() : true;
      } catch (e) {
        throw new Error(`Invalid selector: ${o.selector}`);
      }
    }
    if (o.text) return !!document.body && document.body.innerText.includes(o.text);
    return document.readyState === 'complete';
  }

  window.__tp = {
    v: 1, resolve, snapshot, locate, center, jsClick, focus, caretEnd, selectAll, fieldInfo, valueOf,
    setValue, selectOption, blurActive, revealRef, scrollInfo, metrics, status, text, check,
  };
}
