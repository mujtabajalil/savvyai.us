/**
 * Page-side DOM readers, shipped to camofox as `/evaluate` expressions.
 *
 * Why this exists: camofox has no "wait for selector", no bulk field read, and
 * no validation-error reader, and its snapshot is capped at 80k chars — which
 * the EZLynx drivers/vehicles/carrier-questions pages blow straight past. All
 * *reading* therefore happens here. All *acting* stays on /click and /type so
 * Angular still receives real input events with Playwright's actionability
 * checks (see controls.ts).
 *
 * Selectors reaching these readers must be plain CSS. The recording also
 * contains Playwright pseudo-selectors (`a:has-text(...)`, `:text-is(...)`)
 * which `document.querySelector` throws on; `isCssSelector()` screens them out.
 */

export type ControlKind =
  | 'native-select'
  | 'mat-select'
  | 'mat-autocomplete'
  | 'text'
  | 'textarea'
  | 'radio'
  | 'checkbox'
  | 'toggle'
  | 'button'
  | 'unknown';

export interface ControlState {
  found: boolean;
  kind: ControlKind;
  /** The selector that was asked for. */
  selector: string;
  /** Where the actionable control actually is — differs when the id is on a wrapper. */
  resolvedSelector: string;
  id: string | null;
  value: string;
  checked: boolean | null;
  disabled: boolean;
  required: boolean;
  visible: boolean;
  label: string;
  error: string | null;
  matches: number;
}

export interface OptionItem {
  index: number;
  id: string | null;
  text: string;
  disabled: boolean;
  selected: boolean;
}

export interface StepScan {
  url: string;
  controls: ControlState[];
  errors: Array<{ text: string; forId: string | null }>;
  carrierRequirements: string[];
  notices: string[];
}

/** U+2028/U+2029 are valid in JSON strings but are line terminators in JS source. */
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

const PLAYWRIGHT_PSEUDO = /:(?:has-text|text-is|text-matches|has|is-visible|nth-match)\s*\(/i;

/** The recording mixes CSS and Playwright dialects; only CSS is safe here. */
export function isCssSelector(selector: string): boolean {
  return !PLAYWRIGHT_PSEUDO.test(selector) && !selector.startsWith('text=') && !selector.startsWith('xpath=');
}

export function assertCssSelector(selector: string): void {
  if (!isCssSelector(selector)) {
    throw new Error(
      `Selector "${selector}" is a Playwright pseudo-selector and cannot be used by the DOM reader. ` +
        'Resolve it to a stable id/CSS selector first, or drive it through /click only.',
    );
  }
}

/** JSON is a JS-literal subset apart from these two separators. */
function literal(value: unknown): string {
  return JSON.stringify(value ?? null)
    .split(LINE_SEPARATOR)
    .join('\\u2028')
    .split(PARAGRAPH_SEPARATOR)
    .join('\\u2029');
}

const PRELUDE = /* js */ `
const esc = (s) => { try { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\\w-]/g, (c) => '\\\\' + c); } catch { return s; } };
const txt = (el) => (el && el.textContent ? el.textContent.replace(/\\s+/g, ' ').trim() : '');
const vis = (el) => {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
};
const q = (sel) => { try { return document.querySelector(sel); } catch { return null; } };
const qa = (sel) => { try { return Array.from(document.querySelectorAll(sel)); } catch { return []; } };
const formField = (el) => el && el.closest ? el.closest('mat-form-field, .mat-mdc-form-field, .form-field, .field') : null;
const labelOf = (el) => {
  if (!el) return '';
  const ff = formField(el);
  const ml = ff && ff.querySelector('mat-label, label');
  if (ml) return txt(ml);
  if (el.id) { const l = q('label[for="' + esc(el.id) + '"]'); if (l) return txt(l); }
  const al = el.getAttribute && el.getAttribute('aria-label');
  return al || '';
};
const errorOf = (el) => {
  const ff = formField(el);
  if (!ff) return null;
  const e = ff.querySelector('mat-error, .mat-mdc-form-field-error, .field-error, [role="alert"]');
  const t = txt(e);
  return t || null;
};
const kindOf = (el) => {
  if (!el) return 'unknown';
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'select') return 'native-select';
  if (tag === 'mat-select') return 'mat-select';
  if (tag === 'textarea') return 'textarea';
  if (tag === 'mat-slide-toggle' || tag === 'mat-checkbox') return tag === 'mat-checkbox' ? 'checkbox' : 'toggle';
  if (tag === 'input') {
    const t = (el.getAttribute('type') || 'text').toLowerCase();
    if (t === 'radio') return 'radio';
    if (t === 'checkbox') return 'checkbox';
    // Playwright refuses to fill these, so do not call them text — report
    // 'unknown' and let resolveActionable look for the real control nearby.
    if (['hidden', 'button', 'submit', 'reset', 'image', 'file', 'range', 'color'].includes(t)) return 'unknown';
    if (el.getAttribute('role') === 'combobox' || el.hasAttribute('aria-autocomplete')) return 'mat-autocomplete';
    return 'text';
  }
  if (tag === 'button') {
    if (el.hasAttribute('aria-checked') || el.hasAttribute('aria-pressed')) return 'toggle';
    return 'button';
  }
  if (el.getAttribute && el.getAttribute('role') === 'combobox') return 'mat-select';
  if (el.getAttribute && (el.getAttribute('role') === 'switch' || el.hasAttribute('aria-checked'))) return 'toggle';
  return 'unknown';
};
const valueOf = (el, kind) => {
  if (!el) return '';
  if (kind === 'native-select') {
    const o = el.selectedOptions && el.selectedOptions[0];
    return o ? (o.label || o.textContent || '').trim() : '';
  }
  if (kind === 'mat-select') {
    const v = el.querySelector('.mat-mdc-select-value, [id^="mat-select-value"]');
    const t = txt(v);
    return t === '--Select--' ? '' : t;
  }
  if (kind === 'radio' || kind === 'checkbox') return el.checked ? 'true' : 'false';
  if (kind === 'toggle') {
    const a = el.getAttribute('aria-checked') || el.getAttribute('aria-pressed');
    if (a != null) return a === 'true' ? 'true' : 'false';
    const inner = el.querySelector && el.querySelector('input');
    return inner && inner.checked ? 'true' : 'false';
  }
  if ('value' in el && typeof el.value === 'string') return el.value;
  return txt(el);
};
const checkedOf = (el, kind) => {
  if (kind === 'radio' || kind === 'checkbox') return !!el.checked;
  if (kind === 'toggle') return valueOf(el, kind) === 'true';
  return null;
};
const disabledOf = (el) => {
  if (!el) return true;
  if (el.disabled) return true;
  if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
  return !!(el.classList && el.classList.contains('mat-mdc-select-disabled'));
};
// Some EZLynx ids sit on a WRAPPER rather than the control itself — the
// co-applicant block is like this, where #contact-first-name-0 is a container.
// Acting on the wrapper produces "not fillable" or "dropdown did not open", so
// descend to the first actionable descendant and report a selector that reaches it.
const INNER_CONTROL = 'input:not([type="hidden"]), textarea, mat-select, select, [role="combobox"]';
const resolveActionable = (el, sel) => {
  const kind = kindOf(el);
  if (kind !== 'unknown' && kind !== 'button') return { el, selector: sel };

  // 1. a real control inside the matched element (id sits on a wrapper)
  const inner = el.querySelector ? el.querySelector(INNER_CONTROL) : null;
  if (inner) {
    return { el: inner, selector: inner.id ? '#' + esc(inner.id) : sel + ' ' + inner.tagName.toLowerCase() };
  }

  // 2. a visible sibling control in the same form field (id sits on a hidden
  //    input that mirrors the visible one — common in Angular Material)
  const ff = formField(el);
  if (ff) {
    const candidates = Array.from(ff.querySelectorAll(INNER_CONTROL))
      .filter((c) => c !== el && vis(c) && kindOf(c) !== 'unknown');
    if (candidates.length) {
      const pick = candidates[0];
      return { el: pick, selector: pick.id ? '#' + esc(pick.id) : sel };
    }
  }

  return { el, selector: sel };
};
const describe = (sel) => {
  const all = qa(sel);
  const matched = all[0] || null;
  if (!matched) return { found: false, kind: 'unknown', selector: sel, resolvedSelector: sel, id: null, value: '', checked: null, disabled: true, required: false, visible: false, label: '', error: null, matches: 0 };

  const { el, selector } = resolveActionable(matched, sel);
  const kind = kindOf(el);
  return {
    found: true, kind, selector: sel, resolvedSelector: selector, id: el.id || null,
    value: valueOf(el, kind), checked: checkedOf(el, kind), disabled: disabledOf(el),
    required: el.required === true || el.getAttribute('aria-required') === 'true',
    visible: vis(el), label: labelOf(el) || labelOf(matched), error: errorOf(el) || errorOf(matched),
    matches: all.length,
  };
};
// Locate the open option panel.
//
// Do NOT scope this to '.cdk-overlay-container .cdk-overlay-pane'. EZLynx renders
// select panels with position:static OUTSIDE the overlay container, leaving that
// container empty — a descendant query silently finds nothing and every dropdown
// looks like it failed to open. Prefer the panel the control names via aria-owns.
const openPanelFor = (sel) => {
  if (sel) {
    const ctl = q(sel);
    const owns = ctl && (ctl.getAttribute('aria-owns') || ctl.getAttribute('aria-controls'));
    if (owns) {
      const byId = document.getElementById(owns);
      if (byId) return byId;
    }
  }
  const panels = qa('.mat-mdc-select-panel, .mat-select-panel, .mat-mdc-autocomplete-panel, [role="listbox"]').filter(vis);
  if (panels.length) return panels[panels.length - 1];
  const panes = qa('.cdk-overlay-pane').filter(vis);
  return panes[panes.length - 1] || null;
};
const openPanelOptions = (sel) => {
  const pane = openPanelFor(sel);
  if (!pane) return [];
  const opts = Array.from(pane.querySelectorAll('mat-option, [role="option"]'));
  return opts.map((o, i) => ({
    index: i,
    id: o.id || null,
    text: txt(o.querySelector('.mdc-list-item__primary-text, .mat-option-text') || o),
    disabled: o.getAttribute('aria-disabled') === 'true' || o.classList.contains('mat-mdc-option-disabled'),
    selected: o.getAttribute('aria-selected') === 'true',
  }));
};
const anyPanelOpen = () => {
  if (qa('[aria-expanded="true"]').some((el) => /mat-select|combobox/i.test(el.tagName + ' ' + (el.getAttribute('role') || '')))) return true;
  return qa('.mat-mdc-select-panel, .mat-select-panel, [role="listbox"]').some(vis);
};
`;

function expr(body: string, args: unknown): string {
  return `(async (A) => { ${PRELUDE}\n${body} })(${literal(args)})`;
}

/** Classify a control and read its current state. */
export function describeControlExpr(selector: string): string {
  assertCssSelector(selector);
  return expr('return describe(A.selector);', { selector });
}

export function describeManyExpr(selectors: string[]): string {
  selectors.forEach(assertCssSelector);
  return expr('return A.selectors.map(describe);', { selectors });
}

/** Everything on the step: controls, errors, carrier requirements, notices. */
export function scanStepExpr(options: { container?: string; extraSelectors?: string[] } = {}): string {
  if (options.container) assertCssSelector(options.container);
  (options.extraSelectors ?? []).forEach(assertCssSelector);

  return expr(
    /* js */ `
    const root = A.container ? q(A.container) : document;
    const scope = root || document;
    const nodes = Array.from(scope.querySelectorAll('input, select, textarea, mat-select, mat-slide-toggle, mat-checkbox, [role="combobox"], [role="switch"]'));
    const seen = new Set();
    const controls = [];
    for (const el of nodes) {
      if (el.type === 'hidden') continue;
      const sel = el.id ? '#' + esc(el.id) : null;
      const key = sel || (el.getAttribute('name') ? '[name="' + el.getAttribute('name') + '"]#' + controls.length : 'idx#' + controls.length);
      if (seen.has(key)) continue;
      seen.add(key);
      const kind = kindOf(el);
      controls.push({
        found: true, kind, selector: sel || key, id: el.id || null,
        value: valueOf(el, kind), checked: checkedOf(el, kind), disabled: disabledOf(el),
        required: el.required === true || el.getAttribute('aria-required') === 'true',
        visible: vis(el), label: labelOf(el), error: errorOf(el), matches: 1,
      });
    }
    for (const sel of (A.extraSelectors || [])) {
      const d = describe(sel);
      if (d.found) controls.push(d);
    }

    const errors = [];
    for (const e of Array.from(scope.querySelectorAll('mat-error, .mat-mdc-form-field-error, .field-error, [role="alert"]'))) {
      const t = txt(e);
      if (!t || !vis(e)) continue;
      const ff = formField(e);
      const ctl = ff && ff.querySelector('input, select, textarea, mat-select');
      errors.push({ text: t, forId: ctl && ctl.id ? ctl.id : null });
    }

    const carrierRequirements = [];
    for (const e of Array.from(scope.querySelectorAll('*'))) {
      if (e.children.length) continue;
      const t = txt(e);
      if (/^Required for Carrier\\s*:/i.test(t) && vis(e)) carrierRequirements.push(t);
    }

    const notices = Array.from(document.querySelectorAll('.mat-mdc-snack-bar-label, .toast-message, .notice, [role="status"]'))
      .map(txt).filter(Boolean);

    return {
      url: location.href,
      controls,
      errors,
      carrierRequirements: Array.from(new Set(carrierRequirements)),
      notices: Array.from(new Set(notices)),
    };
  `,
    { container: options.container ?? null, extraSelectors: options.extraSelectors ?? [] },
  );
}

/**
 * Options in the open panel. Pass the owning control's selector so the panel is
 * resolved via its `aria-owns` rather than by guessing at the last overlay.
 */
export function openPanelOptionsExpr(owner?: string): string {
  if (owner) assertCssSelector(owner);
  return expr('return openPanelOptions(A.owner);', { owner: owner ?? null });
}

/** True once the panel is open with at least one option rendered. */
export function waitForPanelExpr(timeoutMs: number, owner?: string): string {
  if (owner) assertCssSelector(owner);
  return expr(
    /* js */ `
    const deadline = Date.now() + A.timeoutMs;
    while (Date.now() < deadline) {
      const opts = openPanelOptions(A.owner);
      if (opts.length) return { ok: true, options: opts };
      await new Promise((r) => setTimeout(r, 60));
    }
    return { ok: false, options: [], expanded: (() => {
      const c = A.owner ? q(A.owner) : null;
      return c ? c.getAttribute('aria-expanded') : null;
    })() };
  `,
    { timeoutMs, owner: owner ?? null },
  );
}

/** Bring a control into view; below-the-fold elements report as not visible. */
export function scrollIntoViewExpr(selector: string): string {
  assertCssSelector(selector);
  return expr(
    `const el = q(A.selector);
     if (!el) return false;
     el.scrollIntoView({ block: 'center', inline: 'nearest' });
     await new Promise((r) => setTimeout(r, 250));
     return vis(el);`,
    { selector },
  );
}

/** Why does a control read as not visible? Diagnostic only. */
export function visibilityReportExpr(selector: string): string {
  assertCssSelector(selector);
  return expr(
    `const el = q(A.selector);
     if (!el) return { exists: false };
     const r = el.getBoundingClientRect();
     const cs = getComputedStyle(el);
     const hiddenAncestor = (() => {
       let n = el.parentElement, d = 0;
       while (n && d < 15) {
         const s = getComputedStyle(n);
         if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') {
           return n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + ' {' + s.display + '/' + s.visibility + '/' + s.opacity + '}';
         }
         n = n.parentElement; d++;
       }
       return null;
     })();
     return {
       exists: true,
       size: Math.round(r.width) + 'x' + Math.round(r.height),
       display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
       offscreen: r.bottom < 0 || r.top > innerHeight,
       hiddenAncestor,
     };`,
    { selector },
  );
}

/** Is any option panel currently open (and therefore covering the page)? */
export function anyPanelOpenExpr(): string {
  return expr('return anyPanelOpen() || qa(".cdk-overlay-backdrop").filter(vis).length > 0;', {});
}

export function panelClosedExpr(timeoutMs: number): string {
  return expr(
    /* js */ `
    const deadline = Date.now() + A.timeoutMs;
    while (Date.now() < deadline) {
      if (!anyPanelOpen()) return true;
      await new Promise((r) => setTimeout(r, 60));
    }
    return false;
  `,
    { timeoutMs },
  );
}

export type WaitCondition =
  | { type: 'exists'; selector: string }
  | { type: 'visible'; selector: string }
  | { type: 'gone'; selector: string }
  | { type: 'value-not-empty'; selector: string }
  | { type: 'value-equals'; selector: string; value: string }
  | { type: 'value-changed'; selector: string; from: string }
  | { type: 'count-at-least'; selector: string; count: number };

/**
 * Poll a condition in-page. Bounded well under the server's 30s handler timeout;
 * longer waits are chunked by waits.ts.
 */
export function waitForExpr(condition: WaitCondition, timeoutMs: number): string {
  assertCssSelector(condition.selector);
  return expr(
    /* js */ `
    const deadline = Date.now() + A.timeoutMs;
    const test = () => {
      const el = q(A.c.selector);
      switch (A.c.type) {
        case 'exists': return !!el;
        case 'visible': return vis(el);
        case 'gone': return !el || !vis(el);
        case 'count-at-least': return qa(A.c.selector).length >= A.c.count;
        case 'value-not-empty': return !!el && valueOf(el, kindOf(el)).trim() !== '';
        case 'value-equals': return !!el && valueOf(el, kindOf(el)).trim() === String(A.c.value).trim();
        case 'value-changed': return !!el && valueOf(el, kindOf(el)).trim() !== String(A.c.from).trim();
        default: return false;
      }
    };
    while (Date.now() < deadline) {
      if (test()) return { ok: true, value: (() => { const el = q(A.c.selector); return el ? valueOf(el, kindOf(el)) : ''; })() };
      await new Promise((r) => setTimeout(r, 80));
    }
    return { ok: false, value: (() => { const el = q(A.c.selector); return el ? valueOf(el, kindOf(el)) : ''; })() };
  `,
    { c: condition, timeoutMs },
  );
}

/** Scroll a virtualised option list so the target index renders. */
export function scrollVirtualOptionExpr(index: number, owner?: string): string {
  if (owner) assertCssSelector(owner);
  return expr(
    /* js */ `
    const pane = openPanelFor(A.owner);
    if (!pane) return false;
    const viewport = pane.querySelector('cdk-virtual-scroll-viewport') || pane.querySelector('[role="listbox"]') || pane;
    const opts = pane.querySelectorAll('mat-option, [role="option"]');
    const sample = opts[0];
    const rowHeight = sample ? sample.getBoundingClientRect().height || 48 : 48;
    viewport.scrollTop = Math.max(0, (A.index - 2) * rowHeight);
    await new Promise((r) => setTimeout(r, 120));
    return true;
  `,
    { index, owner: owner ?? null },
  );
}

/**
 * Detect an in-app block page.
 *
 * EZLynx serves 403 "Unauthorized Access" and Cloudflare blocks as normal HTML
 * at the requested URL, so neither the HTTP status nor a login-URL check
 * notices them. Without this, a permissions problem looks identical to a
 * missing selector.
 */
export function pageBlockedExpr(): string {
  return expr(
    /* js */ `
    const body = document.body ? (document.body.innerText || '').replace(/\\s+/g, ' ').trim() : '';
    const head = body.slice(0, 600);
    if (/403\\s*Unauthorized Access|not authorized to access that page/i.test(head)) {
      return { blocked: true, kind: 'unauthorized', detail: head.slice(0, 200) };
    }
    if (/Sorry, you have been blocked|Attention Required!\\s*\\|\\s*Cloudflare/i.test(head + ' ' + document.title)) {
      return { blocked: true, kind: 'cloudflare', detail: head.slice(0, 200) };
    }
    if (/\\/auth\\/account\\/login|\\bsignin\\b/i.test(location.href)) {
      return { blocked: true, kind: 'login', detail: 'redirected to the login page' };
    }
    return { blocked: false, kind: null, detail: '' };
  `,
    {},
  );
}

export interface BlockedPage {
  blocked: boolean;
  kind: 'unauthorized' | 'cloudflare' | 'login' | null;
  detail: string;
}

export function readNoticesExpr(): string {
  return expr(
    /* js */ `
    return Array.from(new Set(
      Array.from(document.querySelectorAll('.mat-mdc-snack-bar-label, .toast-message, .notice, [role="status"]'))
        .filter(vis).map(txt).filter(Boolean)
    ));
  `,
    {},
  );
}

export interface Clickable {
  tag: string;
  id: string | null;
  selector: string | null;
  aria: string | null;
  href: string | null;
  text: string;
  x: number;
  y: number;
}

/**
 * Inventory of clickable affordances — nav items, menu entries, buttons, links.
 *
 * Separate from `scanStepExpr`, which only reports form controls. Discovering an
 * *entry point* (a "new applicant" menu item) needs this; filling a form needs
 * the other.
 */
export function clickablesExpr(): string {
  return expr(
    /* js */ `
    const out = [];
    // input[type=submit|button|image] matters: EZLynx's classic ASP.NET pages
    // (/EZLynxWeb/*.aspx) build every button that way, and they are invisible to
    // a button/a[href] query.
    const nodes = document.querySelectorAll(
      'button, a[href], [role="button"], [role="menuitem"], [role="option"], mat-list-item, .mat-mdc-menu-item, [routerlink],' +
      ' input[type="submit"], input[type="button"], input[type="image"], [onclick]'
    );
    for (const el of nodes) {
      if (!vis(el)) continue;
      const rect = el.getBoundingClientRect();
      const label = txt(el) || el.value || el.getAttribute('alt') || '';
      out.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        selector: el.id ? '#' + esc(el.id) : null,
        aria: el.getAttribute('aria-label') || el.getAttribute('title') || null,
        href: el.getAttribute('href') || el.getAttribute('routerlink') || null,
        text: String(label).slice(0, 60),
        x: Math.round(rect.x),
        y: Math.round(rect.y),
      });
    }
    return out;
  `,
    {},
  );
}

/** Raw HTML of a region — used by the results parser and for debugging. */
export function outerHtmlExpr(selector: string, limit = 200_000): string {
  assertCssSelector(selector);
  return expr(
    /* js */ `
    const el = q(A.selector);
    return el ? el.outerHTML.slice(0, A.limit) : null;
  `,
    { selector, limit },
  );
}
