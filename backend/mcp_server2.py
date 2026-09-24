"""EZLynx personal-lines quoting and requoting over MCP — auto, home, or both —
with a human in the loop, for every associate who just chats.

A requote works the way the associates say they work (Salwa Noor, Teams 2026-09-24,
and her 8 recordings in data/salwa_noor.csv): it starts from the client's EZLynx
TASK ("Richard Dupont - AAA 11 16 26"), compares the applicant-portal policy
summary as of Today with the renewal term, checks the Activity notes, keeps ONE
effective date for the whole bundle and never more than ~60 days out, and only
then walks the wizard. All of that is put to the associate as one "brief" question
with numbered proposed changes; agency-wide defaults (carriers, commute miles,
remembered carrier answers) are shared by every associate and editable.

Built from what the associates' recordings in /data show (7 + 8 sessions):

  new quote   /web/account/create/personal -> Go to auto|home -> rating (template,
              carriers) -> policy-info -> drivers -> vehicles -> incidents -> coverage
              -> carrier-questions -> finish [-> Go to home -> ... -> finish]
              -> Submit to carriers -> submit-details -> Submit -> quote-results
  requote     account details -> Go to auto|home -> the same wizard on the saved
              application. EZLynx remembers everything; the human's work is
              (1) move the effective date forward and the prior-policy expiration
              with it — both are hard errors otherwise, (2) type the few facts that
              changed (RCE, sqft, baths, a VIN, prior carrier/limits, coverages),
              (3) answer or drop carriers whose questions block ("Required for
              Carrier: GEICO"), (4) toggle carriers off until the finish step reads
              Valid, (5) submit and answer post-submit carrier questions.

This server walks those same screens through camofox, by the stable ids the
recordings saw (#effectiveDateNewPolicy, #driver-0-dob, #VIN-1, #dwelling,
#coveragehome_mn__105, #submit-carriers-btn, ...), as a background job that stops
for a person exactly where the recordings show one deciding:

  * a fact the run cannot know — a missing required field, a dropdown option that
    does not match, the requote's new effective date
  * a carrier question with no fact, rule or remembered answer: answer it, or drop
    that carrier
  * household members EZLynx prefilled on a new quote: keep or remove
  * a finish step that stays Invalid
  * the carrier submission itself, which can pull credit: the job parks on the
    submit-details screen listing exactly which carrier x line boxes will go, and
    only approve_submit (a person's name) or the operator's own elicitation reply
    releases it

Tools return immediately. job_status(wait_seconds=...) long-polls, answer_question
resumes, read_screen / set_fields let the human look at and fix the live screen
while the job is parked, and drive_job puts every question to the operator through
the MCP client when it supports elicitation.

The in-page readers are ported from ezlynx-agent/src/camofox/dom.ts and the field
setters from controls.ts — the parts of the TypeScript agent that already worked out
Angular Material (panels rendered outside the overlay container, stale backdrops,
ids on wrappers, verify by reading back).

    SAVVY_ENC_KEY=<64 hex> uv run python mcp_server2.py            # stdio
    SAVVY_ENC_KEY=<64 hex> uv run python mcp_server2.py --http     # streamable HTTP
    SAVVY_ENC_KEY=<64 zeros> SAVVY_DB=/tmp/t.db uv run python mcp_server2.py --selftest

Over stdio this is one operator, picked by SAVVY_USER. Mounted in the backend, the
chat endpoint sets USER per request; each associate gets their own camofox profile
(ezlynx-{user}), the same one the Connections-page login signs in.
"""

from __future__ import annotations

import asyncio
import contextvars
import copy
import difflib
import itertools
import json
import os
import re
import sys
import time
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any

import httpx
from fastmcp import Context, FastMCP
from fastmcp.exceptions import ResourceError, ToolError
from mcp.types import ElicitRequest, ElicitRequestFormParams, InputRequiredResult

from ezlynx import Camofox, CamofoxError, login, submit_code
from store import Store

USER: contextvars.ContextVar[str] = contextvars.ContextVar(
    "savvy_user", default=os.environ.get("SAVVY_USER", "default")[:64]
)

EZLYNX_BASE_URL = os.environ.get("EZLYNX_BASE_URL", "https://app.ezlynx.com").rstrip("/")
CAMOFOX_URL = os.environ.get("CAMOFOX_URL", "http://localhost:9377")
CAMOFOX_ACCESS_KEY = os.environ.get("CAMOFOX_ACCESS_KEY", "")
# Empty means one profile per associate, ezlynx-{user}; set it only for a stdio
# setup that already signed in under another profile.
CAMOFOX_USER_ID = os.environ.get("CAMOFOX_USER_ID", "")
CAMOFOX_SESSION_KEY = os.environ.get("CAMOFOX_SESSION_KEY", "ezlynx")
DB_FILE = os.environ.get("SAVVY_DB", "savvy.db")
# How long a parked question keeps its browser tab before the job gives up.
QUESTION_TTL_S = float(os.environ.get("EZLYNX_QUESTION_TTL_S", 4 * 3600))
# Carriers keep answering for a while after submit (~90 s in the recordings).
RESULTS_WAIT_S = float(os.environ.get("EZLYNX_RESULTS_WAIT_S", 300))
# Whether the model may approve the carrier submission with approve_submit. Turn
# it off once the app approves from its own submit card (approve_job below).
MODEL_APPROVAL = os.environ.get("EZLYNX_MODEL_APPROVAL", "1").strip().lower() not in ("0", "false", "no", "off")
CAMOFOX_TIMEOUT_S = 120
MFA_WINDOW_S = 600
KEEPALIVE_S = 120  # camofox reaps idle tabs; a parked job touches its tab this often

DATE_FORMAT = "%m/%d/%Y"
ACCOUNT_ID = re.compile(r"^\d+$")
SSN_VALUE = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
CARRIER_QUESTION = re.compile(r"__(\d+)$")  # carrier questions are #{question}__{carrierId}
FINISHED = {"done", "failed", "cancelled"}

mcp = FastMCP(
    "ezlynx",
    instructions=(
        "Quote and requote EZLynx personal lines (auto, home, or both) for any associate "
        "who just chats. Find work with my_tasks (their EZLynx task list — requotes start "
        "from a task), find_account(name), list_renewals, check_account, get_account_context. "
        "start_requote(account_id) works for ANY existing account with nothing stored: it reads "
        "the client's task, the policies as of today vs the renewal, the Activity notes and the "
        "saved applications, then parks ONE 'brief' question (one effective date for every line, "
        "numbered proposed changes). start_quote is for a new applicant. Follow a job with "
        "job_status(job_id, wait_seconds=60) and relay every question to the associate VERBATIM; "
        "pass their reply to answer_question. When the associate adds or corrects something "
        "(a new driver, a car gone, a coverage), call amend_job — at any time before submission — "
        "rather than hoping a question comes up. At the submit gate show submitSummary and call "
        "approve_submit only with the name of the person who said yes — never on your own. After "
        "results, show the drafted task note (result.taskNote) and post it with update_task only "
        "once the associate approves. Agency-wide defaults (carriers, the 60-day limit, commute "
        "miles, remembered answers) apply to every associate: get_agency_defaults / "
        "set_agency_defaults (only on the word of whoever sets agency practice)."
    ),
)
store = Store(DB_FILE)

awaiting_code: dict[str, tuple[str, float]] = {}
# One camofox conversation per user: a run, a lookup and a login would fight
# over the same profile (login's checkpoint kills every tab in it).
_locks: dict[str, asyncio.Lock] = {}
_fact_locks: dict[str, asyncio.Lock] = {}
_jobs: dict[str, "Job"] = {}
_job_seq = itertools.count(1)
_question_seq = itertools.count(1)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _lock(user: str) -> asyncio.Lock:
    return _locks.setdefault(user, asyncio.Lock())


def _profile(user: str | None = None) -> str:
    return CAMOFOX_USER_ID or f"ezlynx-{user or USER.get()}"


# =============================================================== in-page JS
# Ported from ezlynx-agent/src/camofox/dom.ts. Reading happens in the page (one
# round trip per screen); acting goes through camofox /click and /type so Angular
# receives real events and Playwright's actionability checks apply.

PRELUDE = r"""
const esc = (s) => { try { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, (c) => '\\' + c); } catch (e) { return s; } };
const txt = (el) => (el && el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '');
// Text nodes joined with spaces: adjacent elements' text must not run together ("changeBy Lea").
const spaced = (el) => { if (!el) return ''; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); const out = []; let n;
  while ((n = w.nextNode())) { const t = n.nodeValue.replace(/\s+/g, ' ').trim(); if (t) out.push(t); } return out.join(' '); };
const vis = (el) => {
  if (!el || !el.getBoundingClientRect) return false;
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
};
const q = (sel) => { try { return document.querySelector(sel); } catch (e) { return null; } };
const qa = (sel, root) => { try { return Array.from((root || document).querySelectorAll(sel)); } catch (e) { return []; } };
const selOf = (el) => (el && el.id ? '[id="' + el.id.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]' : null);
const formField = (el) => (el && el.closest ? el.closest('mat-form-field, .mat-mdc-form-field, .form-field, .field') : null);
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
const INNER_CONTROL = 'input:not([type="hidden"]), textarea, mat-select, select, [role="combobox"]';
const resolveActionable = (el, sel) => {
  const kind = kindOf(el);
  if (kind !== 'unknown' && kind !== 'button') return { el, selector: sel };
  const inner = el.querySelector ? el.querySelector(INNER_CONTROL) : null;
  if (inner) return { el: inner, selector: selOf(inner) || sel + ' ' + inner.tagName.toLowerCase() };
  const ff = formField(el);
  if (ff) {
    const pick = Array.from(ff.querySelectorAll(INNER_CONTROL)).filter((c) => c !== el && vis(c) && kindOf(c) !== 'unknown')[0];
    if (pick) return { el: pick, selector: selOf(pick) || sel };
  }
  return { el, selector: sel };
};
// Carrier questions carry no mat-label (the recorder saw "info" or the error as
// the label); the question is text in the surrounding row. Prefer a line that asks.
const questionOf = (el) => {
  const own = valueOf(el, kindOf(el));
  let n = el;
  for (let d = 0; d < 4 && n; d++) {
    n = n.parentElement;
    if (!n || n === document.body) break;
    const lines = (n.innerText || '').split('\n')
      .map((s) => s.replace(/Required for Carrier\s*:?.*$/i, '').replace(/--Select--/g, '').replace(/\binfo\s*$/i, '').trim())
      .filter((s) => s && s !== own && s.length > 6 && !/^Select$/i.test(s));
    const asks = lines.find((s) => s.includes('?'));
    if (asks || lines.length) return (asks || lines[0]).slice(0, 200);
  }
  return '';
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
    visible: vis(el), label: labelOf(el) || labelOf(matched) || questionOf(el), error: errorOf(el) || errorOf(matched),
    matches: all.length,
  };
};
const openPanelFor = (sel) => {
  if (sel) {
    const ctl = q(sel);
    const owns = ctl && (ctl.getAttribute('aria-owns') || ctl.getAttribute('aria-controls'));
    if (owns) { const byId = document.getElementById(owns); if (byId) return byId; }
  }
  const panels = qa('.mat-mdc-select-panel, .mat-select-panel, .mat-mdc-autocomplete-panel, [role="listbox"]').filter(vis);
  if (panels.length) return panels[panels.length - 1];
  const panes = qa('.cdk-overlay-pane').filter(vis);
  return panes[panes.length - 1] || null;
};
const openPanelOptions = (sel) => {
  const pane = openPanelFor(sel);
  if (!pane) return [];
  return Array.from(pane.querySelectorAll('mat-option, [role="option"]')).map((o, i) => ({
    index: i, id: o.id || null,
    text: txt(o.querySelector('.mdc-list-item__primary-text, .mat-option-text') || o),
    disabled: o.getAttribute('aria-disabled') === 'true' || o.classList.contains('mat-mdc-option-disabled'),
  }));
};
const anyPanelOpen = () => {
  if (qa('[aria-expanded="true"]').some((el) => /mat-select|combobox/i.test(el.tagName + ' ' + (el.getAttribute('role') || '')))) return true;
  return qa('.mat-mdc-select-panel, .mat-select-panel, [role="listbox"]').some(vis);
};
const busy = () => qa('mat-spinner, mat-progress-spinner, .mat-mdc-progress-spinner, mat-progress-bar, .mat-mdc-progress-bar, .loading-overlay').some(vis);
const controlNear = (e) => {
  const ff = formField(e);
  let ctl = ff && ff.querySelector(INNER_CONTROL);
  let n = e;
  for (let d = 0; !ctl && d < 4 && n; d++) { n = n.parentElement; ctl = n && n.querySelector(INNER_CONTROL); }
  return ctl || null;
};
const pageErrors = (root) => {
  const out = []; const seen = new Set();
  for (const e of qa('mat-error, .mat-mdc-form-field-error, .field-error, [role="alert"]', root)) {
    const t = txt(e);
    if (!t || !vis(e)) continue;
    const ctl = controlNear(e);
    const kind = ctl ? kindOf(ctl) : null;
    const key = t + '|' + (ctl ? ctl.id : '');
    if (seen.has(key)) continue;
    seen.add(key);
    const m = t.match(/Required for Carrier\s*:\s*(.+?)(?:\s+info)?$/i);
    out.push({ text: t, selector: selOf(ctl), kind, value: ctl ? valueOf(ctl, kind) : null,
               label: ctl ? labelOf(ctl) : '', question: ctl ? questionOf(ctl) : '', carrier: m ? m[1].trim() : null });
  }
  return out;
};
const controlsIn = (root) => {
  const out = []; const seen = new Set();
  for (const el of qa('input, select, textarea, mat-select, mat-slide-toggle, mat-checkbox, [role="combobox"], [role="switch"], button[aria-checked], button[aria-pressed]', root)) {
    if (el.type === 'hidden' || !vis(el)) continue;
    const tag = el.tagName.toLowerCase();
    // A toggle/checkbox wrapper is listed through the control inside it — the id the recordings act on.
    if ((tag === 'mat-slide-toggle' || tag === 'mat-checkbox') && el.querySelector('input, button[aria-checked], button[aria-pressed], [role="switch"]')) continue;
    const kind = kindOf(el);
    if (kind === 'unknown' || kind === 'button') continue;
    const sel = selOf(el);
    if (!sel || seen.has(sel)) continue;
    seen.add(sel);
    const wrapper = el.closest('mat-slide-toggle, mat-checkbox');
    const label = labelOf(el) || (wrapper ? txt(wrapper) : '');
    out.push({ selector: sel, kind, label: (!label || label === 'info') ? questionOf(el) : label, value: valueOf(el, kind),
               disabled: disabledOf(el), required: el.required === true || el.getAttribute('aria-required') === 'true', error: errorOf(el) });
  }
  return out;
};
"""


def _js(body: str, **args: Any) -> str:
    # json.dumps escapes U+2028/2029, which JSON allows and JS source does not.
    return f"(async (A) => {{ {PRELUDE}\n{body} }})({json.dumps(args)})"


def js_describe(selector: str) -> str:
    return _js("return describe(A.selector);", selector=selector)


def js_panel_wait(timeout_ms: int, owner: str) -> str:
    return _js(
        """const deadline = Date.now() + A.timeoutMs;
        while (Date.now() < deadline) {
          const opts = openPanelOptions(A.owner);
          if (opts.length) return { ok: true, options: opts };
          await new Promise((r) => setTimeout(r, 60));
        }
        return { ok: false, options: [] };""",
        timeoutMs=timeout_ms, owner=owner,
    )


def js_panel_options(owner: str) -> str:
    return _js("return openPanelOptions(A.owner);", owner=owner)


JS_ANY_PANEL = _js('return anyPanelOpen() || qa(".cdk-overlay-backdrop").filter(vis).length > 0;')


def js_panel_closed(timeout_ms: int) -> str:
    return _js(
        """const deadline = Date.now() + A.timeoutMs;
        while (Date.now() < deadline) { if (!anyPanelOpen()) return true; await new Promise((r) => setTimeout(r, 60)); }
        return false;""",
        timeoutMs=timeout_ms,
    )


def js_scroll(selector: str) -> str:
    return _js(
        """const el = q(A.selector); if (!el) return false;
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        await new Promise((r) => setTimeout(r, 250)); return vis(el);""",
        selector=selector,
    )


def js_scroll_virtual(index: int, owner: str) -> str:
    return _js(
        """const pane = openPanelFor(A.owner); if (!pane) return false;
        const viewport = pane.querySelector('cdk-virtual-scroll-viewport') || pane.querySelector('[role="listbox"]') || pane;
        const sample = pane.querySelector('mat-option, [role="option"]');
        viewport.scrollTop = Math.max(0, (A.index - 2) * (sample ? sample.getBoundingClientRect().height || 48 : 48));
        await new Promise((r) => setTimeout(r, 120)); return true;""",
        index=index, owner=owner,
    )


def js_settle(timeout_ms: int) -> str:
    """Wait until no spinner has shown for 400 ms. Bounded under camofox's 30 s handler limit."""
    return _js(
        """const deadline = Date.now() + A.timeoutMs; let quiet = 0;
        while (Date.now() < deadline) {
          if (busy() || document.readyState !== 'complete') quiet = 0; else quiet += 100;
          if (quiet >= 400) return { path: location.pathname, busy: false };
          await new Promise((r) => setTimeout(r, 100));
        }
        return { path: location.pathname, busy: true };""",
        timeoutMs=timeout_ms,
    )


def js_wait_path(pattern: str, timeout_ms: int) -> str:
    return _js(
        """const re = new RegExp(A.pattern); const deadline = Date.now() + A.timeoutMs;
        while (Date.now() < deadline) {
          if (re.test(location.pathname)) return { ok: true, path: location.pathname };
          await new Promise((r) => setTimeout(r, 150));
        }
        return { ok: false, path: location.pathname };""",
        pattern=pattern, timeoutMs=timeout_ms,
    )


def js_wait_value(selector: str, timeout_ms: int) -> str:
    return _js(
        """const deadline = Date.now() + A.timeoutMs;
        while (Date.now() < deadline) {
          const el = q(A.selector);
          if (el && valueOf(el, kindOf(el)).trim()) return true;
          await new Promise((r) => setTimeout(r, 100));
        }
        return false;""",
        selector=selector, timeoutMs=timeout_ms,
    )


JS_BLOCKED = _js(
    r"""const body = document.body ? (document.body.innerText || '').replace(/\s+/g, ' ').trim() : '';
    const head = body.slice(0, 600);
    if (/403\s*Unauthorized Access|not authorized to access that page/i.test(head)) return { blocked: 'unauthorized', detail: head.slice(0, 200) };
    if (/Sorry, you have been blocked|Attention Required!|just a moment/i.test(head + ' ' + document.title)) return { blocked: 'cloudflare', detail: head.slice(0, 200) };
    if (/\/auth\/account\/login|\bsignin\b/i.test(location.href) || document.querySelector('input[type="password"]')) return { blocked: 'login', detail: '' };
    return { blocked: null, detail: '' };"""
)

JS_SCAN = _js(
    """return { path: location.pathname, title: document.title, errors: pageErrors(),
      headers: qa('[id^="step-header-"]').map((h) => ({ id: h.id, text: txt(h) })),
      buttons: qa('[id^="go-to-"], [id^="save-and-go-to-"], #submit-to-carriers-btn').filter(vis).map((e) => ({ id: e.id, text: txt(e) })),
      notices: Array.from(new Set(qa('.mat-mdc-snack-bar-label, .toast-message, [role="status"]').filter(vis).map(txt).filter(Boolean))),
      controls: A.full ? controlsIn().slice(0, 250) : [] };""",
    full=False,
)
JS_SCAN_FULL = JS_SCAN.replace('{"full": false}', '{"full": true}')

JS_ROSTER = _js(
    """const d = (s) => describe(s).value; const out = { drivers: [], vehicles: [], incidents: [] };
    for (let i = 0; i < 15; i++) {
      if (!q('#driver-' + i + '-first-name')) break;
      out.drivers.push({ i, first: d('#driver-' + i + '-first-name'), last: d('#driver-' + i + '-last-name'),
                         dob: d('#driver-' + i + '-dob'), relationship: d('#driver-' + i + '-relationship'),
                         rated: d('#driver-' + i + '-ratedDriver') });
    }
    for (let i = 0; i < 15; i++) {
      if (!q('#VIN-' + i) && !q('#selected-year-' + i)) break;
      out.vehicles.push({ i, vin: d('#VIN-' + i), year: d('#selected-year-' + i), make: d('#selected-make-' + i), model: d('#selected-model-' + i),
                           use: d('#selected-use-' + i), oneWay: d('#oneWayMiles-' + i) });
    }
    for (let i = 0; i < 15; i++) {
      if (!q('#violationDate-' + i)) break;
      out.incidents.push({ i, date: d('#violationDate-' + i), description: d('#violationDescription-' + i) });
    }
    return out;"""
)

JS_CARRIERS = _js(
    """return qa('[id^="carrier-"]').filter((e) => /^carrier-\\d+-.*-button$/.test(e.id)).map((e) => {
      const box = document.getElementById(e.id.replace(/-button$/, ''));
      return { selector: selOf(e), carrierId: e.id.split('-')[1], name: txt(box || e) || labelOf(e), on: valueOf(e, kindOf(e)) === 'true' };
    });"""
)

JS_SUBMIT_GRID = _js(
    """const box = q('#submit-details-carriers-container');
    if (!box) return { found: false, text: txt(document.body).slice(0, 2000) };
    const rows = [];
    for (const act of qa('.submit-detail-action', box)) {
      let row = act, name = '';
      for (let d = 0; d < 4 && row && !name; d++) {
        row = row.parentElement;
        const img = row && row.querySelector('img[alt]');
        name = img ? img.getAttribute('alt') : '';
      }
      const lobs = qa('mat-checkbox', act).map((cb) => { const i = cb.querySelector('input'); return { lob: txt(cb), on: !!(i && i.checked), disabled: !!(i && i.disabled) }; });
      rows.push({ carrier: name || txt(act.parentElement).slice(0, 80), lobs });
    }
    return { found: true, rows, text: txt(box).slice(0, 3000) };"""
)

JS_RESULTS = _js(
    """const cards = qa('script-result').map((c, index) => {
      const img = c.querySelector('img.carrier-img, carrier-image img, img[alt]');
      const ans = c.querySelector('[id^="answer-questions-"]');
      const sub = c.querySelector('[id^="submit-answers-button"]');
      return { index, carrier: img ? (img.getAttribute('alt') || '') : '', icons: qa('mat-icon', c).map(txt),
               graphIds: qa('[id^="graph-"]', c).map((e) => e.id),
               text: txt(c).slice(0, 1500), answerId: ans && vis(ans) ? ans.id : null, submitId: sub && vis(sub) ? sub.id : null };
    });
    const toggle = qa('mat-slide-toggle').find((t) => /graph view/i.test(txt(t)));
    const tb = toggle ? (toggle.querySelector('button') || toggle) : null;
    return { path: location.pathname, cards, busy: busy(), graphView: tb ? tb.getAttribute('aria-checked') === 'true' : null,
             viewErrors: qa('button').some((b) => /view errors/i.test(txt(b)) && vis(b)) };"""
)


def js_card_questions(card_index: int) -> str:
    return _js(
        """const card = qa('script-result')[A.index]; if (!card) return null;
        const sub = card.querySelector('[id^="submit-answers-button"]');
        return { controls: controlsIn(card), errors: pageErrors(card), submitId: sub ? sub.id : null };""",
        index=card_index,
    )


def js_text(selector: str | None, limit: int) -> str:
    return _js(
        "const el = A.selector ? q(A.selector) : document.body; return el ? (el.innerText || '').slice(0, A.limit) : null;",
        selector=selector, limit=limit,
    )


JS_RENEWALS = _js(
    """return qa('input[id^="select_"]').map((cb) => {
      const m = cb.id.match(/^select_(\\d+)$/); if (!m) return null;
      const row = cb.closest('tr') || cb.parentElement;
      return { accountId: m[1], text: txt(row).slice(0, 300) };
    }).filter(Boolean);"""
)


# Which rating applications an account already has: any link or router link into
# /rating/{auto|home}/{appId}/ (rec 1 followed such links; rec 4 started on the quotes page).
JS_APP_LINKS = _js(
    """const apps = {};
    for (const el of qa('a[href], [routerlink], [ng-reflect-router-link]')) {
      const h = el.getAttribute('href') || el.getAttribute('routerlink') || el.getAttribute('ng-reflect-router-link') || '';
      const m = h.match(/\\/rating\\/(auto|home)\\/(\\d+)/i);
      if (m) { const lob = m[1].toLowerCase(); (apps[lob] = apps[lob] || []).includes(m[2]) || apps[lob].push(m[2]); }
    }
    return { path: location.pathname, apps };"""
)


# The header task list is the SIGNED-IN associate's list across clients (recs 0 and
# 2 show Detweiler and Wincek in the same list of 4), so items are read one by one
# and matched to the applicant by name. An item is the smallest element holding a
# whole "Client - title ... By Author" line; it is tagged so camofox can click it.
JS_TASKS = _js(
    r"""const box = q('#taskListSection'); if (!box) return { found: false, items: [] };
    const re = /^\s*[^\n]{2,80}?\s[-–]\s[\s\S]+(^|\s)By\s+[A-Z]/;
    const hits = [box].concat(qa('*', box)).filter((el) => re.test(spaced(el)) && !Array.from(el.children).some((c) => re.test(spaced(c))));
    return { found: true, items: hits.map((el, i) => {
      el.setAttribute('data-savvy-task', String(i));
      const group = el.closest('ez-task-group');
      const link = qa('a[href]', el).map((a) => a.getAttribute('href')).find((h) => /\/account\/\d+/.test(h)) || null;
      return { i, text: spaced(el).slice(0, 300), group: group ? group.className : '', link };
    }) };"""
)

def js_task_detail(task_index: int) -> str:
    return _js(
    """const note = q('[name="taskNote"]'); const list = q('ez-checklist-items, ol.checklist-items');
    if (!note && !list) return { found: false, checklist: [], links: [], text: '' };
    let root = list || note;
    while (root && note && !root.contains(note) && root.parentElement) root = root.parentElement;
    root = root || q('#taskListSection') || document.body;
    // Text of the opened task's detail only: lines of OTHER tasks in the same panel are skipped.
    const other = (n) => { const item = n.parentElement && n.parentElement.closest('[data-savvy-task]');
      return !!item && item.getAttribute('data-savvy-task') !== String(A.task) && !item.contains(root); };
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); const out = []; let n;
    while ((n = w.nextNode())) { if (other(n)) continue; const t = n.nodeValue.replace(/\\s+/g, ' ').trim(); if (t) out.push(t); }
    const assign = q('mat-form-field.assign-task input');
    return { found: true, checklist: qa('li', list || root).filter((li) => !other(li.firstChild || li)).map(txt).filter(Boolean).slice(0, 20),
             note: note ? note.value : null, assignedTo: assign ? assign.value : null,
             links: qa('a[href]', root).map((a) => a.getAttribute('href')).filter((h) => /\\/account\\/\\d+/.test(h)).slice(0, 5),
             text: out.join(' ').slice(0, 4000) };""",
    task=task_index,
    )

# Account overview: one <ez-policy> per policy, "Active Homeowners | 5625714602
# Auto-Owners Insurance Company ..." (rec 3). Tagged for clicking when it has no link.
JS_POLICIES = _js(
    """return qa('ez-policy').map((p, i) => {
      p.setAttribute('data-savvy-policy', String(i));
      const href = qa('a[href]', p).map((a) => a.getAttribute('href')).find((h) => /applicantportal\\/policy\\//i.test(h)) || null;
      return { i, text: spaced(p).slice(0, 300), href };
    });"""
)

# The applicant-portal policy summary: the "Viewing Summary As Of" term list and the page text.
JS_POLICY_SUMMARY = _js(
    """const sel = q('#SelectedPolicyId');
    const options = sel && sel.options ? Array.from(sel.options).map((o) => ({ value: o.value, text: (o.textContent || '').trim(), selected: !!o.selected })) : [];
    const all = document.body ? document.body.innerText || '' : '';
    const whole = document.body ? spaced(document.body) : '';  // hidden (collapsed) sections too
    return { path: location.pathname + location.search, title: document.title || '', options,
             text: all.slice(0, 40000), truncated: all.length > 40000,
             vins: Array.from(new Set((whole.toUpperCase().match(/\\b(?=[A-HJ-NPR-Z0-9]*\\d)(?=[A-HJ-NPR-Z0-9]*[A-HJ-NPR-Z])[A-HJ-NPR-Z0-9]{17}\\b/g) || []))) };"""
)

JS_ACTIVITY = _js(
    """return qa('#activities-container .activity-container').slice(0, A.limit)
      .map((c) => spaced(c).slice(0, 700));""",
    limit=20,
)


async def _page_click(b: Browser, tab: str, selector: str) -> bool:
    """An in-page click, for opening panels only to read them (the task list, a
    task, a discussion). A native click that times out makes camofox drop the
    whole session; a read is not worth that risk. Form fields still go through
    camofox so Angular gets real input. The click lands just after this call
    returns, so a click that navigates cannot break the call itself."""
    return bool(await b.evaluate(tab, _js(
        """const el = qa(A.selector).find(vis) || q(A.selector); if (!el) return false;
        el.scrollIntoView({ block: 'center' }); setTimeout(() => el.click(), 0); return true;""", selector=selector)))


def _id_sel(element_id: str) -> str:
    return '[id="' + element_id.replace("\\", "\\\\").replace('"', '\\"') + '"]'


# ================================================================ browser

class Browser(Camofox):
    """ezlynx.Camofox plus the calls a wizard run needs."""

    async def evaluate(self, tab_id: str, expression: str) -> Any:
        done = await self._call("POST", self._tab(tab_id, "/evaluate"), {"userId": self._user_id, "expression": expression})
        return done.get("result")

    async def navigate(self, tab_id: str, url: str) -> None:
        await self._call("POST", self._tab(tab_id, "/navigate"), {"userId": self._user_id, "url": url})

    async def press(self, tab_id: str, key: str) -> None:
        await self._call("POST", self._tab(tab_id, "/press"), {"userId": self._user_id, "key": key})


class FieldError(Exception):
    def __init__(self, message: str, selector: str, options: list[str] | None = None, label: str = "") -> None:
        super().__init__(message)
        self.selector, self.options, self.label = selector, options, label


class JobError(Exception):
    """A stop the associate has to act on (session expired, no access)."""


class SessionError(JobError):
    """Signed out or challenged: every page after this one would fail the same way."""


async def _settle(b: Browser, tab: str, total_s: float = 25) -> str:
    with suppress(CamofoxError, httpx.HTTPError):
        await b.wait(tab, 10_000)
    deadline = time.monotonic() + total_s
    state = {"path": ""}
    while time.monotonic() < deadline:
        state = await b.evaluate(tab, js_settle(12_000))
        if not state.get("busy"):
            break
    return state.get("path", "")


async def _wait_path(b: Browser, tab: str, pattern: str, total_s: float = 40) -> str | None:
    deadline = time.monotonic() + total_s
    while time.monotonic() < deadline:
        found = await b.evaluate(tab, js_wait_path(pattern, 12_000))
        if found.get("ok"):
            return found["path"]
    return None


async def _guard(b: Browser, tab: str) -> None:
    state = await b.evaluate(tab, JS_BLOCKED)
    blocked = (state or {}).get("blocked")
    if blocked == "login":
        raise SessionError("The EZLynx session has expired. Call ezlynx_login, then start again — EZLynx kept every saved screen.")
    if blocked == "unauthorized":
        raise JobError("This EZLynx user cannot open that page (403 Unauthorized Access).")
    if blocked == "cloudflare":
        raise SessionError("Cloudflare is challenging the browser, not EZLynx. Check the camofox box's VPN egress.")


# ================================================================ controls
# Ported from ezlynx-agent/src/camofox/controls.ts: every write is verified by
# reading it back, because a prefilled EZLynx value that "looks right" is not
# evidence.

def _norm(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value if value is not None else "")).strip().lower()


def _num(value: Any) -> float | None:
    cleaned = re.sub(r"[$,%\s]", "", str(value if value is not None else ""))
    try:
        return float(cleaned) if cleaned else None
    except ValueError:
        return None


def _date(value: Any) -> date | None:
    raw = str(value or "").strip()
    for fmt in ("%m/%d/%Y", "%m-%d-%Y", "%Y-%m-%d", "%m%d%Y"):
        with suppress(ValueError):
            return datetime.strptime(raw, fmt).date()
    return None


def _same(a: Any, b: Any) -> bool:
    if _norm(a) == _norm(b):
        return True
    na, nb = _num(a), _num(b)
    if na is not None and nb is not None:
        return na == nb
    da, db = _date(a), _date(b)
    return da is not None and da == db


def _yes_no(value: Any) -> Any:
    return ("Yes" if value else "No") if isinstance(value, bool) else value


def match_option(wanted: Any, options: list[str]) -> int | None:
    """Exact, numeric, unique prefix, unique substring, then a close fuzzy match.
    None means the human picks — a wrong dropdown value is worse than a question."""
    w = _norm(_yes_no(wanted))
    normed = [_norm(o) for o in options]
    for i, o in enumerate(normed):
        if o == w:
            return i
    wn = _num(w)
    if wn is not None:
        for i, o in enumerate(options):
            if _num(o) == wn:
                return i
    # The looser tiers may only pick an option whose numbers agree: '1' must not
    # become '10', '$50' not '$500', '2 Stories' not '3 Stories'.
    numbers = lambda s: re.findall(r"\d+(?:\.\d+)?", s.replace(",", ""))
    wanted_numbers = numbers(w)
    candidates = [i for i, o in enumerate(normed) if numbers(o)[:len(wanted_numbers)] == wanted_numbers]
    for test in (lambda o: o.startswith(w), lambda o: w in o):
        hits = [i for i in candidates if w and test(normed[i])]
        if len(hits) == 1:
            return hits[0]
    close = difflib.get_close_matches(w, [normed[i] for i in candidates], n=1, cutoff=0.86)
    return candidates[[normed[i] for i in candidates].index(close[0])] if close else None


async def _no_panel(b: Browser, tab: str) -> None:
    """An open mat-select lays a backdrop over the page and swallows the next click."""
    if not await b.evaluate(tab, JS_ANY_PANEL):
        return
    with suppress(CamofoxError, httpx.HTTPError):
        await b.press(tab, "Escape")
    if await b.evaluate(tab, js_panel_closed(3_000)):
        return
    with suppress(CamofoxError, httpx.HTTPError):
        await b.click(tab, ".cdk-overlay-backdrop")
    await b.evaluate(tab, js_panel_closed(2_000))
    await asyncio.sleep(0.25)


async def _open_options(b: Browser, tab: str, selector: str) -> list[dict[str, Any]]:
    await _no_panel(b, tab)
    await b.evaluate(tab, js_scroll(selector))
    panel: dict[str, Any] = {}
    for _ in range(2):  # the first click on a fresh Angular form is sometimes absorbed
        await b.click(tab, selector)
        panel = await b.evaluate(tab, js_panel_wait(8_000, selector))
        if panel.get("ok") and panel.get("options"):
            return panel["options"]
        await _no_panel(b, tab)
    return []


async def options_for(b: Browser, tab: str, selector: str) -> list[str]:
    """The choices a dropdown offers, for putting a question to a human."""
    state = await b.evaluate(tab, js_describe(selector))
    if not state.get("found") or state.get("kind") != "mat-select":
        return []
    options = await _open_options(b, tab, state["resolvedSelector"])
    await _no_panel(b, tab)
    return [o["text"] for o in options if not o.get("disabled")]


async def set_field(b: Browser, tab: str, selector: str, desired: Any) -> dict[str, Any]:
    state = await b.evaluate(tab, js_describe(selector))
    if not state.get("found"):
        return {"selector": selector, "applied": False, "skipped": "not-found"}
    sel, kind = state["resolvedSelector"], state["kind"]
    if not state.get("visible"):
        await b.evaluate(tab, js_scroll(sel))
    if state.get("disabled"):
        return {"selector": sel, "applied": False, "skipped": "disabled", "value": state.get("value")}
    wanted = _yes_no(desired)
    before = state.get("value", "")

    if kind in ("radio", "checkbox", "toggle"):
        want = desired if isinstance(desired, bool) else _norm(desired) in ("yes", "true", "1", "on")
        if state.get("checked") == want:
            return {"selector": sel, "applied": False, "skipped": "already-set", "value": before}
        await _no_panel(b, tab)
        await b.click(tab, sel)
        after = await b.evaluate(tab, js_describe(sel))
        if after.get("checked") != want:
            raise FieldError(f"{state.get('label') or sel} did not switch to {want}", sel, label=state.get("label", ""))
        return {"selector": sel, "applied": True, "from": before, "value": str(want).lower()}

    if before and _same(before, wanted):
        return {"selector": sel, "applied": False, "skipped": "already-set", "value": before}

    if kind == "mat-select":
        options = await _open_options(b, tab, sel)
        if not options:
            raise FieldError(f"{state.get('label') or sel}: the dropdown did not open", sel, label=state.get("label", ""))
        texts = [o["text"] for o in options]
        index = match_option(wanted, texts)
        if index is None:
            await _no_panel(b, tab)
            raise FieldError(f"No option in {state.get('label') or sel} matches {wanted!r}", sel,
                             [o["text"] for o in options if not o.get("disabled")], state.get("label", ""))
        target = options[index]
        if not target.get("id"):  # long lists virtualise; scroll the option into existence
            await b.evaluate(tab, js_scroll_virtual(index, sel))
            refreshed = await b.evaluate(tab, js_panel_options(sel))
            target = next((o for o in refreshed if o["text"] == target["text"] and o.get("id")), target)
        if not target.get("id"):
            await _no_panel(b, tab)
            raise FieldError(f"{state.get('label') or sel}: option {target['text']!r} has no id to click", sel)
        await b.click(tab, _id_sel(target["id"]))
        await b.evaluate(tab, js_panel_closed(4_000))
        after = await b.evaluate(tab, js_describe(sel))
        if _norm(after.get("value")) != _norm(target["text"]):
            raise FieldError(f"{state.get('label') or sel} shows {after.get('value')!r}, not {target['text']!r}", sel)
        return {"selector": sel, "applied": True, "from": before, "value": after.get("value")}

    if kind == "mat-autocomplete":
        await _no_panel(b, tab)
        await b.type(tab, sel, str(wanted))
        panel = await b.evaluate(tab, js_panel_wait(6_000, sel))
        if panel.get("ok") and panel.get("options"):
            index = match_option(wanted, [o["text"] for o in panel["options"]])
            if index is not None and panel["options"][index].get("id"):
                await b.click(tab, _id_sel(panel["options"][index]["id"]))
                await b.evaluate(tab, js_panel_closed(3_000))
        await _no_panel(b, tab)
        after = await b.evaluate(tab, js_describe(sel))
        return {"selector": sel, "applied": True, "from": before, "value": after.get("value")}

    if kind in ("text", "textarea"):
        await _no_panel(b, tab)
        await b.type(tab, sel, str(wanted))
        after = await b.evaluate(tab, js_describe(sel))
        result = {"selector": sel, "applied": True, "from": before, "value": after.get("value")}
        if not _same(after.get("value"), wanted):
            result["note"] = f"typed {wanted!r}, field shows {after.get('value')!r}"  # masked inputs reformat
        return result

    raise FieldError(f"{state.get('label') or sel} is a {kind} control this cannot set", sel)


# ================================================== the wizard, from /data
# Step order and labels exactly as the recordings walk them. Advancing clicks the
# go-to button whose TEXT is the next label: the home "Carrier questions" button
# was recorded as #go-to-drivers-btn, so ids alone would go wrong.

STEPS: dict[str, list[tuple[str, str]]] = {
    "auto": [("rating", "Rating"), ("policy-info", "Policy info"), ("drivers-compact", "Drivers"),
             ("vehicles-compact", "Vehicles"), ("incidents", "Incidents"), ("coverage", "Coverage"),
             ("carrier-questions", "Carrier questions"), ("finish", "Finish")],
    "home": [("rating", "Rating"), ("policy-info", "Policy info"), ("dwelling-info", "Dwelling info"),
             ("coverage", "Coverage"), ("endorsements", "Endorsements"),
             ("carrier-questions", "Carrier questions"), ("finish", "Finish")],
}

# (fact path, selector) — the quote JSON is ezlynx-agent's QuoteRequest shape, so
# quotes stored by the first server and by `ezlynx-agent extract` still work.
APPLICANT_FIELDS = [
    ("ratingState", "#applicant-rating-state"),
    ("applicant.firstName", "#applicant-first-name"),
    ("applicant.middleInitial", "#applicant-middle-name"),
    ("applicant.lastName", "#applicant-last-name"),
    ("applicant.suffix", "#applicant-name-suffix"),
    ("applicant.gender", "#applicant-gender"),
    ("applicant.dateOfBirth", "#applicant-date-of-birth"),
    ("applicant.maritalStatus", "#applicant-marital-status"),
    ("applicant.education", "#applicant-education"),
    ("applicant.industry", "#applicant-industry"),
    ("applicant.occupation", "#applicant-occupation"),
    ("address.postalCode", "#applicant-primaryaddress-postalcode"),
    ("address.line1", "#applicant-primary-address-address1"),
    ("address.unit", "#applicant-primary-address-addressUnit"),
    ("address.line2", "#applicant-primary-address-address2"),
    ("address.city", "#applicant-primary-address-addressCity"),
    ("address.state", "#applicant-primary-address-addressState"),
    ("address.postalCode", "#applicant-primary-address-postalCode"),
    ("address.postalCodeSuffix", "#applicant-primary-address-postalCodeSuffix"),
    ("address.county", "#applicant-primary-address-addressCounty"),
    ("address.yearsAtAddress", "#applicant-primary-address-yearsAtAddress"),
    ("address.monthsAtAddress", "#applicant-primary-address-monthsAtAddress"),
    ("applicant.phone", "#applicant-phone-1-personal-number"),
    ("applicant.email", "#applicant-email-0-email-address"),
    ("drivers.0.driversLicenseNumber", "#applicant-drivers-license-number"),
    ("drivers.0.driversLicenseState", "#applicant-drivers-license-state"),
    ("drivers.0.driversLicenseStatus", "#applicant-drivers-license-status"),
]
PRIOR_FIELDS = [
    ("carrier", "#priorCarrier"), ("liabilityLimits", "#priorLiabilityLimits"), ("policyTerm", "#priorPolicyTerm"),
    ("premium", "#priorPolicyPremium"), ("yearsWithCarrier", "#yearsWithPriorCarrier"),
    ("monthsWithCarrier", "#monthsWithPriorCarrier"), ("yearsContinuousCoverage", "#yearsWithContinuousCoverage"),
    ("monthsContinuousCoverage", "#monthsWithContinuousCoverage"),
]
HOUSEHOLD_FIELDS = [
    ("trampoline", "#trampoline-input"), ("pool", "#swimming-pool-on-premises-input"),
    ("dogs", "#dog-info-input"), ("businessOnPremises", "#business-or-daycare-on-premises-input"),
]
DRIVER_FIELDS = [
    ("firstName", "#driver-{i}-first-name"), ("lastName", "#driver-{i}-last-name"), ("dateOfBirth", "#driver-{i}-dob"),
    ("gender", "#driver-{i}-gender"), ("maritalStatus", "#driver-{i}-maritalStatus"),
    ("relationship", "#driver-{i}-relationship"), ("industry", "#driver-{i}-occupationIndustry"),
    ("occupation", "#driver-{i}-occupationTitle"), ("driversLicenseStatus", "#driver-{i}-driversLicenseStatus"),
    ("ageFirstLicensed", "#driver-{i}-ageLicensed"), ("driversLicenseNumber", "#textD{n}DLNumber"),
    ("driversLicenseState", "#drpD{n}DLState"), ("goodStudent", "#driver-{i}-isGoodStudent"),
    ("suspensions", "#driver-{i}-hasLicenseBeenSuspendedRecently"), ("ratedDriver", "#driver-{i}-ratedDriver"),
]
VEHICLE_FIELDS = [  # VIN goes first on its own: the lookup fills year/make/model
    ("year", "#selected-year-{i}"), ("make", "#selected-make-{i}"), ("model", "#selected-model-{i}"),
    ("subModel", "#selected-subModel-{i}"), ("purchaseDate", "#vehiclePurchaseDate-{i}"),
    ("use", "#selected-use-{i}"), ("oneWayMiles", "#oneWayMiles-{i}"), ("daysPerWeek", "#selected-daysPerWeek-{i}"),
    ("weeksPerMonth", "#selected-weeksPerMonth-{i}"), ("annualMiles", "#annual-miles-{i}"),
    ("ownership", "#selected-ownershipType-{i}"), ("antiTheft", "#selected-antiTheft-{i}"),
    ("telematics", "#telematics-{i}"), ("costNew", "#textV{n}CostNew"),
]
AUTO_COVERAGE_FIELDS = [
    ("bodilyInjury", "#bodily-injury"), ("propertyDamage", "#property-damage"),
    ("uninsuredMotorist", "#uninsured-motorist"), ("underinsuredMotorist", "#underinsured-motorist"),
    ("medicalPayments", "#medical-payments"), ("mnPipOption", "#MNPIPOptions"),
    ("mnPipDeductible", "#MNPIPDeductible"), ("mnWorkLoss", "#MNWorkLoss"),
    ("applyToAllVehicles", "#apply-coverage-to-all-vehicles-input"),
]
VEHICLE_COVERAGE_FIELDS = [
    ("comprehensiveDeductible", "#vehicle-{i}-comprehensive"), ("collisionDeductible", "#vehicle-{i}-collision"),
    ("towingAndLabor", "#vehicle-{i}-towingAndLabor"), ("extendedTransportation", "#vehicle-{i}-extTransExpense"),
    ("fullGlass", "#vehicle-{i}-fullGlass-input"),
]
DWELLING_FIELDS = [
    ("usage", "#dwellingUsage"), ("occupancy", "#dwellingOccupancy"), ("dwellingType", "#dwellingType"),
    ("numberOfOccupants", "#numberOfOccupants"), ("stories", "#numberOfStories"), ("squareFeet", "#squareFootage"),
    ("yearBuilt", "#year-built"), ("construction", "#constructionStyle"), ("roofType", "#roofType"),
    ("roofDesign", "#roofDesign"), ("foundation", "#foundationType"), ("exteriorWalls", "#exteriorWalls"),
    ("fullBaths", "#numberOfFullBaths"), ("halfBaths", "#numberOfHalfBaths"), ("heating", "#heatingType"),
    ("hydrantDistance", "#feetFromHydrant"), ("protectionClass", "#protectionClass"),
    ("purchaseDate", "#purchaseDate"), ("distanceFromFireStation", "#distanceFromFireStation"),
    ("updates.roofYear", "#yearUpdatedRoofing"), ("updates.electricalYear", "#yearUpdatedElectrical"),
    ("updates.plumbingYear", "#yearUpdatedPlumbing"), ("updates.heatingYear", "#yearUpdatedHeating"),
]
HOME_COVERAGE_FIELDS = [
    ("otherStructures", "#other-structure"), ("personalProperty", "#personal-property"),
    ("lossOfUse", "#loss-of-use"), ("lossOfUseAmount", "#loss-of-use-amount"),
    ("personalLiability", "#personalLiability"), ("medicalPayments", "#medicalPayments"),
    ("allPerilsDeductible", "#allPerilsDeductible"), ("windDeductible", "#windDeductible"),
    ("theftDeductible", "#theftDeductible"),
]


def _get(obj: Any, path: str) -> Any:
    for part in path.split("."):
        if isinstance(obj, list) and part.isdigit():
            obj = obj[int(part)] if int(part) < len(obj) else None
        elif isinstance(obj, dict):
            obj = obj.get(part)
        else:
            return None
    return obj


def _rce(facts: dict[str, Any]) -> Any:
    return _get(facts, "dwelling.estimatedReplacementCost") or _get(facts, "homeCoverage.dwelling")


def plan_fields(facts: dict[str, Any], lob: str, route: str, slots: dict[str, dict[int, int]] | None = None) -> list[tuple[str, Any]]:
    """The (selector, value) writes the facts ask for on one screen. Screens not
    listed here are handled by rules, questions and the facts' raw `fields` map."""
    slots = slots or {}
    edits: list[tuple[str, Any]] = []

    def add(selector: str, value: Any) -> None:
        if value is not None and value != "":
            edits.append((selector, value))

    if route == "details":
        for path, selector in APPLICANT_FIELDS:
            add(selector, _get(facts, path))
    elif route == "rating" and lob == "home":
        add("#policyFormType", _get(facts, "homeCoverage.policyFormType"))
    elif route == "policy-info":
        prior = facts.get("priorAuto" if lob == "auto" else "priorHome") or {}
        for key, selector in PRIOR_FIELDS:
            if lob == "home" and key == "liabilityLimits":
                continue
            add(selector, prior.get(key))
        if lob == "auto":
            add("#newPolicyTerm", facts.get("newPolicyTerm"))
        add("#package", facts.get("quoteAsPackage"))
        if _get(facts, "creditAuthorization.authorized") is True:
            add("#creditCheckAuthorized", "Yes")
        if lob == "home":
            for key, selector in HOUSEHOLD_FIELDS:
                add(selector, _get(facts, f"household.{key}"))
    elif route == "drivers-compact":
        for fact_index, page_index in sorted(slots.get("drivers", {}).items()):
            driver = (facts.get("drivers") or [])[fact_index]
            for key, selector in DRIVER_FIELDS:
                value = driver.get(key)
                if key == "ratedDriver" and driver.get("excluded"):
                    value = "Excluded"
                add(selector.format(i=page_index, n=page_index + 1), value)
    elif route == "vehicles-compact":
        for fact_index, page_index in sorted(slots.get("vehicles", {}).items()):
            vehicle = (facts.get("vehicles") or [])[fact_index]
            for key, selector in VEHICLE_FIELDS:
                if key in ("year", "make", "model") and vehicle.get("vin"):
                    continue  # the VIN lookup owns these
                add(selector.format(i=page_index, n=page_index + 1), vehicle.get(key))
        # EZLynx numbers this grid vehicle-from-1, driver-from-0 (#vehicle-assignment-1-0 in the recordings).
        for v, row in enumerate(facts.get("driverVehicleAssignment") or []):
            page_vehicle = slots.get("vehicles", {}).get(v)
            for d, percent in enumerate(row):
                page_driver = slots.get("drivers", {}).get(d)
                if page_vehicle is not None and page_driver is not None:
                    add(f"#vehicle-assignment-{page_vehicle + 1}-{page_driver}", percent)
    elif route == "coverage" and lob == "auto":
        for key, selector in AUTO_COVERAGE_FIELDS:
            add(selector, _get(facts, f"autoCoverage.{key}"))
        for fact_index, page_index in sorted(slots.get("vehicles", {}).items()):
            vehicle = (facts.get("vehicles") or [])[fact_index]
            for key, selector in VEHICLE_COVERAGE_FIELDS:
                add(selector.format(i=page_index), vehicle.get(key))
    elif route == "dwelling-info":
        for key, selector in DWELLING_FIELDS:
            add(selector, _get(facts, f"dwelling.{key}"))
    elif route == "coverage" and lob == "home":
        # Every recording types Dwelling and Est. Replacement Cost together, equal.
        add("#dwelling", _get(facts, "homeCoverage.dwelling") or _rce(facts))
        add("#estReplacementCost", _rce(facts))
        for key, selector in HOME_COVERAGE_FIELDS:
            add(selector, _get(facts, f"homeCoverage.{key}"))
    elif route == "endorsements":
        for selector, value in (_get(facts, "homeCoverage.endorsements") or {}).items():
            add(selector, value)
    elif route == "carrier-questions":
        for selector, value in (facts.get("carrierAnswers") or {}).items():
            add(selector, value)

    for selector, value in ((facts.get("fields") or {}).get(f"{lob}/{route}") or {}).items():
        add(selector, value)
    return edits


def _derived_answer(selector: str, job: "Job", lob: str) -> Any:
    """Carrier answers the recordings show following from other facts. (AAA
    "membership since" is not one: Salwa typed 2025 twice for 2026 effective
    dates — it is the client's own year, so it is asked.)"""
    name = selector.strip("#[]\"").replace('id="', "")
    vehicles = job.vehicle_count or len([v for v in job.facts.get("vehicles") or [] if not v.get("remove")]) or None
    if name.startswith(("coveragehome_mn", "marketvalue_autoowners")):  # recs 3, 5: the RCE
        return _rce(job.facts) or job.memo.get("rce")
    if name.startswith(("alliednumvehicles", "numveh_common")) and vehicles:  # recs 3, 5
        return str(vehicles)
    if name.startswith("multicardiscount") and vehicles:
        return "Yes" if vehicles > 1 else "No"
    if name.startswith("multipolicyhome") and len(job.lobs) == 2:
        return "Yes"
    return None


# Validation texts the recordings show, and what the human did about each.
RULE_EFFECTIVE = re.compile(r"effective date.*(past|in past)|invalid effective date", re.I)
RULE_PRIOR_STALE = re.compile(r"expiration date cannot be more than 1 year", re.I)
RULE_OLD_INCIDENT = re.compile(r"date of (violation|loss|accident) cannot be before", re.I)
RULE_COVERAGE_A = re.compile(r"coverage a or c amount of pending homeowners|market value is invalid", re.I)
RULE_NEEDS_LOOKUP = re.compile(r"^(year|make|model) is required", re.I)
INCIDENT_BUTTON = {"violation": "violation", "loss": "comp-loss", "accident": "accident"}  # #remove-{x}-btn-{i}, rec 5


# ------------------------------------------------ evidence the associates read
# A requote starts from an EZLynx task, not from the page (Salwa, Teams 2026-09-24).
# Titles carry the instructions: "Richard Dupont - AAA 11 16 26" (carrier + date),
# "Danielle Wincek - Renews 11 23 26 Roof age 2018 Goes to Lisa" (date, roof, hand-off).

DATE_TOKEN = re.compile(r"(?<![\d/$.,])(\d{1,2})[\s/.-]+(\d{1,2})[\s/.-]+(\d{4}|\d{2})(?![\d/.,])")
LINE_WORD = re.compile(r"\b(auto|home)", re.I)
TASK_TITLE = re.compile(r"^\s*(?P<client>[^\n]{2,80}?)\s+[-–]\s+(?P<rest>.+?)(?:\s+By\s+[A-Z][\w.'-]+(?:\s+[A-Z][\w.'-]+)?\b.*)?$", re.S)
HAND_OFF = re.compile(r"\b(?i:goes\s+to)\s+([A-Z][a-z]+(?:\s+(?!By\b)[A-Z][a-z]+)?)")
ROOF_YEAR = re.compile(r"\broof\s*(?:age|year|updated|replaced)?\s*:?\s*((?:19|20)\d{2})\b", re.I)
KNOWN_CARRIERS = ["AAA", "Auto-Owners", "Progressive", "Travelers", "Safeco", "Liberty Mutual", "State Farm", "Farmers",
                  "American Family", "Allied", "Nationwide", "Hartford", "GEICO", "Acuity", "Encova", "Foremost",
                  "National General", "NatGen", "Allstate", "Westfield", "Cincinnati", "Grange", "Kemper", "Bristol West",
                  "Dairyland", "Western National", "North Star", "Openly", "Branch", "Stillwater", "Universal", "Mercury"]
TERM_OPTION = re.compile(r"(\d{1,2}/\d{1,2}/\d{4})\s*-\s*([A-Z]{2,5})\s*-\s*\$?\s*([\d,]+(?:\.\d+)?)")
VIN_TOKEN = re.compile(r"\b(?=[A-HJ-NPR-Z0-9]*\d)(?=[A-HJ-NPR-Z0-9]*[A-HJ-NPR-Z])[A-HJ-NPR-Z0-9]{17}\b")
POLICY_STATUS = re.compile(r"^\s*(Active|Pending|Cancel\w*|Expired|Non-?Renew\w*|Lapsed|Quot\w*|Rewrit\w*|Future)\s+(.+?)\s*\|\s*(\S+)\s*(.*)$", re.I)


def _task_dates(text: str | None, today: date) -> dict[str | None, date]:
    """Future dates in a task title, keyed by the line named just before them
    ("Home Renews 11 14 26") or None. Past dates are last year's, not a renewal."""
    found: dict[str | None, date] = {}
    text = text or ""
    # 'Call back 10 01 26, renews 11 16 26': the renewal is the one said to renew.
    marked = [m for m in DATE_TOKEN.finditer(text) if re.search(r"(?i)\b(renew\w*|rwl|exp\w*|eff\w*)\W{0,12}$", text[:m.start()])]
    for m in marked or list(DATE_TOKEN.finditer(text)):
        year = int(m.group(3))
        year += 2000 if year < 100 else 0
        try:
            day = date(year, int(m.group(1)), int(m.group(2)))
        except ValueError:
            continue
        if today < day <= today + timedelta(days=400):
            before = LINE_WORD.findall(text[max(0, m.start() - 40):m.start()].split("\n")[-1])
            found.setdefault(before[-1].lower() if before else None, day)
    return found


def _parse_task(text: str, today: date) -> dict[str, Any]:
    """One task line from the associate's task list: whose it is and what it says."""
    text = re.sub(r"\s+", " ", text or "").strip()
    m = TASK_TITLE.match(text)
    client, rest = (m.group("client").strip(), m.group("rest").strip()) if m else ("", text)
    rest = re.sub(r"\s+\d+/\d+\s+completed\b.*$", "", rest)
    # As written (AAA, GEICO, Auto-Owners — 'openly shopping' is not Openly), the first one named.
    hits = [(m.start(), c) for c in KNOWN_CARRIERS if (m := re.search(rf"(?<![\w-]){re.escape(c)}(?![\w-])", rest))]
    carrier = min(hits)[1] if hits else None
    hand_off, roof = HAND_OFF.search(rest), ROOF_YEAR.search(rest)
    return {"client": client, "title": rest, "dates": _task_dates(rest, today), "carrier": carrier,
            "handOffTo": hand_off.group(1) if hand_off else None, "roofYear": roof.group(1) if roof else None,
            "lines": sorted(set(w.lower() for w in LINE_WORD.findall(rest)))}


NICKNAMES = [{"anthony", "tony"}, {"richard", "rick", "dick", "rich"}, {"robert", "bob", "rob", "bobby"},
             {"william", "bill", "will", "billy"}, {"james", "jim", "jimmy"}, {"michael", "mike"}, {"thomas", "tom", "tommy"},
             {"joseph", "joe"}, {"daniel", "dan", "danny"}, {"david", "dave"}, {"steven", "steve"}, {"stephen", "steve"},
             {"katherine", "kathy", "kate", "katie"}, {"catherine", "cathy", "kate"}, {"elizabeth", "liz", "beth", "betsy"},
             {"margaret", "maggie", "peggy"}, {"susan", "sue", "suzy"}, {"patricia", "patty", "pat"}, {"patrick", "pat"},
             {"jennifer", "jen", "jenny"}, {"christopher", "chris"}, {"christine", "chris"}, {"kenneth", "ken"},
             {"edward", "ed", "eddie"}, {"charles", "chuck", "charlie"}, {"gregory", "greg"}, {"timothy", "tim"},
             {"kurt", "curt", "curtis"}, {"deborah", "deb", "debbie"}, {"allen", "al"}, {"albert", "al"}]


def _name_match(name: str, first: str, last: str) -> int:
    """A task's client vs the applicant: 2 = the same first name (or a known
    nickname of it — the recordings' 'Tony' is the task's 'Anthony') and last
    name, 1 = the last name only, 0 = no. Never a guess from a shared prefix:
    Christine is not Christopher, Danielle is not Daniel."""
    words = [w for w in re.findall(r"[a-z'-]+", _norm(name)) if len(w) > 1]
    f, la = _norm(first).split(" ")[0], _norm(last).split(" ")[-1]
    if not la or la not in words:
        return 0
    others = [w for w in words if w != la]
    same = lambda w: w == f or any(w in group and f in group for group in NICKNAMES)
    return 2 if f and any(same(w) for w in others) else 1


def _parse_term(option: str) -> dict[str, Any] | None:
    """'11/24/2026 - RWL - $4052.55' from the applicant portal's term list."""
    m = TERM_OPTION.search(option or "")
    if not m:
        return None
    return {"date": _date(m.group(1)), "type": m.group(2), "premium": _num(m.group(3))}


def _parse_policy(text: str) -> dict[str, Any] | None:
    """'Active Personal Auto | 5629572700 Auto-Owners Insurance Company assignment'
    from the account overview. Carrier words stop at the first icon ligature."""
    m = POLICY_STATUS.match(re.sub(r"\s+", " ", text or ""))
    if not m:
        return None
    kind = m.group(2).lower()
    lob = ("auto" if "auto" in kind else None if re.search(r"dwelling fire|landlord|\bdp\b|rental", kind)
           else "home" if re.search(r"home|condo|renter|ho\d", kind) else None)
    words = []
    for word in m.group(4).split():
        if re.fullmatch(r"[a-z_]+", word) and word not in ("of", "and", "the", "&"):
            break
        if re.match(r"\d{1,2}/\d{1,2}/|\$", word):
            break
        words.append(word)
    return {"status": m.group(1).title(), "type": m.group(2), "lob": lob, "number": m.group(3), "carrier": " ".join(words)}


def _carrier_short(name: str | None) -> str:
    """'Auto-Owners Insurance Company' -> 'Auto-Owners', 'AAA – Auto Club Group –
    Insurance Link' -> 'AAA': the form EZLynx's Prior Carrier list uses."""
    name = re.split(r"\s+[–-]\s+|\s*\(", (name or "").strip())[0]
    name = re.sub(r"\b(insurance|ins\.?|company|co\.?|inc\.?|group|corporation|corp\.?)\b", "", name, flags=re.I)
    return re.sub(r"\s+", " ", name).strip(" ,.-")


def _carrier_key(name: str | None) -> str:
    return re.sub(r"^the\s+", "", _norm(_carrier_short(name)))


def _limit_key(bodily_injury: str | None) -> str | None:
    """The Prior Liability Limits option that matches a Bodily Injury limit:
    '500 CSL -or- 500/500/500' -> '500CSL', '250/500/100' -> '250/500'."""
    text = _norm(bodily_injury)
    if not text or "no coverage" in text:
        return None
    if "csl" in text:
        m = re.search(r"(\d+)\s*csl", text)
        return f"{m.group(1)}CSL" if m else None
    m = re.search(r"(\d+)\s*/\s*(\d+)", text)
    return f"{m.group(1)}/{m.group(2)}" if m else None


def _bundle_effective(candidates: list[tuple[date, str]], today: date, max_days: int) -> tuple[date, str] | None:
    """One date for every line (Salwa: the bundle is quoted on one date), the
    earliest the evidence gives — never later than carriers will qualify
    (~60 days: 9/23 -> 11/22 in recs 0-2, 9/22 -> 11/21 in rec 4)."""
    future = sorted(((d, i, why) for i, (d, why) in enumerate(candidates) if d and d > today))
    future = [(d, why) for d, _, why in future]
    if not future:
        return None
    day, why = future[0]
    cap = today + timedelta(days=max_days)
    if day > cap:
        return cap, f"{why}, moved to {cap.strftime(DATE_FORMAT)} — carriers will not qualify a quote more than {max_days} days out"
    return day, why


def _parse_lines(text: str) -> list[str] | None:
    parts = set(re.findall(r"auto|home", _norm(text)))
    lobs = [lob for lob in ("auto", "home") if lob in parts] or (["auto", "home"] if "both" in _norm(text) else [])
    return lobs or None


def _suggest_effective(current_effective: Any, prior_expiration: Any, today: date) -> date:
    """The renewal date: a prior policy expiring within the year renews then;
    otherwise roll the old date forward by whole years (recs 4 and 5 land exactly)."""
    prior, current = _date(prior_expiration), _date(current_effective)
    if prior and today < prior <= today + timedelta(days=366):
        return prior
    base = prior or current or today
    while base <= today:
        try:
            base = base.replace(year=base.year + 1)
        except ValueError:  # 29 February
            base = base + timedelta(days=365)
    return base


# ================================================================ results

ERROR_CLASSES = [
    ("access", re.compile(r"do not have access|InsuranceLink|carrier login|password", re.I)),
    ("redirect", re.compile(r"quote and issue system|use the \w+ quote", re.I)),
    ("decline", re.compile(r"not a market|ineligible|does not meet|underwriting (guidelines|standard)|roofs? that are over", re.I)),
    ("fixable", re.compile(r"has been changed|please select|is invalid|is required", re.I)),
    ("transient", re.compile(r"did not return a quote|error processing|contact ezlynx|timed? ?out", re.I)),
]
LIST_PREMIUM = re.compile(r"\$([\d,]+\.\d{2})\s+(\d+)\s*mo\s*\(([^)]+)\)")
GRAPH_PACKAGE = re.compile(r"\$([\d,]+)\s+directions_car\s+\$([\d,]+)\s+home\s+\$([\d,]+)\s*/\s*(\d+)\s*mo")
GRAPH_SINGLE = re.compile(r"(directions_car|home)\s+\$([\d,]+)\s*/\s*(\d+)\s*mo")
CARD_ERROR = re.compile(r"Carrier (?:Error|error|Notice)\s*:?\s*(.+?)(?:\s*Report error\s*$|$)")
ALT_QUOTE = re.compile(r"Alt Quote\s+(.+?)\s+(?:View more details|directions_car|home\b|\$)")


def parse_card(card: dict[str, Any]) -> dict[str, Any]:
    text = card.get("text") or ""
    icons = card.get("icons") or []
    # Graph view tags each premium graph-{carrierId}-{auto|home}; that is the reliable line marker.
    graph_lobs = {i.rsplit("-", 1)[-1] for i in card.get("graphIds") or [] if i.count("-") >= 2}
    lob = next(iter(graph_lobs)) if len(graph_lobs) == 1 else None
    if lob is None and len(graph_lobs) < 2:
        lob = "auto" if "directions_car" in icons else "home" if "home" in icons else None
    answer = card.get("answerId") or ""
    if answer.endswith("-Auto"):
        lob = "auto"
    elif answer.endswith("-Home"):
        lob = "home"
    out: dict[str, Any] = {"carrier": card.get("carrier") or None, "lob": lob}
    carrier_id = re.match(r"(?:graph|answer-questions)-(\d+)-", (card.get("graphIds") or [answer])[0] or "")
    if carrier_id:
        out["carrierId"] = carrier_id.group(1)
    alt = ALT_QUOTE.search(text)
    if alt:
        out["altQuote"] = alt.group(1)
    error = CARD_ERROR.search(text)
    if error:
        message = error.group(1).strip()
        out["error"] = message
        out["errorClass"] = next((name for name, pattern in ERROR_CLASSES if pattern.search(message)), "other")
    if "needs more information" in text:
        out["needsAnswers"] = True
    if (m := LIST_PREMIUM.search(text)):
        out.update(premium=float(m.group(1).replace(",", "")), termMonths=int(m.group(2)), basis=m.group(3))
    elif (m := GRAPH_PACKAGE.search(text)):
        out.update(lob="package", premium=float(m.group(3).replace(",", "")), termMonths=int(m.group(4)),
                   components={"auto": float(m.group(1).replace(",", "")), "home": float(m.group(2).replace(",", ""))})
    elif (m := GRAPH_SINGLE.search(text)):
        out.update(lob="auto" if m.group(1) == "directions_car" else "home",
                   premium=float(m.group(2).replace(",", "")), termMonths=int(m.group(3)))
    if out.get("premium") and out.get("termMonths"):
        out["annualPremium"] = round(out["premium"] * 12 / out["termMonths"], 2)
    if not any(k in out for k in ("premium", "error", "needsAnswers")):
        out["pending"] = True
    return out


def build_report(account_id: str, results_url: str | None, quote_cards: list[dict[str, Any]],
                 error_cards: list[dict[str, Any]], dropped: list[dict[str, Any]], lobs: list[str]) -> dict[str, Any]:
    """Quotes from the graph view (it splits auto/home and packages), errors from
    the list view (graph view hides error cards until "View errors")."""
    parsed = [parse_card(card) for card in quote_cards]
    errors = [parse_card(card) for card in error_cards]
    for p in parsed + errors:
        if p.get("lob") is None and len(lobs) == 1:
            p["lob"] = lobs[0]
    quotes = sorted((p for p in parsed if p.get("premium")), key=lambda p: p.get("annualPremium") or 1e12)
    return {
        "accountId": account_id,
        "generatedAt": _now(),
        "resultsUrl": results_url,
        "lines": lobs,
        "quotes": quotes,
        "errors": [p for p in errors if p.get("error") and not p.get("premium")],
        "stillRating": sum(1 for p in parsed if p.get("pending")),
        "needsAnswers": [p for p in parsed if p.get("needsAnswers")],
        "droppedCarriers": dropped,
    }


async def _read_results(b: Browser, tab: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str]:
    """(cards to quote from, cards to take errors from, path)."""
    data = await b.evaluate(tab, JS_RESULTS)
    graph = data["cards"] if data.get("graphView") else None
    if data.get("graphView"):  # rec 5 flips to list view to see every card
        with suppress(CamofoxError, httpx.HTTPError):
            await b.click(tab, 'mat-slide-toggle:has-text("Graph View") button')
            await _settle(b, tab, 10)
            data = await b.evaluate(tab, JS_RESULTS)
    if data.get("viewErrors"):
        with suppress(CamofoxError, httpx.HTTPError):
            await b.click(tab, 'button:has-text("View errors")')
            await _settle(b, tab, 10)
            data = await b.evaluate(tab, JS_RESULTS)
    return graph or data["cards"], data["cards"], data.get("path") or ""


# ================================================================ facts

def _deep_merge(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    """Dicts merge, anything else (lists too) replaces, an explicit null deletes."""
    merged = dict(base)
    for key, value in patch.items():
        if value is None:
            merged.pop(key, None)
        elif isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def _fan_out_rce(old: dict[str, Any], new: dict[str, Any]) -> dict[str, Any]:
    """A new replacement cost lands in Dwelling (Coverage A) too, and in every
    carrier answer that held the old one — recs 3 and 5 retype it into
    #coveragehome_mn__105 and #marketvalue_autoownersxml__105."""
    old_rce, new_rce = _rce(old), _get(new, "dwelling.estimatedReplacementCost")
    if not new_rce or new_rce == old_rce:
        return new
    out = dict(new)
    out["homeCoverage"] = {**(out.get("homeCoverage") or {}), "dwelling": new_rce}
    answers = out.get("carrierAnswers")
    if isinstance(answers, dict) and old_rce is not None:
        out["carrierAnswers"] = {k: (str(new_rce) if _same(v, old_rce) else v) for k, v in answers.items()}
    return out


def _same_fact_row(key: str, a: dict[str, Any], b: dict[str, Any]) -> bool:
    if key == "drivers":
        return bool(_norm(a.get("lastName"))) and all(_norm(a.get(k)) == _norm(b.get(k)) for k in ("firstName", "lastName"))
    return bool(_norm(a.get("vin"))) and _norm(a.get("vin")) == _norm(b.get("vin"))


def _amend_facts(facts: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    """A correction on top of a job's facts: like _deep_merge, but a driver or
    vehicle row updates the fact row it names (name / VIN) or is added — so
    'also add Abigail' does not wipe the other rows already given."""
    rows = {k: patch[k] for k in ("drivers", "vehicles") if isinstance(patch.get(k), list)}
    merged = _fan_out_rce(facts, _deep_merge(facts, {k: v for k, v in patch.items() if k not in rows}))
    for key, updates in rows.items():
        out = [dict(r) for r in merged.get(key) or []]
        for update in updates:
            hit = next((r for r in out if _same_fact_row(key, r, update)), None)
            if hit is None:
                out.append(dict(update))
            else:
                hit.update(update)
        merged[key] = out
    return merged


def _infer_lines(facts: dict[str, Any]) -> str | None:
    auto = bool(facts.get("vehicles") or facts.get("drivers")) or "autoCoverage" in facts or "priorAuto" in facts
    home = any(k in facts for k in ("dwelling", "homeCoverage", "priorHome"))
    return ",".join(p for p, on in (("auto", auto), ("home", home)) if on) or None


def _lobs(lines: str) -> list[str]:
    parts = {p.strip().lower() for p in lines.split(",")}
    lobs = [lob for lob in ("auto", "home") if lob in parts]  # auto first, as recs 3 and 5
    if not lobs:
        raise ToolError('lines must be "auto", "home", or "auto,home".')
    return lobs


def _missing(facts: dict[str, Any], lobs: list[str], new_applicant: bool) -> list[str]:
    """What EZLynx cannot create an applicant without (the create-page errors in
    recs 2 and 6), asked in chat for free instead of mid-run. An existing account
    needs nothing: EZLynx already holds it."""
    missing = []
    if new_applicant:
        for path in ("applicant.firstName", "applicant.lastName", "applicant.dateOfBirth", "applicant.gender",
                     "applicant.maritalStatus", "applicant.industry", "applicant.occupation", "applicant.phone",
                     "address.line1", "address.city", "address.state", "address.postalCode"):
            if not _get(facts, path):
                missing.append(path)
        if "auto" in lobs and not any(v.get("vin") or v.get("year") for v in facts.get("vehicles") or []):
            missing.append("vehicles[] — a VIN, or year/make/model, for each vehicle")
        if "home" in lobs and not _rce(facts):
            missing.append("dwelling.estimatedReplacementCost — the RCE figure")
    return missing


def _redact(value: Any, key: str = "") -> Any:
    if isinstance(value, dict):
        return {k: _redact(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact(v, key) for v in value]
    lowered = key.lower()
    if "ssn" in lowered or "socialsecurity" in lowered:
        return "•••"
    if key == "driversLicenseNumber" and isinstance(value, str) and value:
        return "…" + value[-4:]
    if key == "dateOfBirth":
        parsed = _date(value)
        return f"xx/xx/{parsed.year}" if parsed else "xx/xx/xxxx"
    if isinstance(value, str):
        return SSN_VALUE.sub("•••", value)
    return value


def _mask(hint: str, value: Any) -> Any:
    """What a field's value may look like in anything the model sees. `hint` is a
    selector or label: SSNs vanish, licence numbers keep 4 digits, birth dates the year."""
    if not isinstance(value, str) or not value:
        return value
    h = _norm(hint).replace("_", "-")
    if "ssn" in h or "social" in h:
        return "•••"
    if "dlnumber" in h or "license-number" in h or "license number" in h or h.startswith("dl#"):
        return "…" + value[-4:]
    if "dob" in h or "birth" in h:
        parsed = _date(value.strip())
        return f"xx/xx/{parsed.year}" if parsed else "xx/xx/xxxx"
    return SSN_VALUE.sub("•••", value)


def _mask_control(control: dict[str, Any]) -> dict[str, Any]:
    control["value"] = _mask(f"{control.get('label') or ''} {control.get('selector') or ''}", control.get("value"))
    return control


def _log_change(job: "Job", result: dict[str, Any], source: str) -> None:
    selector = result["selector"]
    job.changes.append({"step": job.step, "selector": selector, "from": _mask(selector, result.get("from")),
                        "to": _mask(selector, result.get("value")), "source": source})


# Learned carrier answers and reports ride in the sealed quotes table under
# reserved keys, so they are encrypted and store.forget() clears them too.
ANSWERS_KEY = "_carrier_answers"

# Agency-wide knowledge — every associate gets it, not only whoever taught it —
# lives under a reserved store user: the defaults below and remembered answers.
AGENCY = "_agency"
AGENCY_DEFAULTS_KEY = "defaults"
# Seeded from what Salwa Noor did in all 8 recordings of salwa_noor.csv. Whether
# each is agency policy or her own habit is the agency's call: every one is shown
# in the requote brief (so any associate can decline it per client) and can be
# changed with set_agency_defaults.
AGENCY_SEED: dict[str, Any] = {
    "maxDaysAhead": 60,  # "carriers generally won't qualify a quote more than 60 days out"
    "bundleWhenBothExist": True,  # "clients ask us to quote the bundle even when only one line renews"
    "priorCarrierFromCurrentPolicy": True,  # recs 2, 3, 5: prior carrier set to the in-force carrier
    "priorLimitsFromCoverage": True,  # recs 3, 6: prior liability limits set to match Bodily Injury
    "carriers": {
        # auto: GEICO in 4, The Hartford in 3, AAA in 2 of the sessions that changed carriers, plus "Select All Carriers"
        "auto": {"mode": "all-non-preferred", "include": ["AAA", "The Hartford", "GEICO"]},
        # home: AAA and The Hartford switched on in 7 of 7, Universal switched off in 5
        "home": {"include": ["AAA", "The Hartford"], "exclude": ["Universal"]},
    },
    "commuteOneWayMiles": 8,  # recs 0, 1, 2, 6: commuters set to 8 miles one way (8,840 a year)
    "fields": {"auto/coverage": {"#agencyalliedxml": "Yes"}},  # recs 0, 3, 6, 7
    "rememberedAnswers": {"#aaasafetymichigan{n}": "No"},  # recs 1, 3: AAA vehicle-safety question
}
FIELD_NAMES = {"#agencyalliedxml": "Allied agency relationship"}


AGENCY_ADMINS = {u.strip() for u in os.environ.get("EZLYNX_AGENCY_ADMINS", "").split(",") if u.strip()}
FORBIDDEN_FIELD = re.compile(r"(?i)credit|ssn|social|birth|dob|licen[cs]e|dlnumber|applicant-|driver-|vin|effective|expiration")


def _check_agency(d: dict[str, Any]) -> list[str]:
    """Agency defaults are read by every associate's run: one malformed value
    would break them all, and a client field must never become a default."""
    problems = []
    if not (isinstance(d.get("maxDaysAhead"), int) and 1 <= d["maxDaysAhead"] <= 120):
        problems.append("maxDaysAhead must be a whole number of days from 1 to 120")
    commute = d.get("commuteOneWayMiles")
    if commute is not None and not (isinstance(commute, (int, float)) and 1 <= commute <= 100):
        problems.append("commuteOneWayMiles must be a number of miles from 1 to 100, or null")
    for flag in ("bundleWhenBothExist", "priorCarrierFromCurrentPolicy", "priorLimitsFromCoverage"):
        if not isinstance(d.get(flag, True), bool):
            problems.append(f"{flag} must be true or false")
    for lob, choice in (d.get("carriers") or {}).items():
        if lob not in ("auto", "home") or not isinstance(choice, dict) \
                or choice.get("mode") not in (None, "all", "all-preferred", "all-non-preferred") \
                or not all(isinstance(choice.get(k, []), list) and all(isinstance(n, str) for n in choice.get(k, [])) for k in ("include", "exclude")):
            problems.append(f"carriers.{lob} must be {{mode, include: [names], exclude: [names]}}")
    for route, values in (d.get("fields") or {}).items():
        if not re.fullmatch(r"(auto|home)/[a-z-]+", route) or not isinstance(values, dict):
            problems.append(f"fields.{route} must be {{'#selector': value}} under a route like 'auto/coverage'")
            continue
        for selector in values:
            if selector in STANDARD_SELECTORS or FORBIDDEN_FIELD.search(selector) or not selector.startswith("#"):
                problems.append(f"{selector} is a client's own field, not an agency default")
    for key, value in (d.get("rememberedAnswers") or {}).items():
        if not _rememberable(key.replace("{n}", "1")) or not isinstance(value, str):
            problems.append(f"rememberedAnswers.{key} must be a carrier question with a text answer")
    return problems


def _agency() -> dict[str, Any]:
    return store.read_quote(AGENCY, AGENCY_DEFAULTS_KEY) or copy.deepcopy(AGENCY_SEED)


def _answer_key(selector: str) -> str:
    """Per-vehicle carrier questions (#aaasafetymichigan1, 2, 3) share one answer."""
    bare = selector.strip("#[]\"").replace('id="', "")
    m = re.fullmatch(r"([a-z][a-z_]*?)(\d+)", bare)
    return f"#{m.group(1)}{{n}}" if m and "__" not in bare else f"#{bare}"


STANDARD_SELECTORS = {s for table in (APPLICANT_FIELDS, PRIOR_FIELDS, HOUSEHOLD_FIELDS, AUTO_COVERAGE_FIELDS,
                                      DWELLING_FIELDS, HOME_COVERAGE_FIELDS) for _, s in table} | {
    "#dwelling", "#estReplacementCost", "#package", "#policyFormType", "#newPolicyTerm", "#creditCheckAuthorized"}


def _rememberable(selector: str) -> bool:
    """Carrier questions only — #{question}__{carrierId}, or a carrier's own
    lower-case id like #aaasafetymichigan1 — never a client's own fields."""
    bare = selector.strip("#[]\"").replace('id="', "")
    if CARRIER_QUESTION.search(bare):
        return True
    return bool(re.fullmatch(r"[a-z][a-z0-9_]*", bare)) and f"#{bare}" not in STANDARD_SELECTORS


def _learned(user: str) -> dict[str, Any]:
    """Carrier answers: the associate's own one-off answers (suggestions only),
    under the agency's seeded defaults, under answers someone told the agency to
    remember (applied for every associate without asking)."""
    own = {_answer_key(k): {**v, "auto": False} for k, v in (store.read_quote(user, ANSWERS_KEY) or {}).items()}
    seeded = {k: {"value": v, "auto": True, "from": "agency default"} for k, v in (_agency().get("rememberedAnswers") or {}).items()}
    agency = {k: v for k, v in (store.read_quote(AGENCY, ANSWERS_KEY) or {}).items() if v.get("auto")}
    return {**own, **seeded, **agency}


def _learn(selector: str, value: str, remember: bool, user: str) -> None:
    """remember=True: the agency's answer from now on, for everyone. Otherwise a
    suggestion for this associate only — never over an agency answer, and never
    another client's typed data (only pick-list answers are kept)."""
    key, value = _answer_key(selector), _mask(selector, value)
    if remember:
        learned = store.read_quote(AGENCY, ANSWERS_KEY) or {}
        learned[key] = {"value": value, "auto": True, "by": user, "at": _now()}
        store.save_quote(AGENCY, ANSWERS_KEY, learned)
        return
    if (_learned(user).get(key) or {}).get("auto"):
        return
    own = store.read_quote(user, ANSWERS_KEY) or {}
    own[key] = {"value": value, "auto": False}
    store.save_quote(user, ANSWERS_KEY, own)


def _report_key(account_id: str) -> str:
    return f"{account_id}:report"


# ================================================================ jobs

@dataclass
class Question:
    id: str
    kind: str  # brief | field | option | roster | lines | credit | effective_date | carriers | finish_invalid | stuck | submit_approval
    prompt: str
    options: list[str] | None
    suggestion: str | None
    context: dict[str, Any]
    asked_at: str
    future: asyncio.Future

    def view(self) -> dict[str, Any]:
        out = {"questionId": self.id, "kind": self.kind, "prompt": self.prompt, "askedAt": self.asked_at}
        if self.options:
            out["options"] = self.options[:60]
        if self.suggestion:
            out["suggestion"] = self.suggestion
        if self.context:
            out["context"] = self.context
        out["answerWith"] = ANSWER_HELP.get(self.kind, "")
        return out


ANSWER_HELP = {
    "brief": ("'ok' to go ahead with everything listed; 'ok except P2 P5' to leave proposals out; add "
              "'effective 11/22/2026', 'rce 424000' or 'lines auto,home' to change those. For anything else "
              "(a new driver, a coverage change) call amend_job(job_id, changes) first, then answer 'ok'. 'stop' ends the job."),
    "field": "the value, 'skip', 'done' after fixing it with set_fields, or 'drop' to drop this carrier",
    "option": "one of the options, 'skip', or 'done' after fixing it with set_fields",
    "roster": "'keep', 'remove', or one of the 'use for ...' options",
    "lines": "'auto', 'home' or 'auto,home' (or one of the options)",
    "add_line": "'start <line>' to create that application in EZLynx; anything else leaves the line out",
    "credit": "who authorized the credit check and how (e.g. 'Patrick Cain by phone'), or 'no'",
    "effective_date": "a date like 11/14/2026, or 'ok' for the suggestion",
    "carriers": "'all', 'template:<name>', or carrier names separated by commas",
    "finish_invalid": "'retry' after fixing, 'drop <carrier>', or 'stop'",
    "stuck": "'retry' or 'stop'",
    "submit_approval": "call approve_submit(job_id, approved_by=<the person's name>) — or approve=false to stop",
}


@dataclass
class Job:
    id: str
    user: str
    kind: str  # quote | requote
    lobs: list[str]
    facts: dict[str, Any]
    account_id: str | None
    requested_effective: date | None
    state: str = "starting"
    step: str | None = None
    browser: Browser | None = None
    tab: str | None = None
    pending: Question | None = None
    events: list[str] = field(default_factory=list)
    changes: list[dict[str, Any]] = field(default_factory=list)
    answers: list[dict[str, Any]] = field(default_factory=list)
    dropped: list[dict[str, Any]] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)
    effective: dict[str, date] = field(default_factory=dict)
    app_ids: dict[str, str] = field(default_factory=dict)
    memo: dict[str, Any] = field(default_factory=dict)
    skipped: set[str] = field(default_factory=set)
    slots: dict[str, dict[int, int]] = field(default_factory=dict)
    vehicle_count: int | None = None
    submit_summary: dict[str, Any] | None = None
    approved_by: str | None = None
    approved_via: str | None = None
    report: dict[str, Any] | None = None
    result: dict[str, Any] | None = None
    error: str | None = None
    task: asyncio.Task | None = None
    changed: asyncio.Event = field(default_factory=asyncio.Event)
    started_at: str = field(default_factory=_now)

    def note(self, line: str) -> None:
        self.events.append(f"{datetime.now().strftime('%H:%M:%S')} {line}")
        del self.events[:-400]
        self.touch()

    def touch(self) -> None:
        self.changed.set()
        self.changed = asyncio.Event()

    async def ask(self, kind: str, prompt: str, *, options: list[str] | None = None,
                  suggestion: str | None = None, context: dict[str, Any] | None = None) -> str:
        """Park the run until a person answers. The tab stays open and is touched
        every KEEPALIVE_S so camofox does not reap it."""
        future = asyncio.get_running_loop().create_future()
        question = Question(f"q{next(_question_seq)}", kind, prompt, options, suggestion, context or {}, _now(), future)
        self.pending = question
        self.state = "awaiting_approval" if kind == "submit_approval" else "waiting_human"
        self.note(f"needs a human: {prompt.splitlines()[0][:200] if kind == 'brief' else prompt}")
        deadline = time.monotonic() + QUESTION_TTL_S
        try:
            while True:
                try:
                    answer = await asyncio.wait_for(asyncio.shield(future), timeout=KEEPALIVE_S)
                    break
                except asyncio.TimeoutError:
                    if time.monotonic() > deadline:
                        raise JobError(f"Nobody answered for {QUESTION_TTL_S / 3600:.0f} h; the run stopped. "
                                       "EZLynx kept every saved screen — start again to pick up.") from None
                    with suppress(Exception):
                        await self.browser.evaluate(self.tab, "location.pathname")
        finally:
            if self.pending is question:
                self.pending = None
        shown = _mask(f"{(context or {}).get('selector') or ''} {prompt}", str(answer)) if kind in ("field", "option") else answer
        self.answers.append({"questionId": question.id, "kind": kind, "prompt": prompt, "answer": shown, "at": _now()})
        self.state = "running"
        self.note(f"answered {question.id}: {shown}")
        return str(answer).strip()

    def view(self, events: int = 12) -> dict[str, Any]:
        out: dict[str, Any] = {
            "jobId": self.id, "kind": self.kind, "state": self.state, "lines": ",".join(self.lobs),
            "accountId": self.account_id, "step": self.step, "startedAt": self.started_at,
        }
        if self.effective:
            out["effectiveDates"] = {lob: d.strftime(DATE_FORMAT) for lob, d in self.effective.items()}
        if self.pending:
            out["question"] = self.pending.view()
        if self.pending and self.pending.kind == "brief" and self.memo.get("evidence"):
            out["evidence"] = self.memo["evidence"]  # what the brief was built from, for the associate's questions
        if self.submit_summary and self.state == "awaiting_approval":
            out["submitSummary"] = self.submit_summary
        if self.dropped:
            out["droppedCarriers"] = self.dropped
        if self.changes:
            out["changesApplied"] = len(self.changes)
        if self.problems:
            out["problems"] = self.problems[-10:]
        if self.error:
            out["error"] = self.error
        if self.result:
            out["result"] = self.result
        out["recentEvents"] = self.events[-events:]
        return out


def _release(job: Job, question: Question, answer: str) -> None:
    """Hand an answer to a parked job and show it running at once."""
    job.pending = None
    job.state = "submitting" if question.kind == "submit_approval" and answer == "approve" else "running"
    question.future.set_result(answer)
    job.touch()


def _active_job(user: str) -> Job | None:
    return next((j for j in _jobs.values() if j.user == user and j.state not in FINISHED), None)


def _require_idle(user: str) -> None:
    job = _active_job(user)
    if job is not None:
        raise ToolError(f"Job {job.id} is {job.state}. Answer it, or cancel_job('{job.id}') first.")
    if _lock(user).locked():
        raise ToolError("The EZLynx browser is busy with a lookup or login for this user. Try again shortly.")


def _job(job_id: str) -> Job:
    job = _jobs.get(job_id)
    if job is None or job.user != USER.get():
        raise ToolError(f"No job {job_id}. Jobs do not survive a server restart; EZLynx keeps what was saved.")
    return job


# ---------------------------------------------------------------- run steps

async def _apply(job: Job, selector: str, value: Any, why: str = "fact") -> None:
    """One write, with a question when the page offers no matching option."""
    b, tab = job.browser, job.tab
    try:
        result = await set_field(b, tab, selector, value)
    except FieldError as err:
        if err.options is None:
            job.problems.append(f"{job.step}: {err}")
            job.note(f"could not set {err.label or selector}: {err}")
            return
        answer = await job.ask("option", f"{err} (step {job.step}).", options=err.options,
                               context={"selector": selector, "wanted": str(value)})
        if _norm(answer) in ("skip", "done"):
            return
        await _apply(job, selector, answer, "human")
        return
    if result.get("applied"):
        _log_change(job, result, why)


async def _drop_carrier(job: Job, lob: str, carrier: str, reason: str) -> bool:
    """Toggle a carrier off on the LOB's rating screen and come back — what the
    human did in recs 1 and 3 to get past questions they would not answer."""
    b, tab = job.browser, job.tab
    here = await b.evaluate(tab, "location.pathname")
    app = job.app_ids.get(lob)
    if not app:
        return False
    await b.navigate(tab, f"{EZLYNX_BASE_URL}/web/account/{job.account_id}/rating/{lob}/{app}/rating")
    await _settle(b, tab)
    toggles = await b.evaluate(tab, JS_CARRIERS)
    wanted = carrier.strip()
    target = next((t for t in toggles if t["carrierId"] == wanted), None)
    if target is None:
        index = match_option(wanted, [t["name"] for t in toggles])
        target = toggles[index] if index is not None else None
    dropped = False
    if target and target["on"]:
        await set_field(b, tab, target["selector"], False)
        job.dropped.append({"carrier": target["name"], "lob": lob, "reason": reason, "step": job.step})
        job.note(f"dropped {target['name']} ({lob}): {reason}")
        dropped = True
    await b.navigate(tab, f"{EZLYNX_BASE_URL}{here}")
    await _settle(b, tab)
    return dropped


def _carrier_of(problem: dict[str, Any]) -> str | None:
    match = CARRIER_QUESTION.search((problem.get("selector") or "").rstrip('"]'))
    return match.group(1) if match else problem.get("carrier")


async def _resolve(job: Job, lob: str, problem: dict[str, Any]) -> bool:
    """One validation message: a rule, a fact, a derived or remembered answer —
    and only then a person. True when something on the page changed."""
    b, tab = job.browser, job.tab
    text, selector = problem["text"], problem.get("selector")
    key = f"{selector}|{text}"
    if key in job.skipped:
        return False

    if RULE_EFFECTIVE.search(text) and job.effective.get(lob):
        await _apply(job, "#effectiveDateNewPolicy", job.effective[lob].strftime(DATE_FORMAT), "rule")
        return True
    if RULE_PRIOR_STALE.search(text) and job.effective.get(lob):
        await _apply(job, "#priorPolicyExpirationDate", job.effective[lob].strftime(DATE_FORMAT), "rule")
        return True
    if (old := RULE_OLD_INCIDENT.search(text)) and await _remove_old_incident(job, INCIDENT_BUTTON[old.group(1).lower()], problem):
        return True  # recs 0 and 5: outside the lookback, deleted
    if RULE_COVERAGE_A.search(text) and selector:
        rce = _rce(job.facts) or job.memo.get("rce")
        if rce is None:
            answer = await job.ask("field", f"{text} What is the home's Coverage A / replacement cost (RCE)?",
                                   context={"selector": selector, "step": job.step})
            if _norm(answer) in ("skip", "done") or _norm(answer).startswith("drop"):
                job.skipped.add(key)
                return _norm(answer) == "done"
            amount = _money(answer)
            while amount is None or not 50_000 <= amount <= 20_000_000:
                answer = await job.ask("field", f"'{answer}' does not look like a replacement cost. The RCE, e.g. 424000?",
                                       context={"selector": selector, "step": job.step})
                if _norm(answer) in ("skip", "done") or _norm(answer).startswith("drop"):
                    job.skipped.add(key)
                    return _norm(answer) == "done"
                amount = _money(answer)
            rce = str(amount)
            # A fact, not a memo: the home line types it into Dwelling and Est. Replacement Cost too.
            job.facts = _amend_facts(job.facts, {"dwelling": {"estimatedReplacementCost": amount}})
            job.memo["rce"] = rce
        await _apply(job, selector, rce, "rule: RCE fan-out")
        return True
    if RULE_NEEDS_LOOKUP.search(text) and selector and (m := re.search(r"selected-(?:year|make|model)-(\d+)", selector)):
        vin = (await b.evaluate(tab, js_describe(f"#VIN-{m.group(1)}"))).get("value") or ""
        if len(vin.strip()) == 17 and key not in job.memo.setdefault("lookedUp", []):
            job.memo["lookedUp"].append(key)  # a saved VIN with the model blanked: look it up again (rec 5)
            await b.click(tab, f"#vin-lookup-btn-{m.group(1)}")
            await b.evaluate(tab, js_wait_value(f"#selected-model-{m.group(1)}", 12_000))
            await _settle(b, tab, 10)
            job.note(f"re-ran the VIN lookup for vehicle {int(m.group(1)) + 1} ({text})")
            return True

    if not selector:
        answer = await job.ask("field", f"EZLynx says: {text!r} on {job.step}, and no field could be tied to it. "
                                        "Fix it with read_screen/set_fields and answer 'done', or 'skip'.",
                               context={"step": job.step})
        job.skipped.add(key)
        return _norm(answer) == "done"

    value = (job.facts.get("carrierAnswers") or {}).get(selector) if selector else None
    source = "fact"
    if value is None:
        value, source = _derived_answer(selector, job, lob), "rule"
    learned = job.memo.setdefault("learned", _learned(job.user))
    remembered = learned.get(_answer_key(selector)) or {}
    if value is None and remembered.get("auto") and _answer_key(selector) not in job.memo.get("declinedAnswers", set()):
        value, source = remembered.get("value"), "remembered"
    if value is not None and not _same(value, problem.get("value")):
        await _apply(job, selector, value, source)
        return True

    carrier = _carrier_of(problem)
    label = problem.get("question") or problem.get("label") or selector
    options = await options_for(b, tab, selector) if problem.get("kind") == "mat-select" else None
    prompt = f"{label} — EZLynx: {text!r} (step {job.step})."
    answer = await job.ask("field", prompt, options=options, suggestion=remembered.get("value"),
                           context={"selector": selector, "carrier": carrier, "step": job.step})
    lowered = _norm(answer)
    if lowered in ("skip", "done"):
        job.skipped.add(key)
        return lowered == "done"
    if lowered == "drop" or lowered.startswith("drop "):
        name = answer[4:].strip() or carrier or problem.get("carrier") or ""
        dropped = await _drop_carrier(job, lob, name, text)
        job.skipped.add(key)
        return dropped
    await _apply(job, selector, answer, "human")
    if _rememberable(selector) and problem.get("kind") == "mat-select":  # this associate's suggestion next time
        _learn(selector, answer, False, job.user)
        job.memo.pop("learned", None)
    return True


async def _remove_old_incident(job: Job, kind: str, problem: dict[str, Any]) -> bool:
    """Delete a violation / comp loss / accident dated before the lookback, the way
    rec 5 did (#remove-comp-loss-btn-0, then Yes). The row index comes from the
    field's id, else from the only remove button of that kind on the page."""
    b, tab = job.browser, job.tab
    m = re.search(r"-(\d+)\W*$", problem.get("selector") or "")
    if m and problem.get("selector"):
        # Rows re-index after every removal: delete only if this row still holds the flagged date.
        now = (await b.evaluate(tab, js_describe(problem["selector"]))).get("value")
        if not _same(now, problem.get("value")):
            return False
        index = m.group(1)
    else:
        buttons = await b.evaluate(tab, _js("return qa('[id^=\"remove-' + A.kind + '-btn-\"]').filter(vis).map((e) => e.id);", kind=kind))
        if len(buttons or []) != 1:
            return False
        index = buttons[0].rsplit("-", 1)[1]
    try:
        await b.click(tab, f"#remove-{kind}-btn-{index}")
        await asyncio.sleep(0.5)
        await b.click(tab, "#dialog-confirm")
    except CamofoxError:
        return False
    await _settle(b, tab)
    job.memo["rowsChanged"] = True
    job.changes.append({"step": job.step, "selector": problem.get("selector") or f"#remove-{kind}-btn-{index}",
                        "from": problem.get("value"), "to": None, "source": f"rule: {kind.replace('-', ' ')} older than the lookback"})
    job.note(f"removed a {kind.replace('-', ' ')} dated {problem.get('value')} ({problem['text']})")
    return True


async def _resolve_screen(job: Job, lob: str, rounds: int = 4) -> None:
    for _ in range(rounds + 6):  # a removal ends a round early, so allow a few more
        scan = await job.browser.evaluate(job.tab, JS_SCAN)
        errors = [e for e in scan["errors"] if f"{e.get('selector')}|{e['text']}" not in job.skipped]
        if not errors:
            return
        progressed = False
        for problem in errors:
            progressed = await _resolve(job, lob, problem) or progressed
            if job.memo.pop("rowsChanged", False):
                break  # the other errors' row indices are stale now: rescan
        await _settle(job.browser, job.tab, 10)
        if not progressed:
            return


async def _goto(job: Job, lob: str, route: str) -> None:
    """Advance the way the associates do — the go-to button labelled with the next
    step (it saves the current one), else its step header, else the route URL."""
    b, tab = job.browser, job.tab
    label = dict(STEPS[lob])[route]
    scan = await b.evaluate(tab, JS_SCAN)
    button = next((x for x in scan["buttons"] if x["id"].startswith("go-to-") and _norm(x["text"]).endswith(_norm(label))), None)
    header = next((h for h in scan["headers"] if _norm(label) in _norm(h["text"])), None)
    pattern = rf"/rating/{lob}/\d+/{route}$"
    for attempt in range(3):
        if attempt == 0 and button:
            await b.click(tab, _id_sel(button["id"]))
        elif attempt <= 1 and header:
            await b.click(tab, _id_sel(header["id"]))
        else:
            await b.navigate(tab, f"{EZLYNX_BASE_URL}/web/account/{job.account_id}/rating/{lob}/{job.app_ids[lob]}/{route}")
        if await _wait_path(b, tab, pattern, 30):
            await _settle(b, tab)
            await _guard(b, tab)
            return
    here = await b.evaluate(tab, "location.pathname")
    answer = await job.ask("stuck", f"Expected the {lob} {label} screen; EZLynx is on {here}.")
    if _norm(answer) == "retry":
        await _goto(job, lob, route)
    else:
        raise JobError(f"Stopped: could not reach {lob} {label}.")


async def _step_rating(job: Job, lob: str) -> None:
    b, tab = job.browser, job.tab
    template = _get(job.facts, f"quoteTemplates.{lob}") or job.facts.get("quoteTemplate")
    if template:  # recs 2 and 6: the associate's template sets carriers and defaults
        await _apply(job, f"#quote-template-selection-{lob}", template)
        await b.click(tab, f"#apply-quote-template-btn-{lob}")
        await _settle(b, tab)
    choice, source = _get(job.facts, f"carriers.{lob}"), "fact"
    if choice is None and job.kind == "quote" and not template:
        # A requote's brief already offered the agency's carriers; a new quote takes them as they are.
        choice, source = _get(_agency(), f"carriers.{lob}") or {}, "agency default"
    choice = choice or {}
    toggles = await b.evaluate(tab, JS_CARRIERS)
    if choice.get("mode") in ("all", "all-preferred"):
        await _apply(job, "#all-preferred-button", True, source)
    if choice.get("mode") in ("all", "all-non-preferred"):
        await _apply(job, "#all-non-preferred-button", True, source)
        toggles = await b.evaluate(tab, JS_CARRIERS)
    for names, on in ((choice.get("include") or [], True), (choice.get("exclude") or [], False)):
        for name in names:
            index = match_option(name, [t["name"] for t in toggles])
            if index is None:
                (job.problems.append if source == "fact" else job.note)(f"{lob} carrier {name!r} is not on the rating screen")
            else:
                await _apply(job, toggles[index]["selector"], on, source)
    for dropped in [d for d in job.dropped if d["lob"] == lob]:  # a rewalk must not switch them back on
        target = next((t for t in await b.evaluate(tab, JS_CARRIERS) if t["name"] == dropped["carrier"] and t["on"]), None)
        if target:
            await _apply(job, target["selector"], False, "dropped earlier in this run")
    toggles = await b.evaluate(tab, JS_CARRIERS)
    if toggles and not any(t["on"] for t in toggles):
        answer = await job.ask("carriers", f"No {lob} carriers are selected. Which should be quoted?",
                               options=["all"] + [t["name"] for t in toggles])
        if _norm(answer) == "all":
            await _apply(job, "#all-preferred-button", True)
            await _apply(job, "#all-non-preferred-button", True)
        elif _norm(answer).startswith("template:"):
            await _apply(job, f"#quote-template-selection-{lob}", answer.split(":", 1)[1].strip())
            await b.click(tab, f"#apply-quote-template-btn-{lob}")
            await _settle(b, tab)
        else:
            for name in answer.split(","):
                index = match_option(name, [t["name"] for t in toggles])
                if index is not None:
                    await _apply(job, toggles[index]["selector"], True, "human")
    job.memo[f"{lob}:carriers"] = [t["name"] for t in await b.evaluate(tab, JS_CARRIERS) if t["on"]]


async def _credit_authorization(job: Job) -> None:
    """EZLynx records the consent itself (Credit Check and Other Underwriting
    Reports, on policy-info). Already Yes there: that is the record. Unset, with
    nothing in the facts: ask once — it is the associate's attestation, not ours."""
    if _get(job.facts, "creditAuthorization.authorized") is True or job.memo.get("creditFrom"):
        return  # plan_fields sets the EZLynx field to Yes, or the associate already answered
    field_state = await job.browser.evaluate(job.tab, js_describe("#creditCheckAuthorized"))
    if not field_state.get("found"):
        return
    if _norm(field_state.get("value")) == "yes":
        job.memo["creditFrom"] = "already authorized on the EZLynx application"
        return
    who = job.memo.get("applicant") or _get(job.facts, "applicant.firstName") or "the applicant"
    answer = await job.ask(
        "credit",
        f"EZLynx does not show a credit / underwriting-report authorization for {who}, and submitting can pull "
        "credit. Who authorized it, and how? (e.g. 'Patrick Cain by phone') — or 'no' to leave it unset.")
    if _norm(answer) in ("no", "n", "none", "skip"):
        job.memo["creditFrom"] = "NOT authorized — left unset in EZLynx"
        return
    job.facts["creditAuthorization"] = {"authorized": True, "obtainedFrom": answer,
                                        "obtainedOn": date.today().strftime(DATE_FORMAT)}


async def _step_policy_info(job: Job, lob: str) -> None:
    b, tab = job.browser, job.tab
    await _credit_authorization(job)
    current = await b.evaluate(tab, js_describe("#effectiveDateNewPolicy"))
    prior = await b.evaluate(tab, js_describe("#priorPolicyExpirationDate"))
    today = date.today()
    # A stored date from an earlier run (the first server kept one) is stale by now; ask instead.
    fact_effective = _date(job.facts.get("effectiveDate"))
    # One date for the whole bundle (Salwa): a requote's brief settles it for every
    # line; otherwise the first line's date carries to the next.
    effective = job.effective.get(lob) or job.requested_effective or (
        fact_effective if fact_effective and fact_effective > today else None) or next(iter(job.effective.values()), None)
    if effective is None and job.kind == "requote":
        suggestion = _suggest_effective(current.get("value"), prior.get("value"), today)
        suggestion = min(suggestion, today + timedelta(days=int(_agency().get("maxDaysAhead") or 60)))
        answer = await job.ask(
            "effective_date",
            f"New {lob} effective date? EZLynx has effective {current.get('value') or '(blank)'} and prior "
            f"expiration {prior.get('value') or '(blank)'}; the renewal looks like {suggestion.strftime(DATE_FORMAT)}.",
            suggestion=suggestion.strftime(DATE_FORMAT),
        )
        effective = suggestion if _norm(answer) in ("ok", "yes", "y") else _date(answer)
        while effective is None or effective <= today:
            answer = await job.ask("effective_date", "That is not a future date like 11/14/2026. New effective date?",
                                   suggestion=suggestion.strftime(DATE_FORMAT))
            effective = suggestion if _norm(answer) in ("ok", "yes", "y") else _date(answer)
    if effective is not None:
        job.effective[lob] = effective
        await _apply(job, "#effectiveDateNewPolicy", effective.strftime(DATE_FORMAT), "requote date" if job.kind == "requote" else "fact")
    prior_fact = _get(job.facts, f"{'priorAuto' if lob == 'auto' else 'priorHome'}.expirationDate")
    fact_day = _date(prior_fact) or today
    # A requote only trusts a stated expiration still ahead; a past one is last term's.
    if prior_fact and (fact_day > today if job.kind == "requote" else fact_day >= today - timedelta(days=330)):
        await _apply(job, "#priorPolicyExpirationDate", prior_fact)
    elif effective is not None and job.kind == "requote":
        page_day = _date(prior.get("value"))
        ours = job.memo.setdefault("priorExpSet", {}).get(lob)
        if page_day is None or page_day < today or (ours and page_day == ours):
            # recs 3, 4, 5: the current policy expires the day the new one starts. A
            # policy still running is left alone — its date is a real gap or overlap —
            # unless this run put it there for an effective date since changed.
            await _apply(job, "#priorPolicyExpirationDate", effective.strftime(DATE_FORMAT), "requote date")
            job.memo["priorExpSet"][lob] = effective


def _has_identity(row: dict[str, Any]) -> bool:
    return any(_norm(row.get(k)) for k in ("first", "last", "dob", "vin", "firstName", "lastName", "dateOfBirth", "year", "make", "model"))


def _match_rows(facts_rows: list[dict[str, Any]], page_rows: list[dict[str, Any]], same) -> dict[int, int]:
    """Fact index -> page index. Identity first (name/DOB, VIN, `replaces`); then
    position, but only onto a blank row or for a fact that names nobody — never a
    new driver typed over a different person the page already shows."""
    slots: dict[int, int] = {}
    free = [row["i"] for row in page_rows]
    for f, fact in enumerate(facts_rows):
        hits = [row["i"] for row in page_rows if row["i"] in free and same(fact, row)]
        if len(hits) == 1:  # two rows fitting (twins, a Sr and Jr, two Hondas) is a question, not a pick
            slots[f] = hits[0]
            free.remove(hits[0])
    rows = {row["i"]: row for row in page_rows}
    for f, fact in enumerate(facts_rows):
        if f in slots or fact.get("remove"):
            continue
        hit = next((i for i in free if not _has_identity(rows[i]) or not _has_identity(fact)), None)
        if hit is not None:
            slots[f] = hit
            free.remove(hit)
    return slots


def _same_driver(fact: dict[str, Any], row: dict[str, Any]) -> bool:
    """Name, and the birth date too whenever both sides have one — twins share a
    birth date, a Sr and a Jr share a name."""
    names = bool(_norm(fact.get("lastName"))) and _norm(fact.get("firstName")) == _norm(row["first"]) \
        and _norm(fact.get("lastName")) == _norm(row["last"])
    if fact.get("dateOfBirth") and row.get("dob"):
        return _same(fact["dateOfBirth"], row["dob"]) and (names or not (fact.get("firstName") or fact.get("lastName")))
    return names


MAKE_ALIASES = {"vw": "volkswagen", "chevy": "chevrolet", "benz": "mercedes-benz", "mercedes": "mercedes-benz", "caddy": "cadillac"}


def _same_vehicle(fact: dict[str, Any], row: dict[str, Any]) -> bool:
    if fact.get("vin") and _norm(fact["vin"]) == _norm(row.get("vin")):
        return True  # also after a 'replaces' fact already typed its VIN over the old car
    if fact.get("replaces"):
        return _norm(fact["replaces"]) in (_norm(row["vin"]), str(row["i"]))
    if fact.get("vin"):
        return False
    # No VIN: year/make/model as far as given ("the Golf", "the 2019 Accord") — never just "the first row".
    make = _norm(fact.get("make"))
    make = MAKE_ALIASES.get(make, make)
    model = _norm(fact.get("model")).split(" ")[0] if fact.get("model") else ""
    year = _norm(fact.get("year"))
    if not (model or (year and make)):
        return False
    return (not year or year == _norm(row.get("year"))) and (not make or _norm(row.get("make")).startswith(make[:4])) \
        and (not model or model in _norm(row.get("model")))


def _addable(kind: str, fact: dict[str, Any]) -> bool:
    """Enough to be a new row, not a correction to one that could not be found."""
    if fact.get("remove") or fact.get("replaces"):
        return False
    if kind == "driver":
        return bool(fact.get("firstName") and fact.get("lastName"))
    return bool(fact.get("vin") or (fact.get("year") and fact.get("make") and fact.get("model")))


def _row_key(kind: str, row: dict[str, Any]) -> str:
    """A page row's identity; its index shifts as rows are removed."""
    return f"{kind}:" + "|".join(_norm(row.get(k)) for k in ("first", "last", "dob", "vin", "year", "make", "model"))


def _row_label(row: dict[str, Any]) -> str:
    """How a page row is named to people and in logs — never its birth date."""
    return " ".join(str(row[k]) for k in ("first", "last", "year", "make", "model", "vin") if row.get(k)) or "(blank)"


def _fact_label(fact: dict[str, Any]) -> str:
    return " ".join(str(fact[k]) for k in ("firstName", "lastName", "year", "make", "model", "vin") if fact.get(k)) or "(unnamed)"


async def _remove_row(job: Job, kind: str, index: int, what: str, reason: str) -> None:
    b, tab = job.browser, job.tab
    if not (await b.evaluate(tab, js_describe(f"#remove-{kind}-btn-{index}"))).get("found"):
        answer = await job.ask("stuck", f"EZLynx shows no remove button for {kind} '{what}'. Remove it in EZLynx yourself "
                                        "and answer 'retry', or 'skip' to keep it.")
        if _norm(answer) != "retry":
            job.problems.append(f"{kind} '{what}' was to be removed ({reason}) but was kept")
            job.skipped.add(f"remove:{kind}:{what}")
        return
    await b.click(tab, f"#remove-{kind}-btn-{index}")  # recs 2 and 6
    await asyncio.sleep(0.5)
    await b.click(tab, "#dialog-confirm")
    await _settle(b, tab)
    job.changes.append({"step": job.step, "selector": f"#remove-{kind}-btn-{index}", "from": what, "to": None, "source": reason})
    job.note(f"removed {kind} {what}")


async def _reconcile(job: Job, kind: str) -> None:
    """Bring the page's drivers/vehicles in line with the facts. A row the facts do
    not account for is the associate's call: keep it, remove it (recs 2 and 6), or
    put a fact in its place (rec 5 typed a new VIN over the old car)."""
    b, tab = job.browser, job.tab
    key, same = ("drivers", _same_driver) if kind == "driver" else ("vehicles", _same_vehicle)
    facts_rows = job.facts.get(key) or []
    chosen: dict[int, str] = {}  # fact index -> _row_key of the row the associate gave it

    async def read() -> tuple[list[dict[str, Any]], dict[int, int]]:
        roster = (await b.evaluate(tab, JS_ROSTER))[key]
        at = {_row_key(kind, r): r["i"] for r in roster}
        slots = _match_rows(facts_rows, roster, same)
        taken = set(slots.values())
        for f, row_key in chosen.items():
            if row_key in at and at[row_key] not in taken:
                slots[f] = at[row_key]
                taken.add(at[row_key])
        # A correction to a car or person another fact already placed ("collision off the
        # Accord" after the Accord's commute change) shares that row; it never needs its own.
        for f, fact in enumerate(facts_rows):
            if f not in slots and not fact.get("remove") and not _addable(kind, fact):
                hits = [r["i"] for r in roster if same(fact, r)]
                if len(hits) == 1:
                    slots[f] = hits[0]
        return roster, slots

    ignored: set[int] = set()
    roster, slots = await read()
    for f, fact in enumerate(facts_rows):
        if f in slots or _addable(kind, fact):
            continue
        if fact.get("remove") and (fact.get("vin") if kind == "vehicle" else fact.get("firstName") and fact.get("lastName")):
            ignored.add(f)  # named for certain and no longer there: already removed (this run, or by hand)
            continue
        # "The Golf is gone", "comp and collision off the Accord": a correction that
        # names no row for certain. Ask which — never ignore it, never add a blank row.
        free_rows = [r for r in roster if r["i"] not in set(slots.values())]
        labels = [_row_label(r) for r in free_rows]
        if not labels:
            ignored.add(f)
            job.problems.append(f"{kind} '{_fact_label(fact)}' matched no row on EZLynx and was left alone")
            continue
        verb = "remove" if fact.get("remove") else "change"
        answer = await job.ask("roster", f"Which {kind} on EZLynx is '{_fact_label(fact)}' (to {verb})?",
                               options=labels + ["none of these"], context={"step": job.step})
        pick = match_option(answer, labels)
        if pick is None:
            ignored.add(f)
            job.problems.append(f"{kind} '{_fact_label(fact)}' ({verb}) was left alone: no row picked")
        else:
            chosen[f] = _row_key(kind, free_rows[pick])
            roster, slots = await read()

    for _ in range(15):  # removals shift indices, so re-read after each change
        roster, slots = await read()
        labels = {r["i"]: _row_label(r) for r in roster}
        doomed = next((p for f, p in slots.items() if facts_rows[f].get("remove")
                       and f"remove:{kind}:{labels.get(p)}" not in job.skipped), None)
        if doomed is not None:
            row = next(r for r in roster if r["i"] == doomed)
            await _remove_row(job, kind, doomed, _row_label(row), "fact: remove")
            continue
        unmatched = [f for f, fact in enumerate(facts_rows) if not fact.get("remove") and f not in slots]
        free = [r for r in roster if r["i"] not in set(slots.values()) and _row_key(kind, r) not in job.skipped]
        # A requote's facts are corrections, not the whole household: rows they do
        # not mention stay (the brief already put the policy's roster to the
        # associate), and a fact with no row gets a new one below.
        if not free or not facts_rows or job.kind == "requote":
            break
        row = free[0]
        uses = [f"use for {_fact_label(facts_rows[f])}" for f in unmatched]
        answer = await job.ask(
            "roster",
            f"EZLynx has {kind} {row['i'] + 1} '{_row_label(row)}', which the facts do not list. "
            + ("Keep it, remove it, or use it for one of the facts?" if uses else "Keep it or remove it?"),
            options=["keep", "remove"] + uses, context={"step": job.step})
        lowered = _norm(answer)
        if lowered == "remove":
            await _remove_row(job, kind, row["i"], _row_label(row), "human")
        elif lowered.startswith("use for") and unmatched:
            pick = match_option(answer.strip()[7:].strip(), [_fact_label(facts_rows[f]) for f in unmatched])
            if pick is not None:
                chosen[unmatched[pick]] = _row_key(kind, row)
        else:
            job.skipped.add(_row_key(kind, row))
    roster, slots = await read()
    missing = [f for f, fact in enumerate(facts_rows) if not fact.get("remove") and f not in slots and f not in ignored]
    button = "#add-driver-btn" if kind == "driver" else "#addVehicleButton"  # recs 1 and 0
    for f in missing:
        if not (await b.evaluate(tab, js_describe(button))).get("visible"):
            break  # a native click on a missing button can take the whole browser session down
        try:
            await b.click(tab, button)
        except CamofoxError:
            break
        await _settle(b, tab, 10)
        job.note(f"added a {kind} row for {_fact_label(facts_rows[f])}")
        job.changes.append({"step": job.step, "selector": button, "from": None, "to": _fact_label(facts_rows[f]), "source": "fact: add"})
    roster, slots = await read()  # a new row is blank, so the fact takes it by position
    missing = [f for f, fact in enumerate(facts_rows) if not fact.get("remove") and f not in slots and f not in ignored]
    if missing:
        names = ", ".join(_fact_label(facts_rows[f]) for f in missing)
        answer = await job.ask("stuck", f"Could not add a {kind} row for: {names}. Add it in EZLynx's {kind}s screen yourself, "
                                        "then answer 'retry' — or 'stop'.")
        if _norm(answer) == "retry":
            await _open(b, tab, await b.evaluate(tab, "location.href"))  # a row added elsewhere shows only after a reload
            return await _reconcile(job, kind)
        raise JobError(f"Stopped: EZLynx does not show all the {key} the facts list.")
    job.slots[key] = {f: p for f, p in slots.items() if not facts_rows[f].get("remove")}
    if kind == "vehicle":
        job.vehicle_count = len(roster)


async def _vin_lookups(job: Job) -> None:
    b, tab = job.browser, job.tab
    for fact_index, page_index in job.slots.get("vehicles", {}).items():
        vin = (job.facts["vehicles"][fact_index] or {}).get("vin")
        if not vin:
            continue
        current = await b.evaluate(tab, js_describe(f"#VIN-{page_index}"))
        year = await b.evaluate(tab, js_describe(f"#selected-year-{page_index}"))
        if _same(current.get("value"), vin) and year.get("value"):
            continue
        await _apply(job, f"#VIN-{page_index}", vin)
        await b.click(tab, f"#vin-lookup-btn-{page_index}")  # rec 5: new VIN, lookup refills Y/M/M
        if not await b.evaluate(tab, js_wait_value(f"#selected-year-{page_index}", 15_000)):
            job.problems.append(f"VIN lookup for {vin} did not fill the year")
        await _settle(b, tab, 10)


async def _step(job: Job, lob: str, route: str) -> None:
    b, tab = job.browser, job.tab
    job.step = f"{lob}/{route}"
    job.note(f"{lob}: {dict(STEPS[lob])[route]}")
    job.memo.setdefault("walked", set()).add(lob)
    if route == "rating":
        await _step_rating(job, lob)
    elif route == "policy-info":
        await _step_policy_info(job, lob)
    elif route == "drivers-compact":
        await _driver_sync(job)
        await _reconcile(job, "driver")
    elif route == "vehicles-compact":
        await _reconcile(job, "vehicle")
        await _vin_lookups(job)
    for selector, value in plan_fields(job.facts, lob, route, job.slots):
        await _apply(job, selector, value)
    if job.kind == "quote":  # a requote's brief offered these; a new quote takes them, shown at the gate as agency defaults
        given = ((job.facts.get("fields") or {}).get(f"{lob}/{route}") or {})
        for selector, value in ((_agency().get("fields") or {}).get(f"{lob}/{route}") or {}).items():
            if selector not in given:
                await _apply(job, selector, value, "agency default")
    if route in ("vehicles-compact", "coverage", "carrier-questions"):
        await _apply_known_answers(job, lob)
    if route == "coverage" and lob == "home" and not _rce(job.facts):
        dwelling = await b.evaluate(tab, js_describe("#dwelling"))
        if dwelling.get("value"):
            job.memo["rce"] = re.sub(r"[^\d]", "", dwelling["value"])
    if route != "finish":
        await _resolve_screen(job, lob)
    current = job.memo.setdefault("current", {})
    with suppress(CamofoxError, httpx.HTTPError, KeyError):
        for label, selector in SNAPSHOT.get((lob, route), ()):
            state = await b.evaluate(tab, js_describe(selector))
            if state.get("found"):
                current[f"{lob} {label}"] = _mask(selector, state.get("value"))
        if route in ("drivers-compact", "vehicles-compact"):
            key = "drivers" if route == "drivers-compact" else "vehicles"
            current[f"auto {key}"] = [_row_label(r) for r in (await b.evaluate(tab, JS_ROSTER))[key]]


# What the gate shows as "about to be submitted", changed or not — so a stale
# value the run never touched is still in front of the approver.
SNAPSHOT = {
    ("auto", "policy-info"): (("effective date", "#effectiveDateNewPolicy"), ("prior carrier", "#priorCarrier"),
                              ("prior liability limits", "#priorLiabilityLimits")),
    ("auto", "coverage"): (("bodily injury", "#bodily-injury"), ("property damage", "#property-damage")),
    ("home", "policy-info"): (("effective date", "#effectiveDateNewPolicy"), ("prior carrier", "#priorCarrier")),
    ("home", "dwelling-info"): (("roof updated", "#yearUpdatedRoofing"),),
    ("home", "coverage"): (("dwelling (Coverage A)", "#dwelling"), ("all perils deductible", "#allPerilsDeductible")),
}


async def _driver_sync(job: Job) -> None:
    """EZLynx's 'Review and update' prompt when the applicant's details changed
    under a driver — rec 5 took it: Review and update, then Update."""
    b, tab = job.browser, job.tab
    for _ in range(4):
        ids = await b.evaluate(tab, _js("return qa('[id^=\"review-update-\"]').filter(vis).map((e) => e.id);")) or []
        if not ids:
            return
        await b.click(tab, _id_sel(ids[0]))
        if not await _wait_path(b, tab, r"/drivers-sync/", 20):
            return
        await _settle(b, tab)
        if not (await b.evaluate(tab, js_describe("#sync-update"))).get("visible"):
            job.problems.append("EZLynx's driver 'Review and update' page had no Update button; left as it was")
            await _open(b, tab, (await b.evaluate(tab, "location.href")).replace("drivers-sync/primary", "drivers-compact"))
            return
        await b.click(tab, "#sync-update")
        await _wait_path(b, tab, r"/drivers-compact$", 30)
        await _settle(b, tab)
        job.note("accepted EZLynx's driver sync (Review and update → Update)")


async def _apply_known_answers(job: Job, lob: str) -> None:
    """Answers the run already knows — derived ones (multi-car with 3 vehicles is
    Yes) and remembered ones — typed whether or not EZLynx flags the field: a
    valid-but-wrong 'No' never raises a message (recs 6, 7)."""
    b, tab = job.browser, job.tab
    controls = (await b.evaluate(tab, JS_SCAN_FULL)).get("controls") or []
    given = {_answer_key(k) for k in (job.facts.get("carrierAnswers") or {})}
    learned = job.memo.setdefault("learned", _learned(job.user))
    for control in controls:
        selector = control["selector"]
        if control.get("disabled") or not _rememberable(selector) or _answer_key(selector) in given:
            continue
        value, why = _derived_answer(selector, job, lob), "rule"
        remembered = learned.get(_answer_key(selector)) or {}
        if value is None and not control.get("value") and remembered.get("auto") \
                and _answer_key(selector) not in job.memo.get("declinedAnswers", set()):
            value, why = remembered.get("value"), "remembered"
        if value is not None and not _same(value, control.get("value")):
            await _apply(job, selector, value, why)


def _finish_valid(scan: dict[str, Any]) -> bool | None:
    header = next((h for h in scan["headers"] if h["id"] == "step-header-finish"), None)
    if header is None:
        return None
    return bool(re.search(r"\bValid\b", header["text"])) and "Invalid" not in header["text"]


async def _finish(job: Job, lob: str) -> None:
    """Visit every step whose header shows a warning until finish reads Valid —
    rec 3's bounce between finish and rating, done deliberately."""
    b, tab = job.browser, job.tab
    for _ in range(3):
        scan = await b.evaluate(tab, JS_SCAN)
        if _finish_valid(scan) is not False:
            return
        bad = [h for h in scan["headers"] if "warning" in h["text"].lower() and h["id"] != "step-header-finish"]
        for header in bad:
            route = next((r for r, label in STEPS[lob] if _norm(label) in _norm(header["text"])), None)
            if route:
                await _goto(job, lob, route)
                job.step = f"{lob}/{route}"
                await _resolve_screen(job, lob)
        await _goto(job, lob, "finish")
        job.step = f"{lob}/finish"
    scan = await b.evaluate(tab, JS_SCAN)
    if _finish_valid(scan) is False:
        carriers = job.memo.get(f"{lob}:carriers") or []
        answer = await job.ask(
            "finish_invalid",
            f"The {lob} finish step is still Invalid. Steps with warnings: "
            f"{[h['text'] for h in scan['headers'] if 'warning' in h['text'].lower()]}. "
            "Fix with read_screen/set_fields and 'retry', 'drop <carrier>', or 'stop'.",
            options=["retry", "stop"] + [f"drop {c}" for c in carriers],
        )
        lowered = _norm(answer)
        if lowered.startswith("drop "):
            await _drop_carrier(job, lob, answer[5:].strip(), "finish step Invalid")
            return await _finish(job, lob)
        if lowered == "retry":
            return await _finish(job, lob)
        raise JobError(f"Stopped at the {lob} finish step (Invalid).")


async def _enter(job: Job) -> None:
    """Create the applicant, or open the account — then into the first LOB."""
    b, tab, first = job.browser, job.tab, job.lobs[0]
    if job.account_id is None and job.memo.get("applicantSaveClicked"):
        raise JobError("EZLynx may already have saved this applicant before the browser dropped. Find the new "
                       "account in EZLynx and continue with start_quote(account_id=...), so it is not created twice.")
    if job.account_id is None:
        job.step = "applicant/create"
        job.note("creating the applicant")
        await b.navigate(tab, f"{EZLYNX_BASE_URL}/web/account/create/personal")
    else:
        job.step = "applicant/details"
        job.note(f"opening account {job.account_id}")
        await b.navigate(tab, f"{EZLYNX_BASE_URL}/web/account/{job.account_id}/details")
    await _settle(b, tab)
    await _guard(b, tab)
    if job.account_id is not None:
        here = await b.evaluate(tab, "location.pathname")
        if f"/account/{job.account_id}" not in here:
            raise JobError(f"EZLynx did not open account {job.account_id} (landed on {here}).")
        applicant = await _read_applicant(b, tab, job.account_id)
        if applicant:
            job.memo["applicant"] = f"{applicant.get('firstName') or ''} {applicant.get('lastName') or ''}".strip()
    details_facts = job.facts if job.kind == "quote" else {k: v for k, v in job.facts.items() if k != "drivers"}
    for selector, value in plan_fields(details_facts, first, "details"):
        await _apply(job, selector, value)
    for role, trigger in (("producer", "#assigned-producer-personal-applicant"), ("csr", "#csr-personal-applicant")):
        if job.facts.get(role):  # recs 2 and 6: search, pick, Assign
            await b.click(tab, trigger)
            await _apply(job, "#user-search", job.facts[role])
            await b.click(tab, 'button:has-text("Assign")')
            await _settle(b, tab, 10)
    await _resolve_screen(job, first)
    for _ in range(3):
        job.memo["applicantSaveClicked"] = True
        await b.click(tab, f"#save-and-go-to-{first}-btn")
        path = await _wait_path(b, tab, rf"/web/account/\d+/rating/{first}/\d+/", 45)
        if path:
            break
        await _resolve_screen(job, first)
    else:
        raise JobError("EZLynx did not save the applicant — the problems list says why.")
    match = re.search(rf"/web/account/(\d+)/rating/{first}/(\d+)/", path)
    if job.account_id is None:
        job.note(f"created applicant — account {match.group(1)}")
    job.account_id, job.app_ids[first] = match.group(1), match.group(2)
    await _settle(b, tab)


async def _submit_gate(job: Job) -> bool | str:
    """Park on submit-details with exactly what would be sent. Only a person
    releases it: approve_submit with their name, or their elicitation reply."""
    b, tab = job.browser, job.tab
    job.step = "submit"
    await b.click(tab, "#submit-to-carriers-btn")
    if not await _wait_path(b, tab, r"/rating/submit-details/\d+", 30):
        raise JobError("Submit to carriers did not open the submit screen.")
    await _settle(b, tab)
    grid = await b.evaluate(tab, JS_SUBMIT_GRID)
    applicant = _get(job.facts, "applicant.firstName"), _get(job.facts, "applicant.lastName")
    # Order matters: what the approver must see comes first, the long lists last.
    job.submit_summary = {
        "warning": "Submitting can trigger credit and underwriting reports on the applicant.",
        "accountId": job.account_id,
        "applicant": " ".join(p for p in applicant if p) or job.memo.get("applicant"),
        "lines": job.lobs,
        "effectiveDates": {lob: d.strftime(DATE_FORMAT) for lob, d in job.effective.items()},
        "effectiveDatesFrom": job.memo.get("effectiveFrom") or "given, or confirmed by the associate",
        "creditAuthorization": _redact(job.facts.get("creditAuthorization")) or job.memo.get("creditFrom") or "not recorded",
        "task": (job.memo.get("task") or {}).get("title"),
        "brief": job.memo.get("brief"),
        # Changed or not, what goes out — so a stale value is in front of the approver too.
        "aboutToSubmit": job.memo.get("current"),
        "problems": job.problems[-10:],
        "droppedCarriers": job.dropped,
        "carriers": grid.get("rows") if grid.get("found") else grid.get("text"),
        "answeredQuestions": [{**a, "prompt": a["prompt"][:200]} for a in job.answers if a["kind"] not in ("submit_approval", "brief")],
        "changes": [c for c in job.changes if c.get("source") != "fact" or job.kind == "requote"][-40:],
    }
    answer = await job.ask("submit_approval", f"Ready to submit account {job.account_id} ({', '.join(job.lobs)}) "
                                              "to the carriers listed in submitSummary.")
    if answer == "rewalk":  # amend_job at the gate: correct first, then a fresh gate with a fresh summary
        job.submit_summary = None
        return "rewalk"
    if _norm(answer) != "approve":
        job.note("submission declined — everything stays saved in EZLynx, unsubmitted")
        return False
    job.state = "submitting"
    job.note(f"submitting — approved by {job.approved_by} via {job.approved_via}")
    job.memo["submittedAt"] = _now()  # from here on, never walk again: that could submit twice
    await b.click(tab, "#submit-carriers-btn")
    path = await _wait_path(b, tab, r"/rating/quote-results/\d+/\d+", 60)
    if not path:
        raise JobError("Submit was clicked but the results page never opened. Check the account's quotes in EZLynx before submitting again.")
    # A stub, so refresh_results can find the page even if collecting breaks.
    store.save_quote(job.user, _report_key(job.account_id),
                     build_report(job.account_id, f"{EZLYNX_BASE_URL}{path}", [], [], job.dropped, job.lobs))
    return True


async def _collect(job: Job) -> dict[str, Any]:
    """Watch the results page fill in, clearing post-submit carrier questions:
    open, and submit when nothing is left blank (recs 3 and 4); otherwise ask."""
    b, tab = job.browser, job.tab
    job.state, job.step = "collecting", "results"
    started, rounds, handled = time.monotonic(), 0, set()
    data: dict[str, Any] = {"cards": []}
    while time.monotonic() - started < RESULTS_WAIT_S:
        data = await b.evaluate(tab, JS_RESULTS)
        for card in data["cards"]:
            if not card.get("answerId") or card["answerId"] in handled or rounds >= 12:
                continue
            handled.add(card["answerId"])
            rounds += 1
            await b.click(tab, _id_sel(card["answerId"]))
            await _settle(b, tab, 10)
            form = await b.evaluate(tab, js_card_questions(card["index"])) or {}
            leave = False
            for control in form.get("controls", []):
                if control.get("value") or control.get("disabled") or not (control.get("required") or control.get("error")):
                    continue
                answer = await job.ask("field", f"{card.get('carrier') or 'A carrier'} needs more information: "
                                                f"{control.get('label') or control['selector']}",
                                       options=await options_for(b, tab, control["selector"]) if control["kind"] == "mat-select" else None,
                                       context={"selector": control["selector"], "carrier": card.get("carrier")})
                if _norm(answer).startswith("drop"):  # already submitted: leave this carrier's questions unanswered
                    job.note(f"left {card.get('carrier') or 'a carrier'}'s follow-up unanswered, as asked")
                    leave = True
                    break
                if _norm(answer) not in ("skip", "done"):
                    await _apply(job, control["selector"], answer, "human")
            form = await b.evaluate(tab, js_card_questions(card["index"])) or {}
            if form.get("submitId") and not leave:
                await b.click(tab, _id_sel(form["submitId"]))
                job.note(f"answered {card.get('carrier') or 'carrier'} follow-up questions")
                await _settle(b, tab, 10)
        parsed = [parse_card(c) for c in data["cards"]]
        waiting = any(p.get("pending") or (p.get("needsAnswers") and rounds < 12) for p in parsed)
        if parsed and not waiting and not data.get("busy") and time.monotonic() - started > 20:
            break
        job.note(f"results: {sum(1 for p in parsed if p.get('premium'))} quoted, "
                 f"{sum(1 for p in parsed if p.get('pending'))} still rating")
        await asyncio.sleep(6)
    quote_cards, error_cards, path = await _read_results(b, tab)
    return build_report(job.account_id, f"{EZLYNX_BASE_URL}{path}", quote_cards, error_cards, job.dropped, job.lobs)


# ---------------------------------------------------------------- evidence
# What Salwa reads before touching the wizard (Teams, 2026-09-24; all 8 sessions):
# the task, the applicant-portal policy summary "as of Today" against the renewal
# term, and the account's Activity notes. None of it raises an EZLynx validation
# error, so a run that only answers the page would submit stale data.

async def _open(b: Browser, tab: str, url: str) -> str:
    await b.navigate(tab, url)
    path = await _settle(b, tab)
    await _guard(b, tab)
    return path


async def _find_task(b: Browser, tab: str, first: str, last: str, today: date, account_id: str) -> dict[str, Any] | None:
    """The applicant's own task in the associate's task list, opened: title,
    checklist, discussion. The list holds every client's tasks, so a task counts
    only when it links to this account, or — with no link — names the applicant
    by first and last name and no other client matches as well."""
    with suppress(CamofoxError, httpx.HTTPError):
        await _page_click(b, tab, "#task-list-header")
        await _settle(b, tab, 8)
    listing = await b.evaluate(tab, JS_TASKS) or {}
    candidates: list[tuple[int, dict[str, Any]]] = []
    seen: set[tuple[str, str]] = set()
    for item in listing.get("items") or []:
        parsed = _parse_task(SSN_VALUE.sub("•••", item["text"]), today)
        if (parsed["client"], parsed["title"]) in seen:
            continue
        seen.add((parsed["client"], parsed["title"]))
        linked = re.search(r"/account/(\d+)", item.get("link") or "")
        if linked and linked.group(1) != account_id:
            continue  # another client's task, whatever its name
        score = 3 if linked else _name_match(parsed["client"], first, last)
        if score >= 2:
            candidates.append((score, {**parsed, "i": item["i"], "group": item.get("group") or "", "link": item.get("link")}))
    if not candidates:
        return None
    best = max(score for score, _ in candidates)
    picks = [t for score, t in candidates if score == best]
    if best == 2 and len({_norm(t["client"]) for t in picks}) > 1:
        return None  # two different clients by that name and no link to tell them apart
    task = picks[0]  # the list runs overdue, today, upcoming: the first is the most urgent
    if len(picks) > 1:
        task["otherTasks"] = [t["title"] for t in picks[1:]][:5]
    task.update(checklist=[], detail="", opened=False)
    with suppress(CamofoxError, httpx.HTTPError):
        if not await _page_click(b, tab, f'[data-savvy-task="{task["i"]}"]'):
            return task
        await _settle(b, tab, 8)
        await b.evaluate(tab, _js("""const el = qa('button, a').find((e) => /view entire discussion/i.test(txt(e)));
            if (el) el.click(); return !!el;"""))  # recs 0, 2, 5, 7
        await _settle(b, tab, 6)
        detail = await b.evaluate(tab, js_task_detail(task["i"])) or {}
        # Only a detail that is visibly this task's may add to what the title says.
        if detail.get("found") and _norm(task["title"])[:25] in _norm(detail.get("text")):
            task["opened"] = True
            task["checklist"] = [_scrub(c) for c in detail.get("checklist") or []]
            task["assignedTo"] = detail.get("assignedTo")
            task["detail"] = _scrub(detail.get("text") or "")[:2500]
            task["accountLinks"] = detail.get("links") or []
            more = " ".join(task["checklist"]) + " " + task["detail"]
            task["roofYear"] = task["roofYear"] or ((m := ROOF_YEAR.search(more)) and m.group(1))
            task["lines"] = sorted(set(task["lines"]) | {w.lower() for w in LINE_WORD.findall(" ".join(task["checklist"]))})
    return task


async def _read_policies(b: Browser, tab: str, account_id: str) -> list[dict[str, Any]]:
    await _open(b, tab, f"{EZLYNX_BASE_URL}/web/account/{account_id}/overview")
    out = []
    for row in await b.evaluate(tab, JS_POLICIES) or []:
        policy = _parse_policy(row["text"]) or {"status": None, "type": None, "lob": None, "number": None, "carrier": None}
        out.append({**policy, "i": row["i"], "href": row.get("href"), "overviewText": row["text"][:160]})
    return out


def _same_origin(href: str | None) -> str | None:
    if not href:
        return None
    if href.startswith("/"):
        return f"{EZLYNX_BASE_URL}{href}"
    return href if href.startswith(f"{EZLYNX_BASE_URL}/") else None


async def _policy_url(b: Browser, tab: str, account_id: str, policy: dict[str, Any]) -> str | None:
    """Its portal link, or — the overview renders some policies without one —
    where clicking it goes."""
    if url := _same_origin(policy.get("href")):
        return url
    await _open(b, tab, f"{EZLYNX_BASE_URL}/web/account/{account_id}/overview")
    await b.evaluate(tab, JS_POLICIES)  # tag the rows again: the last summary read left this page
    try:
        if not await _page_click(b, tab, f'[data-savvy-policy="{policy["i"]}"]'):
            return None
    except CamofoxError:
        return None
    for _ in range(24):  # the click navigates: poll from outside the page it replaces
        await asyncio.sleep(0.5)
        with suppress(CamofoxError, httpx.HTTPError):
            path = await b.evaluate(tab, "location.pathname")
            if re.search(r"/applicantportal/policy/\d+/", path or "", re.I):
                return f"{EZLYNX_BASE_URL}{path}"
    return None


async def _read_summary(b: Browser, tab: str, url: str, today: date) -> dict[str, Any]:
    """The policy summary as of Today, and as of the term the EZLynx application
    most likely reflects (the last renewal or new-business term already started) —
    Salwa's "checked the current date for changes since the renewal"."""
    await _open(b, tab, url)
    first = await b.evaluate(tab, JS_POLICY_SUMMARY) or {}
    options = first.get("options") or []
    terms = [{**term, "value": o["value"], "text": o["text"], "selected": o["selected"]}
             for o in options if (term := _parse_term(o["text"]))]
    base_url = url.split("?")[0]

    pages: dict[str, dict[str, Any]] = {}

    async def view(option: dict[str, Any]) -> str | None:
        """The page as of one term — only once the page itself says that term is
        selected: a pending policy's plain URL shows the renewal term, not Today."""
        value = str(option.get("value") or "")
        urls = [f"{base_url}?selectedPolicyDetailId={value}"] if value.isdigit() else [base_url, f"{base_url}?selectedPolicyDetailId={value}"]
        for target in urls:
            await _open(b, tab, target)
            page = await b.evaluate(tab, JS_POLICY_SUMMARY) or {}
            shown = next((o for o in page.get("options") or [] if o["selected"]), None)
            if shown and _norm(shown["text"]) == _norm(option["text"]):
                pages[option["text"]] = page
                return page.get("text") or ""
        return None

    views: dict[str, str] = {}
    today_option = next((o for o in options if _norm(o["text"]) == "today"), None)
    selected = next((o for o in options if o["selected"]), None)
    first_key = "Today" if selected is today_option and today_option else (selected or {}).get("text", "shown")
    views[first_key] = first.get("text") or ""
    pages["Today" if first_key == "Today" else first_key] = first
    if today_option and "Today" not in views and (text := await view(today_option)) is not None:
        views["Today"] = text
        pages["Today"] = pages.pop(today_option["text"], pages.get(today_option["text"], {}))
    started = [t for t in terms if t["date"] and t["date"] <= today and t["type"] in ("RWL", "NBS", "REW", "NEW", "REN", "RNW")]
    base = max(started, key=lambda t: t["date"]) if started else None
    if base and base["text"] not in views and (text := await view(base)) is not None:
        views[base["text"]] = text
    title = first.get("title") or ""
    return {
        "url": url, "title": title[:160], "pending": "pending" in title.lower(),
        "terms": [{"date": t["date"].strftime(DATE_FORMAT), "type": t["type"], "premium": t["premium"]} for t in terms],
        "renewal": next(({"date": t["date"], "premium": t["premium"]} for t in sorted(terms, key=lambda t: t["date"])
                         if t["type"] in ("RWL", "REN", "RNW") and t["date"] > today), None),
        "changesAfter": [t["text"] for t in terms if t["type"] == "PCH" and base and t["date"] > base["date"]],
        "baseTerm": base["text"] if base else None,
        "views": {k: SSN_VALUE.sub("•••", v) for k, v in views.items()},
        "todayVins": (pages.get("Today") or {}).get("vins") if "Today" in views else None,
        "todayTruncated": bool((pages.get("Today") or {}).get("truncated")),
    }


def _text_changes(before: str, after: str, limit: int = 10) -> dict[str, list[str]]:
    """Lines that differ between two views of a policy summary."""
    def lines(text: str) -> list[str]:
        out = []
        for raw in (text or "").splitlines():
            line = re.sub(r"\s+", " ", raw).strip()
            if line and len(line) > 3 and not re.search(r"viewing summary|summary as of|policy number", line, re.I):
                out.append(line)
        return out
    a, b = lines(before), lines(after)
    return {"added": [x for x in b if x not in a][:limit], "removed": [x for x in a if x not in b][:limit]}


async def _read_activity(b: Browser, tab: str, account_id: str) -> list[str]:
    await _open(b, tab, f"{EZLYNX_BASE_URL}/web/account/{account_id}/activity")
    return [SSN_VALUE.sub("•••", n) for n in await b.evaluate(tab, JS_ACTIVITY) or []]


async def _read_application(b: Browser, tab: str, account_id: str, lob: str, app: str) -> dict[str, Any]:
    """The saved rating application as it stands — the values the requote would
    submit unless something changes them."""
    base = f"{EZLYNX_BASE_URL}/web/account/{account_id}/rating/{lob}/{app}"
    out: dict[str, Any] = {"appId": app}

    async def value(selector: str) -> str | None:
        """'' for a field that is there but empty, None for one the screen does not have."""
        state = await b.evaluate(tab, js_describe(selector))
        return (state.get("value") or "") if state.get("found") else None

    await _open(b, tab, f"{base}/rating")
    out["carriers"] = [{"name": t["name"], "on": t["on"]} for t in await b.evaluate(tab, JS_CARRIERS) or []]
    await _open(b, tab, f"{base}/policy-info")
    for key, selector in (("priorCarrier", "#priorCarrier"), ("priorLimits", "#priorLiabilityLimits"),
                          ("effective", "#effectiveDateNewPolicy"), ("priorExpiration", "#priorPolicyExpirationDate")):
        out[key] = await value(selector)
    if lob == "auto":
        await _open(b, tab, f"{base}/drivers-compact")
        out["drivers"] = [{k: d.get(k) for k in ("i", "first", "last", "relationship", "rated")} for d in (await b.evaluate(tab, JS_ROSTER))["drivers"]]
        await _open(b, tab, f"{base}/vehicles-compact")
        out["vehicles"] = (await b.evaluate(tab, JS_ROSTER))["vehicles"]
        await _open(b, tab, f"{base}/coverage")
        out["bodilyInjury"] = await value("#bodily-injury")
    else:
        await _open(b, tab, f"{base}/dwelling-info")
        out["roofYear"] = await value("#yearUpdatedRoofing")
        await _open(b, tab, f"{base}/coverage")
        out["dwelling"] = await value("#dwelling")
    return out


async def _gather(b: Browser, tab: str, account_id: str, lobs: list[str], apps: dict[str, list[str]],
                  applicant: dict[str, Any] | None, task: dict[str, Any] | None) -> dict[str, Any]:
    """Everything above for one account. A page that cannot be read is listed in
    `unread`, never fatal: the brief says what it could not check."""
    today = date.today()
    ev: dict[str, Any] = {"applicant": applicant, "task": task, "policies": [], "activity": [], "applications": {}, "unread": []}
    readable = (CamofoxError, httpx.HTTPError, JobError, KeyError, TypeError, ValueError)
    try:
        policies = await _read_policies(b, tab, account_id)
        if not policies:
            ev["unread"].append("account overview: no policies found")
        for policy in policies:
            if not policy.get("lob"):
                if policy.get("status") in ("Active", "Pending"):
                    ev["unread"].append(f"policy '{policy['overviewText'][:60]}': not an auto or homeowners policy I can compare")
                continue
            if policy.get("status") not in ("Active", "Pending"):
                continue
            try:
                url = await _policy_url(b, tab, account_id, policy)
                if url:
                    policy["summary"] = await _read_summary(b, tab, url, today)
                else:
                    ev["unread"].append(f"policy summary {policy.get('number')}: no link to it could be followed")
            except SessionError:
                raise
            except readable as err:
                ev["unread"].append(f"policy summary {policy.get('number')}: {err}")
        ev["policies"] = policies
    except SessionError:
        raise
    except readable as err:
        ev["unread"].append(f"account overview (policies): {err}")
    try:
        ev["activity"] = await _read_activity(b, tab, account_id)
    except SessionError:
        raise
    except readable as err:
        ev["unread"].append(f"activity: {err}")
    for lob in lobs:
        if not apps.get(lob):
            continue
        try:
            ev["applications"][lob] = await _read_application(b, tab, account_id, lob, apps[lob][0])
        except SessionError:
            raise
        except readable as err:
            ev["unread"].append(f"{lob} application: {err}")
    return ev


DOB_NEAR = re.compile(r"(?i)(\b(?:dob|d\.o\.b\.?|birth\s*date|date of birth|born)\b\W{0,3})(\d{1,2}[/-]\d{1,2}[/-])(\d{2,4})")
DL_NEAR = re.compile(r"(?i)(\b(?:dl|d/l|license|licence|lic)\b\s*(?:#|no\.?|number)?\s*:?\s*)([A-Z]?\d[\dA-Z-]{5,16})")
EMAIL = re.compile(r"\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b")
SSN_BARE = re.compile(r"(?i)(\bssn\b\W{0,3})(\d{9})\b")


def _scrub(text: str) -> str:
    """Portal and activity text on its way to the model: the same masking as the
    rest of the server — SSNs gone, birth dates to the year, licence numbers to
    their last 4, email addresses to their first letter."""
    text = SSN_VALUE.sub("•••", text or "")
    text = SSN_BARE.sub(lambda m: m.group(1) + "•••", text)
    text = DOB_NEAR.sub(lambda m: m.group(1) + "xx/xx/" + m.group(3), text)
    text = DL_NEAR.sub(lambda m: m.group(1) + "…" + m.group(2)[-4:], text)
    return EMAIL.sub(lambda m: f"{m.group(1)}…@{m.group(2)}", text)


def _vin_label(text: str, vin: str) -> str:
    for line in (text or "").splitlines():
        if vin in line.upper():
            label = re.sub(r"\bVIN\b\s*:?", "", line.upper().replace(vin, ""))
            label = re.sub(r"\s+", " ", label).strip(" :-|#")
            return f"{label[:50]} VIN …{vin[-6:]}".strip()
    return f"VIN …{vin[-6:]}"


def _mentions(notes: list[str], word: str) -> str | None:
    note = next((n for n in notes if word and re.search(rf"\b{re.escape(word)}\b", n, re.I)), None)
    return f'activity: "{note[:150]}"' if note else None


def _proposals(job: Job, ev: dict[str, Any]) -> list[dict[str, Any]]:
    """What the evidence says should change on the saved applications — each one
    for the associate to accept or decline in the brief."""
    agency, task = _agency(), ev.get("task") or {}
    policies, apps, notes = ev.get("policies") or [], ev.get("applications") or {}, ev.get("activity") or []
    out: list[dict[str, Any]] = []

    def propose(lob: str, what: str, why: str, patch: dict[str, Any]) -> None:
        out.append({"id": f"P{len(out) + 1}", "lob": lob, "what": what, "why": why, "patch": patch})

    for lob in job.lobs:
        app = apps.get(lob) or {}
        mine = [p for p in policies if p.get("lob") == lob]
        current = next((p for p in mine if p.get("status") == "Active" and p.get("carrier")), None) or next(
            (p for p in mine if p.get("status") == "Pending" and p.get("carrier")), None)
        if agency.get("priorCarrierFromCurrentPolicy") and app.get("priorCarrier") is not None:
            want = why = None
            if current:
                want, why = _carrier_short(current["carrier"]), f"{current['status'].lower()} policy {current['number']} is with {current['carrier']}"
            elif task.get("carrier"):
                want, why = task["carrier"], f"the task names {task['carrier']}"
            if want and _carrier_key(want) != _carrier_key(app.get("priorCarrier")):
                propose(lob, f"{lob} prior carrier: {app.get('priorCarrier') or '(blank)'} → {want}", why,
                        {"priorAuto" if lob == "auto" else "priorHome": {"carrier": want}})
        if lob == "auto" and agency.get("priorLimitsFromCoverage") and app.get("priorLimits") is not None:
            limit = _limit_key(app.get("bodilyInjury"))
            if limit and _norm(limit).replace(" ", "") != _norm(app.get("priorLimits")).replace(" ", ""):
                propose(lob, f"auto prior liability limits: {app.get('priorLimits') or '(blank)'} → {limit}",
                        f"the Bodily Injury limit on the application is {app.get('bodilyInjury')}", {"priorAuto": {"liabilityLimits": limit}})
        if lob == "auto" and app:
            live = [p for p in mine if p.get("status") in ("Active", "Pending")]
            readable = [p for p in live if ((p.get("summary") or {}).get("views") or {}).get("Today")]
            if sum(1 for p in live if p.get("status") == "Active") > 1:
                ev.setdefault("unread", []).append(
                    f"{len(live)} auto policies on the account ({', '.join(p['number'] for p in live)}) — "
                    "vehicles and drivers were not compared; check them yourself")
            elif readable:
                policy = next((p for p in readable if p.get("status") == "Active"), readable[0])
                summary = policy["summary"]
                today_text = summary["views"]["Today"]
                where = f"policy {policy['number']} as of today"
                policy_vins = list(dict.fromkeys(summary.get("todayVins") or VIN_TOKEN.findall(today_text.upper())))
                app_vehicles = [v for v in app.get("vehicles") or [] if v.get("vin")]
                app_vins = {v["vin"].strip().upper() for v in app_vehicles}
                for vin in policy_vins:
                    if vin not in app_vins:
                        propose(lob, f"auto: add {_vin_label(today_text, vin)}", f"on {where}, not on the application",
                                {"vehicles": [{"vin": vin}]})
                # Removal on absence only when the page was read whole and the VIN could have been seen at all.
                if policy_vins and not summary.get("todayTruncated"):
                    for v in app_vehicles:
                        vin = v["vin"].strip().upper()
                        if VIN_TOKEN.fullmatch(vin) and vin not in policy_vins:
                            label = _row_label({k: v.get(k) for k in ("year", "make", "model")}) + f" VIN …{vin[-6:]}"
                            why = "; ".join(x for x in (f"not on {where}", _mentions(notes, v.get("model") or "")) if x)
                            propose(lob, f"auto: remove {label}", why, {"vehicles": [{"vin": v["vin"], "remove": True}]})
                section = None if summary.get("todayTruncated") else _drivers_section(today_text)
                drivers = [d for d in app.get("drivers") or [] if d.get("first") and d.get("last") and _norm(d.get("rated")) != "excluded"]
                if section and any(_named_in(d, section) for d in drivers):
                    for d in drivers:
                        if not _named_in(d, section):
                            why = "; ".join(x for x in (f"not in the drivers on {where}", _mentions(notes, d["first"])) if x)
                            propose(lob, f"auto: remove driver {d['first']} {d['last']}", why,
                                    {"drivers": [{"firstName": d["first"], "lastName": d["last"], "remove": True}]})
                commute = agency.get("commuteOneWayMiles")
                for v in app_vehicles:
                    if commute and "work" in _norm(v.get("use")) and _num(v.get("oneWay")) not in (None, float(commute)) \
                            and v["vin"].strip().upper() in (set(policy_vins) or app_vins):
                        label = _row_label({k: v.get(k) for k in ("year", "make", "model")})
                        propose(lob, f"auto: {label} commute {v.get('oneWay')} → {commute} miles one way", "agency default",
                                {"vehicles": [{"vin": v["vin"], "oneWayMiles": commute}]})
        if lob == "home" and app.get("roofYear") is not None and task.get("roofYear") and _norm(task["roofYear"]) != _norm(app["roofYear"]):
            propose(lob, f"home roof updated year: {app.get('roofYear') or '(blank)'} → {task['roofYear']}", "the task",
                    {"dwelling": {"updates": {"roofYear": task["roofYear"]}}})
        choice = _get(agency, f"carriers.{lob}") or {}
        if app and choice and not _get(job.facts, f"carriers.{lob}"):
            names = [c["name"] for c in app.get("carriers") or []]
            on = {c["name"] for c in app.get("carriers") or [] if c["on"]}
            turn_on = [names[i] for n in choice.get("include") or [] if (i := match_option(n, names)) is not None and names[i] not in on]
            turn_off = [names[i] for n in choice.get("exclude") or [] if (i := match_option(n, names)) is not None and names[i] in on]
            parts = ([f"turn on {', '.join(turn_on)}"] if turn_on else []) + ([f"turn off {', '.join(turn_off)}"] if turn_off else [])
            if choice.get("mode") == "all-non-preferred":
                parts.append("select all non-preferred carriers")
            if turn_on or turn_off:
                propose(lob, f"{lob} carriers: {'; '.join(parts)}", "agency default", {"carriers": {lob: choice}})
        for route_key, values in (agency.get("fields") or {}).items():
            if route_key.startswith(f"{lob}/") and app:
                for selector, value in values.items():
                    propose(lob, f"{route_key}: {FIELD_NAMES.get(selector, selector)} → {value} (if the screen has it)", "agency default",
                            {"fields": {route_key: {selector: value}}})
    remembered = {k: v["value"] for k, v in _learned(job.user).items() if v.get("auto")}
    if remembered and job.lobs:
        propose(job.lobs[0], "answer these carrier questions the agency's way wherever they come up: "
                + "; ".join(f"{k.strip('#')} → {v}" for k, v in list(remembered.items())[:8]), "agency remembered answers", {})
        out[-1]["answerKeys"] = sorted(remembered)
    return out


def _drivers_section(text: str) -> str | None:
    """The drivers part of a policy summary: from a Drivers/Operators heading to
    the next heading. None when the page has no such heading — then absence from
    the page proves nothing (a collapsed section, the header's named insured)."""
    lines = (text or "").splitlines()
    start = next((i for i, line in enumerate(lines)
                  if re.match(r"^\s*(drivers?|operators?|driver information|listed drivers|household drivers)\b\s*:?\s*$", line, re.I)), None)
    if start is None:
        return None
    out = []
    for line in lines[start + 1:]:
        if re.match(r"^\s*(vehicles?|coverages?|discounts?|forms|endorsements|premiums?|lienholders?|claims|violations|"
                    r"incidents|documents|billing|payments?|named insured|additional interests?)\b\s*:?\s*$", line, re.I):
            break
        out.append(line)
    return "\n".join(out) or None


def _named_in(driver: dict[str, Any], section: str) -> bool:
    words = set(re.sub(r"[^a-z]+", " ", _norm(section)).split())
    parts = re.sub(r"[^a-z]+", " ", _norm(f"{driver.get('first')} {driver.get('last')}")).split()
    return bool(parts) and all(p in words for p in parts if p not in ("jr", "sr", "ii", "iii", "iv"))


def _effective_candidates(job: Job, ev: dict[str, Any], today: date) -> list[tuple[date, str]]:
    task, found = ev.get("task") or {}, []
    for lob in job.lobs:
        day = (task.get("dates") or {}).get(lob) or (task.get("dates") or {}).get(None)
        if day:
            found.append((day, f"the task \"{task['title'][:90]}\""))
    for policy in ev.get("policies") or []:
        renewal = (policy.get("summary") or {}).get("renewal")
        if policy.get("lob") in job.lobs and renewal:
            found.append((renewal["date"], f"the pending renewal term on policy {policy['number']}"))
    for lob, app in (ev.get("applications") or {}).items():
        day = _date(app.get("priorExpiration"))
        if lob in job.lobs and day and today < day <= today + timedelta(days=366):
            found.append((day, f"the {lob} application's prior-policy expiration"))
    return found


BRIEF_OK = re.compile(r"\b(go ahead|looks good|sounds good|all good|do it|okay|ok|yes|yep|go|proceed|approved?|confirm(ed)?|fine|correct|good)\b", re.I)
BRIEF_NO = r"(?:except|but not|not|no|without|skip|leave out|leave|drop|decline|reject|minus)"
BRIEF_ONLY = r"(?:only|just)"
ID_LIST = r"((?:P?\d+)(?:\s*(?:,|and|&|or|\+)?\s*P?\d+)*)"


def _money(text: str) -> int | None:
    """'$706,900.00' -> 706900, '424k' -> 424000, '1.2m' -> 1200000."""
    m = re.search(r"\$?\s*(\d[\d,]*(?:\.\d+)?)\s*([km])?\b", text or "", re.I)
    if not m:
        return None
    value = float(m.group(1).replace(",", "")) * {"k": 1_000, "m": 1_000_000}.get((m.group(2) or "").lower(), 1)
    return int(round(value))


def _brief_date(raw: str, today: date) -> date | None:
    """11/22/2026, 11-22-26, 11.22.2026, or 11/22 (the next 11/22)."""
    parts = [p for p in re.split(r"[/.\-\s]+", raw.strip()) if p]
    if len(parts) == 2:
        with suppress(ValueError):
            day = date(today.year, int(parts[0]), int(parts[1]))
            return day if day > today else date(today.year + 1, int(parts[0]), int(parts[1]))
        return None
    if len(parts) == 3:
        year = int(parts[2]) if parts[2].isdigit() else 0
        year += 2000 if year < 100 else 0
        with suppress(ValueError):
            return date(year, int(parts[0]), int(parts[1]))
    return None


def _parse_brief(answer: str, ids: list[str], today: date | None = None) -> dict[str, Any]:
    """The associate's reply to the brief. Proposals are declined or singled out
    only with an explicit word ('ok except P2', 'only P1 P3'); anything that
    cannot be read with certainty — a P-id with no such word, an id not in the
    list, a date or amount that does not parse, a leftover instruction — makes
    `ok` False and says why, so nothing is applied on a guess."""
    today = today or date.today()
    text = answer.strip()
    out: dict[str, Any] = {"stop": bool(re.fullmatch(r"\s*(stop|cancel|abort)\b.*", text, re.I)),
                           "reject": set(), "only": None, "problems": []}
    rest = text

    def id_set(raw: str) -> set[str]:
        return {f"P{n}" for n in re.findall(r"\d+", raw)}

    for pattern, key in ((rf"\b{BRIEF_NO}\s+{ID_LIST}", "reject"), (rf"\b{BRIEF_ONLY}\s+{ID_LIST}", "only")):
        for m in re.finditer(pattern, text, re.I):
            found = id_set(m.group(1))
            out[key] = (out[key] or set()) | found
            rest = rest.replace(m.group(0), " ")
    named = out["reject"] | (out["only"] or set())
    if unknown := sorted(i for i in named if i not in ids):
        out["problems"].append(f"there is no {', '.join(unknown)} in this brief")
    if loose := re.findall(r"\bP\d+\b", rest, re.I):
        out["problems"].append(f"say whether {', '.join(sorted(set(x.upper() for x in loose)))} should be left out "
                               "('ok except P2') or be the only ones done ('only P2')")
        rest = re.sub(r"\bP\d+\b", " ", rest, flags=re.I)
    if out["reject"] and out["only"]:
        out["problems"].append("use either 'except' or 'only', not both")
    if m := re.search(r"\beffective(?:\s+date)?(?:\s+(?:is|to|of|on|as))?\s*[:=]?\s*([0-9][0-9/.\-\s]{2,12}[0-9])", rest, re.I):
        day = _brief_date(m.group(1), today)
        out["effectiveText"] = m.group(1).strip()
        if day is None or day <= today:
            out["problems"].append(f"'{m.group(1).strip()}' is not a future date like 11/22/2026")
        else:
            out["effective"] = day
        rest = rest.replace(m.group(0), " ")
    elif re.search(r"\beffective\b", rest, re.I):
        out["problems"].append("I could not read the effective date — write it like 11/22/2026")
        rest = re.sub(r"\beffective\b", " ", rest, flags=re.I)
    if m := re.search(r"\brce\b\s*(?:is|of|to|=|:)?\s*(\$?\s*\d[\d,]*(?:\.\d+)?\s*[km]?)", rest, re.I):
        amount = _money(m.group(1))
        if amount is None or not 50_000 <= amount <= 20_000_000:
            out["problems"].append(f"'{m.group(1).strip()}' does not look like a replacement cost")
        else:
            out["rce"] = amount
        rest = rest.replace(m.group(0), " ")
    if m := re.search(r"\blines?\s*[:=]?\s*(auto\s*(?:,|and|&|\+)?\s*home|home\s*(?:,|and|&|\+)?\s*auto|both|auto|home)\b", rest, re.I):
        out["lines"] = _parse_lines(m.group(1))
        rest = rest.replace(m.group(0), " ")
    has_ok = bool(BRIEF_OK.search(rest))
    rest = BRIEF_OK.sub(" ", rest)
    rest = re.sub(rf"\b({BRIEF_NO}|{BRIEF_ONLY}|and|but|please|thanks|thank you|the|rest|all|everything|else|of|them|it|that|with|to)\b",
                  " ", rest, flags=re.I)
    out["leftover"] = " ".join(w for w in re.sub(r"[^\w/$-]+", " ", rest).split() if re.search(r"[a-z0-9]", w, re.I))
    if out["leftover"]:
        out["problems"].append(f"I cannot apply '{out['leftover']}' from this reply — use amend_job(job_id, changes) for it, then answer 'ok'")
    # Edits alone ('rce 424000') change the brief and show it again; proposals are
    # accepted only with an explicit ok.
    out["edits"] = any(k in out for k in ("effective", "rce", "lines"))
    out["ok"] = has_ok and not out["problems"] and not out["stop"]
    return out


def _brief_text(job: Job, ev: dict[str, Any], proposals: list[dict[str, Any]], effective: tuple[date, str] | None,
                suggestion: date | None, rce: int | None = None) -> str:
    who = (ev.get("applicant") or {}).get("name") or f"account {job.account_id}"
    task, apps = ev.get("task") or {}, ev.get("applications") or {}
    lines = [f"Requote for {who} (account {job.account_id}) — {' + '.join(job.lobs)}"
             + (f" ({job.memo['linesFrom']})" if job.memo.get("linesFrom") else "") + ". What EZLynx shows and what I will do:"]
    if task:
        extra = f" — checklist: {'; '.join(task['checklist'])}" if task.get("checklist") else ""
        lines.append(f"Task ({task['client']}): \"{task['title']}\"{extra}")
    else:
        lines.append("Task: none found for this client in your task list.")
    if effective:
        lines.append(f"Effective date for {'both lines' if len(job.lobs) > 1 else job.lobs[0]}: {effective[0].strftime(DATE_FORMAT)} — from {effective[1]}.")
    else:
        lines.append(f"Effective date: no renewal date found — reply 'effective MM/DD/YYYY', or 'ok' for {suggestion.strftime(DATE_FORMAT) if suggestion else 'the suggestion'}.")
    for policy in ev.get("policies") or []:
        if not policy.get("lob"):
            continue
        summary = policy.get("summary") or {}
        bits = [f"{policy['number']} {policy['status']} {policy['lob']} with {policy['carrier'] or '?'}"]
        if summary.get("renewal"):
            premium = summary["renewal"].get("premium")
            bits.append(f"renews {summary['renewal']['date'].strftime(DATE_FORMAT)}" + (f" at ${premium:,.2f}" if premium else ""))
        if summary.get("changesAfter"):
            bits.append(f"changed since {summary.get('baseTerm')}: {', '.join(summary['changesAfter'])}")
        lines.append("Policy: " + "; ".join(bits))
        views = summary.get("views") or {}
        if summary.get("baseTerm") in views and "Today" in views:
            diff = _text_changes(views[summary["baseTerm"]], views["Today"], 6)
            if diff["added"] or diff["removed"]:
                lines.append(f"  since {summary['baseTerm'].split(' ')[0]}: " + "; ".join(
                    [f"+ {x}" for x in diff["added"]] + [f"− {x}" for x in diff["removed"]])[:600])
    for note in (ev.get("activity") or [])[:5]:
        lines.append(f"Activity: {_scrub(note)[:160]}")
    read_any = any((p.get("summary") or {}).get("views") for p in ev.get("policies") or [])
    if proposals:
        lines.append("Proposed changes:")
        lines += [f"  {p['id']} {p['what']} — {p['why']}" for p in proposals]
        removals = sum(1 for p in proposals if p["what"].startswith(("auto: remove", "home: remove")))
        if removals:
            lines.append(f"  ({removals} of these delete rows from the EZLynx application when the job reaches that screen.)")
    elif read_any and not ev.get("unread"):
        lines.append("Proposed changes: none — the saved applications match what I could read.")
    else:
        lines.append("Proposed changes: none from what I could read — the policy details were not all readable, so check them yourself.")
    home = apps.get("home") or {}
    if rce:
        lines.append(f"Home Coverage A / RCE: {rce:,} (as you said) — typed on the home coverage and the auto carrier question.")
    elif "home" in job.lobs and home.get("dwelling"):
        lines.append(f"Home Coverage A on the application is {home['dwelling']} — reply 'rce <amount>' if there is a new RCE figure.")
    if ev.get("unread"):
        lines.append("Could not read: " + "; ".join(ev["unread"])[:400])
    lines.append("Reply 'ok' to go ahead, 'ok except P2' to leave proposals out, 'effective MM/DD/YYYY' / 'rce N' / "
                 "'lines auto' to change those. Anything else (a new driver, a coverage change): amend_job first, then 'ok'.")
    return "\n".join(lines)


def _evidence_view(ev: dict[str, Any]) -> dict[str, Any]:
    """The brief's evidence as job_status shows it: JSON-safe, trimmed, scrubbed."""
    task = dict(ev.get("task") or {})
    if task:
        task["dates"] = {k or "any": d.strftime(DATE_FORMAT) for k, d in (task.get("dates") or {}).items()}
    out: dict[str, Any] = {"applicant": ev.get("applicant"), "task": task or None, "unread": ev.get("unread") or [],
                           "applications": ev.get("applications") or {},
                           "activity": [_scrub(n)[:400] for n in (ev.get("activity") or [])[:10]], "policies": []}
    for p in ev.get("policies") or []:
        summary = p.get("summary") or {}
        renewal = summary.get("renewal")
        out["policies"].append({k: v for k, v in p.items() if k not in ("summary", "i", "href")} | {
            "renewal": {**renewal, "date": renewal["date"].strftime(DATE_FORMAT)} if renewal else None,
            "terms": summary.get("terms"),
            "todayText": _scrub((summary.get("views") or {}).get("Today") or "")[:1500] or None})
    return out


async def _brief(job: Job, ev: dict[str, Any]) -> None:
    """One question with everything the evidence says — the associate confirms
    or corrects in one reply, instead of a question per screen or none at all."""
    today = date.today()
    max_days = int(_agency().get("maxDaysAhead") or 60)
    proposals = _proposals(job, ev)
    if job.requested_effective:
        effective: tuple[date, str] | None = (job.requested_effective, "the date given when the requote was started")
    else:
        effective = _bundle_effective(_effective_candidates(job, ev, today), today, max_days)
    suggestion = None
    if effective is None:
        app = next(iter((ev.get("applications") or {}).values()), {})
        suggestion = min(_suggest_effective(app.get("effective"), app.get("priorExpiration"), today), today + timedelta(days=max_days))
    ids = [p["id"] for p in proposals]
    job.memo["evidence"] = _evidence_view(ev)
    context = {"proposals": [{k: p[k] for k in ("id", "lob", "what", "why")} for p in proposals]}
    rce, note = None, ""
    while True:
        prompt = note + _brief_text(job, ev, proposals, effective, suggestion, rce)
        answer = await job.ask("brief", prompt, context=context)
        parsed = _parse_brief(answer, ids, today)
        if parsed["stop"]:
            raise JobError("Stopped at the requote brief, as asked. Nothing was changed in EZLynx.")
        # Edits take effect in the brief even when the reply is not yet an ok.
        if parsed.get("effective"):
            effective = (parsed["effective"], "the associate, in the brief")
        if parsed.get("rce"):
            rce = parsed["rce"]
        if parsed.get("lines"):
            job.lobs = [lob for lob in ("auto", "home") if lob in parsed["lines"]]
            job.memo["linesFrom"] = "as the associate said in the brief"
        if parsed["ok"]:
            break
        if parsed["problems"]:
            note = "Not applied yet: " + "; ".join(parsed["problems"]) + ".\n\n"
        elif parsed["edits"]:
            note = "Updated as asked — reply 'ok' to go ahead with this:\n\n"
        else:
            note = "I could not read that as an answer to the brief. " + ANSWER_HELP["brief"] + "\n\n"
    if job.memo.get("effectiveAmended") and not parsed.get("effective") and job.requested_effective:
        effective = (job.requested_effective, "the associate (amend_job)")
    elif effective is None:
        effective = (suggestion, "the suggestion the associate accepted")
    keep = parsed["only"] if parsed["only"] is not None else set(ids) - parsed["reject"]
    accepted = [p for p in proposals if p["id"] in keep and p["lob"] in job.lobs]
    for proposal in accepted:
        if proposal.get("patch"):
            job.facts = _amend_facts(job.facts, proposal["patch"])
    job.memo["declinedAnswers"] = {k for p in proposals if p not in accepted for k in p.get("answerKeys") or []}
    if rce:
        job.facts = _amend_facts(job.facts, {"dwelling": {"estimatedReplacementCost": rce}})
    for patch in job.memo.get("amendments") or []:  # what the associate said with amend_job wins over a proposal
        job.facts = _amend_facts(job.facts, patch)
    job.effective = {lob: effective[0] for lob in job.lobs}
    job.memo["effectiveFrom"] = {lob: effective[1] for lob in job.lobs}
    job.memo["brief"] = {"accepted": [p["what"] for p in accepted],
                         "declined": [p["what"] for p in proposals if p not in accepted],
                         **({"rce": rce} if rce else {})}
    job.note(f"brief confirmed: effective {effective[0].strftime(DATE_FORMAT)} ({effective[1]}); "
             f"{len(accepted)} of {len(proposals)} proposals accepted")


async def _read_account(job: Job) -> None:
    """A requote needs nothing stored here: EZLynx holds the account. Read what
    an associate reads — the applicant, their task, the applications, the
    policies as of today, the activity — settle the lines, and put it all to the
    associate once, as the brief."""
    b, tab = job.browser, job.tab
    job.step = "account"
    await _open(b, tab, f"{EZLYNX_BASE_URL}/web/account/{job.account_id}/details")
    applicant = await _read_applicant(b, tab, job.account_id)
    if applicant is None:
        raise JobError(f"EZLynx did not open account {job.account_id} — check_account says why.")
    name = f"{applicant.get('firstName') or ''} {applicant.get('lastName') or ''}".strip()
    job.memo["applicant"] = name
    task = await _find_task(b, tab, applicant.get("firstName") or "", applicant.get("lastName") or "", date.today(), job.account_id)
    job.memo["task"] = task
    await _open(b, tab, f"{EZLYNX_BASE_URL}/web/account/{job.account_id}/rating/quotes")
    found = await b.evaluate(tab, JS_APP_LINKS)
    if f"/account/{job.account_id}" not in found.get("path", ""):
        raise JobError(f"EZLynx did not open account {job.account_id} (landed on {found.get('path')}).")
    apps = found.get("apps") or {}
    job.memo["apps"] = apps
    job.note(f"account {job.account_id} ({name}): applications {', '.join(apps) or 'none found by link'}; "
             + (f"task \"{task['title'][:80]}\"" if task else "no task for this client in the task list"))
    if not job.lobs:
        if len(apps) == 1:
            job.lobs = list(apps)
        elif len(apps) > 1 and _agency().get("bundleWhenBothExist", True):
            job.lobs = ["auto", "home"]
            job.memo["linesFrom"] = "both applications exist and the agency quotes the bundle"
        else:
            hinted = (task or {}).get("lines") or []
            suggestion = ",".join(hinted or [lob for lob in ("auto", "home") if lob in apps] or ["auto", "home"])
            prompt = (f"Which lines should be requoted? EZLynx has {' and '.join(apps)} applications on this account."
                      if apps else "Which lines should be requoted? I could not read the account's applications.")
            while not job.lobs:
                job.lobs = _parse_lines(await job.ask("lines", prompt, options=["auto", "home", "auto,home"], suggestion=suggestion)) or []
    for lob in [lob for lob in job.lobs if apps and lob not in apps]:
        answer = await job.ask("add_line", f"The account has no {lob} application. Start a new {lob} quote on it, or leave {lob} out?",
                               options=[f"start {lob}", f"leave {lob} out"])
        if not _norm(answer).startswith("start"):  # creating an application needs a clear yes
            job.lobs.remove(lob)
    if not job.lobs:
        raise JobError("No lines left to requote.")
    job.state = "running"
    job.note("reading the policies, activity and saved applications")
    ev = await _gather(b, tab, job.account_id, job.lobs, apps, {"name": name}, task)
    await _brief(job, ev)
    job.memo["linesSettled"] = True


async def _walk(job: Job) -> bool:
    """One pass over the wizard, both lines, up to the submit gate. Safe to repeat:
    EZLynx saved every screen, writes skip values already right, and answered
    questions leave nothing to ask."""
    b = job.browser
    job.state = "running"
    await _settle(b, job.tab)
    await _guard(b, job.tab)
    if job.kind == "requote" and not job.memo.get("linesSettled"):
        await _read_account(job)
    await _enter(job)
    for index, lob in enumerate(job.lobs):
        if index:  # recs 3 and 5: from the auto finish straight into home
            await b.click(job.tab, f"#save-and-go-to-{lob}-btn")
            path = await _wait_path(b, job.tab, rf"/rating/{lob}/\d+/", 45)
            if not path:
                raise JobError(f"'Go to {lob}' did not open the {lob} application.")
            job.app_ids[lob] = re.search(rf"/rating/{lob}/(\d+)/", path).group(1)
            await _settle(b, job.tab)
        read = ((job.memo.get("evidence") or {}).get("applications") or {}).get(lob, {}).get("appId")
        if read and job.app_ids.get(lob) and read != job.app_ids[lob]:
            job.problems.append(f"the brief read {lob} application {read}, but EZLynx opened {job.app_ids[lob]} — check its values")
        for step_index, (route, _) in enumerate(STEPS[lob]):
            if step_index:
                await _goto(job, lob, route)
            await _step(job, lob, route)
        await _finish(job, lob)
    while True:
        for _ in range(6):  # amend_job corrections for screens already passed
            again = [lob for lob in job.lobs if lob in job.memo.get("rewalk", set())]
            if not again:
                break
            job.memo["rewalk"] = set()
            for lob in again:
                job.note(f"{lob}: going through again for the corrections made with amend_job")
                await _open(b, job.tab, f"{EZLYNX_BASE_URL}/web/account/{job.account_id}/rating/{lob}/{job.app_ids[lob]}/rating")
                for step_index, (route, _) in enumerate(STEPS[lob]):
                    if step_index:
                        await _goto(job, lob, route)
                    await _step(job, lob, route)
                await _finish(job, lob)
        if job.memo.get("rewalk"):
            raise JobError("Corrections kept arriving while the job went through the screens again; nothing was submitted. "
                           "Start the requote again once the changes are settled.")
        outcome = await _submit_gate(job)
        if outcome != "rewalk":
            return bool(outcome)


async def _run(job: Job) -> None:
    try:
        async with _lock(job.user):
            async with httpx.AsyncClient(timeout=CAMOFOX_TIMEOUT_S) as http:
                job.browser = Browser(http, CAMOFOX_URL, _profile(job.user), CAMOFOX_ACCESS_KEY, session_key=CAMOFOX_SESSION_KEY)
                for attempt in range(3):
                    job.tab = await job.browser.open_tab(f"{EZLYNX_BASE_URL}/web/dashboard")
                    try:
                        submitted = await _walk(job)
                        if submitted:
                            job.report = await _collect(job)
                            job.report["taskNote"] = _task_note(job, job.report)
                            store.save_quote(job.user, _report_key(job.account_id), job.report)
                        break
                    except (CamofoxError, httpx.HTTPError) as err:
                        # camofox tears down the whole session when a click times out. Before
                        # submission, reopen and walk again; after it, never — that could submit twice.
                        if attempt == 2 or "submittedAt" in job.memo:
                            raise
                        job.note(f"browser hiccup ({err}); reopening and picking up from what EZLynx saved")
                    finally:
                        with suppress(Exception):
                            await job.browser.close_tab(job.tab)
                _remember_facts(job)
                job.result = {
                    "accountId": job.account_id, "submitted": submitted, "validated": True,
                    "approvedBy": job.approved_by, "approvedVia": job.approved_via,
                    "report": _summary(job.report) if job.report else None,
                    "taskNote": (job.report or {}).get("taskNote"),
                    "next": ("Show the associate taskNote.draft (and the hand-off, if any); post it with update_task "
                             "only after they approve it.") if (job.report or {}).get("taskNote", {}).get("draft") else None,
                }
                job.state = "done"
    except asyncio.CancelledError:
        job.state, job.error = "cancelled", "Cancelled. EZLynx kept every screen saved so far."
    except JobError as err:
        job.state, job.error = "failed", str(err)
    except (CamofoxError, httpx.HTTPError) as err:
        job.state, job.error = "failed", f"camofox: {err}"
    except Exception as err:  # a job must never die silently
        job.state, job.error = "failed", f"{type(err).__name__}: {err} (at {job.step})"
    finally:
        if "submittedAt" in job.memo and job.state != "done":
            # The carriers already have it. "Restart" here would submit — and pull credit — twice.
            job.result = {"accountId": job.account_id, "submitted": True, "submittedAt": job.memo["submittedAt"],
                          "approvedBy": job.approved_by, "approvedVia": job.approved_via}
            job.error = (f"{job.error} Account {job.account_id} WAS submitted to the carriers at {job.memo['submittedAt']}. "
                         "Do not start it again — that submits a second time. Read the results with "
                         "refresh_results(account_id) or in EZLynx.")
        elif job.state == "failed" and job.account_id:
            job.error = f"{job.error} Account {job.account_id} — restart with start_requote/start_quote(account_id=...)."
        job.note(f"finished: {job.state}")


def _remember_facts(job: Job) -> None:
    """Store the facts the run just validated for the next requote — minus the
    one-shot parts. Dates stay out: EZLynx keeps them, and next year's requote
    must ask for a new effective date rather than retype this one."""
    if job.kind == "requote":  # its facts are corrections, not the household: keep what was stored
        stored = store.read_quote(job.user, job.account_id) or {}
        store.save_quote(job.user, job.account_id, {**stored, "_lines": ",".join(job.lobs)})
        return
    # A credit consent is for this submission only — never carried to next year's run.
    facts = {k: v for k, v in job.facts.items() if k not in ("effectiveDate", "creditAuthorization")}
    for key in ("priorAuto", "priorHome"):
        if isinstance(facts.get(key), dict):
            facts[key] = {k: v for k, v in facts[key].items() if k != "expirationDate"}
    for key in ("drivers", "vehicles"):
        if isinstance(facts.get(key), list):
            facts[key] = [{k: v for k, v in row.items() if k != "replaces"} for row in facts[key] if not row.get("remove")]
    facts["_lines"] = ",".join(job.lobs)
    store.save_quote(job.user, job.account_id, facts)


def _task_note(job: Job, report: dict[str, Any]) -> dict[str, Any]:
    """The note Salwa leaves on the task — "Roof age 8 / 1 driver - 1 vehicle /
    Qualified on Hartford ( NatGen declined ) / Hartford Home: $2,279 Auto:
    $1,540/year" — drafted for the associate to post with update_task."""
    task = job.memo.get("task") or {}
    best: dict[str, dict[str, float]] = {}
    for quote in report.get("quotes") or []:
        carrier = quote.get("carrier")
        if not carrier or not quote.get("annualPremium"):
            continue
        entry = best.setdefault(carrier, {})
        if quote.get("lob") == "package" and quote.get("components") and quote.get("termMonths"):
            for lob, amount in quote["components"].items():
                entry[lob] = min(entry.get(lob, 1e12), round(amount * 12 / quote["termMonths"], 2))
        elif quote.get("lob") in ("auto", "home"):
            entry[quote["lob"]] = min(entry.get(quote["lob"], 1e12), quote["annualPremium"])
    complete = {c: e for c, e in best.items() if all(lob in e for lob in job.lobs)}
    out: dict[str, Any] = {"task": task.get("title"), "handOffTo": task.get("handOffTo"), "draft": None}
    if not complete:
        out["why"] = f"no carrier quoted {' and '.join(job.lobs)} yet"
        return out
    carrier, amounts = min(complete.items(), key=lambda kv: sum(kv[1][lob] for lob in job.lobs))
    name = _carrier_short(carrier)
    current = job.memo.get("current") or {}
    lines = []
    if str(task.get("roofYear") or "").isdigit():
        lines.append(f"Roof age {date.today().year - int(task['roofYear'])}")
    if "auto" in job.lobs and current.get("auto drivers") is not None:
        nd, nv = len(current.get("auto drivers") or []), len(current.get("auto vehicles") or [])
        lines.append(f"{nd} driver{'s' if nd != 1 else ''} - {nv} vehicle{'s' if nv != 1 else ''}")
    declined = [_carrier_short(e["carrier"]) for e in report.get("errors") or [] if e.get("errorClass") == "decline" and e.get("carrier")]
    lines.append(f"Qualified on {name}" + (f" ( {', '.join(declined[:3])} declined )" if declined else ""))
    lines.append(f"{name} " + " ".join(f"{lob.title()}: ${amounts[lob]:,.0f}" for lob in ("home", "auto") if lob in amounts) + "/year")
    out["draft"] = "\n".join(lines)
    return out


def _summary(report: dict[str, Any] | None) -> dict[str, Any] | None:
    if not report:
        return None
    return {
        "quoted": len(report["quotes"]),
        "best": [{k: q.get(k) for k in ("carrier", "lob", "premium", "termMonths", "annualPremium", "altQuote")}
                 for q in report["quotes"][:5]],
        "errors": [{k: e.get(k) for k in ("carrier", "lob", "errorClass", "error")} for e in report["errors"]][:10],
        "stillRating": report["stillRating"],
        "resultsUrl": report["resultsUrl"],
    }


def _start(kind: str, facts: dict[str, Any], lobs: list[str], account_id: str | None, effective: date | None) -> Job:
    user = USER.get()
    _require_idle(user)
    job = Job(f"{kind}-{next(_job_seq)}", user, kind, lobs, facts, account_id, effective)
    _jobs[job.id] = job
    for old in [j for j in _jobs.values() if j.state in FINISHED][:-20]:
        _jobs.pop(old.id, None)
    job.task = asyncio.create_task(_run(job))
    return job


async def _wait(job: Job, seconds: float) -> None:
    """Return when the job needs a person, finishes, or `seconds` pass."""
    deadline = time.monotonic() + min(seconds, 110)
    while job.state not in FINISHED and job.pending is None and time.monotonic() < deadline:
        with suppress(asyncio.TimeoutError):
            await asyncio.wait_for(job.changed.wait(), timeout=max(0.1, deadline - time.monotonic()))


# ================================================================ tools: session

@mcp.tool(annotations={"readOnlyHint": True})
async def ezlynx_status() -> dict[str, Any]:
    """Saved credentials, last sign-in, a pending one-time code, and the active job."""
    user = USER.get()
    parked = awaiting_code.get(user)
    active = _active_job(user)
    return {**store.status(user), "mfaPending": parked is not None and parked[1] > time.monotonic(),
            "user": user, "camofoxUserId": _profile(), "activeJob": active.id if active else None}


ANSWER_SCHEMA = {"type": "object", "properties": {"value": {"type": "string", "title": "Answer"}}, "required": ["value"]}
# The gate is a checkbox and a name, never free text: "no" typed into a text box
# must not read as a non-empty approval.
APPROVAL_SCHEMA = {
    "type": "object",
    "properties": {
        "approve": {"type": "boolean", "title": "Submit to the carriers now?"},
        "approved_by": {"type": "string", "title": "Your name (recorded as the approver)"},
    },
    "required": ["approve", "approved_by"],
}


@dataclass
class Approval:
    approve: bool
    approved_by: str


async def _ask_operator(ctx: Context, key: str, prompt: str, state: dict[str, Any],
                        approval: bool = False) -> dict[str, Any] | None | InputRequiredResult:
    """Put one question to the person at the MCP client.

    The two protocol eras are mutually exclusive in fastmcp 4: handshake-era
    clients take a server-initiated ctx.elicit; 2026-07-28 clients refuse it and
    instead expect the tool to RETURN an InputRequiredResult, then call it again
    with the answer in ctx.input_responses[key]. Returns the reply ({"value": ...},
    or {"approve", "approved_by"} at the gate), None when the client cannot ask or
    the person dismissed it, or the InputRequiredResult to return."""
    try:
        reply = await ctx.elicit(prompt, response_type=Approval if approval else str)
    except ToolError as err:
        if "2026-07-28" not in str(err):
            return None
        schema = APPROVAL_SCHEMA if approval else ANSWER_SCHEMA
        request = ElicitRequest(params=ElicitRequestFormParams(message=prompt, requested_schema=schema))
        return InputRequiredResult(input_requests={key: request}, request_state=json.dumps(state))
    except Exception:
        return None
    if getattr(reply, "action", None) != "accept":
        return None
    data = reply.data
    return {"approve": data.approve, "approved_by": data.approved_by} if approval else {"value": str(data or "")}


def _returned_answer(ctx: Context, key: str) -> tuple[bool, dict[str, Any] | None, dict[str, Any]]:
    """(this is the re-call carrying a reply, the reply — None if dismissed — and the carried state)."""
    reply = (ctx.input_responses or {}).get(key)
    state = json.loads(ctx.request_state) if ctx.request_state else {}
    if reply is None:
        return False, None, state
    return True, (dict(reply.content or {}) if reply.action == "accept" else None), state


@mcp.tool(annotations={"openWorldHint": True})
async def ezlynx_login(ctx: Context) -> dict[str, Any]:
    """Sign in with the saved credentials (the Connections page saves them; this
    never takes a password). Returns `connected`, or `mfa_required` — then call
    ezlynx_verify with the code, unless the client let the operator type it here."""
    user = USER.get()
    returned, reply, _ = _returned_answer(ctx, "code")
    if returned:  # the second leg: the client collected the code we asked for
        code = str((reply or {}).get("value") or "").strip()
        if not code:
            return {"result": "mfa_required", "message": "No code was entered. Call ezlynx_verify with it."}
        return await _verify(user, code)
    _require_idle(user)
    credentials = store.read(user)
    if credentials is None:
        raise ToolError(f"No EZLynx credentials are saved for '{user}'. Save them on the Connections page first.")
    async with _lock(user):
        awaiting_code.pop(user, None)
        async with httpx.AsyncClient(timeout=CAMOFOX_TIMEOUT_S) as client:
            camofox = Browser(client, CAMOFOX_URL, _profile(), CAMOFOX_ACCESS_KEY, session_key=CAMOFOX_SESSION_KEY)
            try:
                result = await login(camofox, EZLYNX_BASE_URL, *credentials)
            except (CamofoxError, httpx.HTTPError) as err:
                raise ToolError(f"camofox is not answering: {err}") from err
        if result["status"] == "mfa_required":  # the tab waits on the code screen
            awaiting_code[user] = (result["tabId"], time.monotonic() + MFA_WINDOW_S)
        store.mark_connected(user, result["status"] == "connected")
    if result["status"] != "mfa_required":
        return {"result": result["status"], "message": result.get("message")}
    # Asked outside the lock: a person may take a minute to find the text message.
    asked = await _ask_operator(ctx, "code", "EZLynx sent a one-time code. Enter it to finish signing in.", {})
    if isinstance(asked, InputRequiredResult):
        return asked
    code = str((asked or {}).get("value") or "").strip()
    if code:
        return await _verify(user, code)
    return {"result": "mfa_required", "message": "EZLynx sent a one-time code. Call ezlynx_verify with it."}


@mcp.tool(annotations={"openWorldHint": True})
async def ezlynx_verify(code: str) -> dict[str, Any]:
    """Finish a sign-in that asked for a one-time code. The code is never stored;
    a wrong code can be retried until the sign-in expires."""
    return await _verify(USER.get(), code)


async def _verify(user: str, code: str) -> dict[str, Any]:
    _require_idle(user)
    async with _lock(user):
        pending = awaiting_code.get(user)
        if pending is None:
            raise ToolError("No sign-in is waiting for a code. Call ezlynx_login.")
        async with httpx.AsyncClient(timeout=CAMOFOX_TIMEOUT_S) as client:
            camofox = Browser(client, CAMOFOX_URL, _profile(), CAMOFOX_ACCESS_KEY, session_key=CAMOFOX_SESSION_KEY)
            if pending[1] < time.monotonic():
                awaiting_code.pop(user, None)
                with suppress(Exception):
                    await camofox.close_tab(pending[0])
                raise ToolError("That sign-in expired. Call ezlynx_login again.")
            try:
                result = await submit_code(camofox, pending[0], code.strip())
            except (CamofoxError, httpx.HTTPError) as err:
                raise ToolError(f"camofox is not answering: {err}") from err
        if result["status"] == "connected":
            awaiting_code.pop(user, None)
        store.mark_connected(user, result["status"] == "connected")
        return {"result": result["status"], "message": result.get("message")}


# ================================================================ tools: look-ups

async def _with_tab(url: str, reader):
    """Open one page in the signed-in profile, read it, close it."""
    user = USER.get()
    _require_idle(user)
    async with _lock(user):
        async with httpx.AsyncClient(timeout=CAMOFOX_TIMEOUT_S) as http:
            b = Browser(http, CAMOFOX_URL, _profile(), CAMOFOX_ACCESS_KEY, session_key=CAMOFOX_SESSION_KEY)
            tab = None
            try:
                tab = await b.open_tab(url)
                await _settle(b, tab)
                await _guard(b, tab)
                return await reader(b, tab)
            except JobError as err:
                raise ToolError(str(err)) from err
            except (CamofoxError, httpx.HTTPError) as err:
                raise ToolError(f"camofox is not answering: {err}") from err
            finally:
                if tab is not None:
                    with suppress(Exception):
                        await b.close_tab(tab)


def _check_account_id(account_id: str) -> None:
    if not ACCOUNT_ID.fullmatch(account_id or ""):
        raise ToolError("An EZLynx account id is digits only.")


APPLICANT_SUMMARY = {
    "firstName": "#applicant-first-name", "lastName": "#applicant-last-name", "city": "#applicant-primary-address-addressCity",
    "state": "#applicant-primary-address-addressState", "postalCode": "#applicant-primary-address-postalCode",
    "dateOfBirth": "#applicant-date-of-birth", "producer": "#input-assigned-to", "csr": "#input-csr",
}


async def _read_applicant(b: Browser, tab: str, account_id: str) -> dict[str, Any] | None:
    for _ in range(10):  # the SPA fills the form a beat after the route settles
        path = await b.evaluate(tab, "location.pathname")
        if f"/account/{account_id}" not in path:
            return None
        values = {k: (await b.evaluate(tab, js_describe(s))).get("value") for k, s in APPLICANT_SUMMARY.items()}
        if values["firstName"] or values["lastName"]:
            values["dateOfBirth"] = _redact(values["dateOfBirth"], "dateOfBirth")
            return values
        await asyncio.sleep(1)
    return None


@mcp.tool(annotations={"readOnlyHint": True, "openWorldHint": True})
async def list_renewals() -> dict[str, Any]:
    """The Renewal Center queue — the accounts coming up for a requote, with their
    EZLynx account ids and renewal dates (the page rec 4 checked)."""
    async def read(b: Browser, tab: str) -> dict[str, Any]:
        rows = await b.evaluate(tab, JS_RENEWALS)
        return {"renewals": rows, "count": len(rows)}
    return await _with_tab(f"{EZLYNX_BASE_URL}/EZLynxRenewalCenter/overview/index", read)


@mcp.tool(annotations={"readOnlyHint": True, "openWorldHint": True})
async def check_account(account_id: str) -> dict[str, Any]:
    """Whether an EZLynx account exists and is visible to this user, and who the
    applicant is — one page load, before quoting an id typed from memory."""
    _check_account_id(account_id)

    async def read(b: Browser, tab: str) -> dict[str, Any]:
        applicant = await _read_applicant(b, tab, account_id)
        path = await b.evaluate(tab, "location.pathname")
        return {"accountId": account_id, "exists": applicant is not None, "applicant": applicant, "landedOn": path}
    return await _with_tab(f"{EZLYNX_BASE_URL}/web/account/{account_id}/details", read)


@mcp.tool(annotations={"readOnlyHint": True, "openWorldHint": True})
async def get_account_context(account_id: str) -> dict[str, Any]:
    """What an associate reads before a requote, read the same way the requote
    does: the applicant, THEIR task (title, dates, checklist, discussion,
    hand-off), the rating applications, each policy on the account overview with
    its applicant-portal summary as of Today and the renewal term, the Activity
    notes, the saved applications' key values — and the changes that evidence
    suggests (the same P1, P2 ... a requote's brief would propose)."""
    _check_account_id(account_id)
    base = f"{EZLYNX_BASE_URL}/web/account/{account_id}"

    async def read(b: Browser, tab: str) -> dict[str, Any]:
        applicant = await _read_applicant(b, tab, account_id)
        if applicant is None:
            raise ToolError(f"EZLynx did not open account {account_id}. check_account says why.")
        today = date.today()
        task = await _find_task(b, tab, applicant.get("firstName") or "", applicant.get("lastName") or "", today, account_id)
        await _open(b, tab, f"{base}/rating/quotes")
        apps = (await b.evaluate(tab, JS_APP_LINKS)).get("apps") or {}
        name = f"{applicant.get('firstName') or ''} {applicant.get('lastName') or ''}".strip()
        lobs = [lob for lob in ("auto", "home") if lob in apps]
        ev = await _gather(b, tab, account_id, lobs, apps, {"name": name}, task)
        probe = Job("context", USER.get(), "requote", lobs, {}, account_id, None)
        effective = _bundle_effective(_effective_candidates(probe, ev, today), today, int(_agency().get("maxDaysAhead") or 60))
        policies = []
        for p in ev["policies"]:
            summary = p.get("summary") or {}
            views = summary.get("views") or {}
            policies.append({k: v for k, v in p.items() if k not in ("summary", "i", "href")} | {
                "terms": summary.get("terms"), "baseTerm": summary.get("baseTerm"), "changesAfter": summary.get("changesAfter"),
                "todayText": (views.get("Today") or "")[:2500] or None,
                "changedSinceBaseTerm": _text_changes(views[summary["baseTerm"]], views["Today"]) if summary.get("baseTerm") in views and "Today" in views else None})
        stored = store.read_quote(USER.get(), account_id)
        return {
            "accountId": account_id,
            "applicant": applicant,
            "applications": apps,
            "task": task,
            "effectiveDate": {"date": effective[0].strftime(DATE_FORMAT), "from": effective[1]} if effective else None,
            "policies": policies,
            "activity": ev["activity"],
            "savedApplications": ev["applications"],
            "proposedChanges": [{k: p[k] for k in ("id", "lob", "what", "why")} for p in _proposals(probe, ev)],
            "unread": ev["unread"],
            "storedFacts": _redact({k: v for k, v in stored.items() if not k.startswith("_")}) if stored else None,
            "lastReport": _summary(store.read_quote(USER.get(), _report_key(account_id))),
        }
    return await _with_tab(f"{base}/details", read)


@mcp.tool(annotations={"readOnlyHint": True, "openWorldHint": True})
async def my_tasks() -> dict[str, Any]:
    """The signed-in associate's EZLynx task list — where requotes come from
    ("Richard Dupont - AAA 11 16 26"): client, title, the dates / carrier / roof
    year / hand-off it carries, and the account id when the task links to one."""
    async def read(b: Browser, tab: str) -> dict[str, Any]:
        with suppress(CamofoxError, httpx.HTTPError):
            await _page_click(b, tab, "#task-list-header")
            await _settle(b, tab, 8)
        listing = await b.evaluate(tab, JS_TASKS) or {}
        today, seen, tasks = date.today(), set(), []
        for item in listing.get("items") or []:
            parsed = _parse_task(SSN_VALUE.sub("•••", item["text"]), today)
            if parsed["title"] in seen:
                continue
            seen.add(parsed["title"])
            link = re.search(r"/account/(\d+)", item.get("link") or "")
            tasks.append({"client": parsed["client"], "title": parsed["title"], "group": item.get("group"),
                          "dates": {k or "any": v.strftime(DATE_FORMAT) for k, v in parsed["dates"].items()},
                          "carrier": parsed["carrier"], "roofYear": parsed["roofYear"], "handOffTo": parsed["handOffTo"],
                          "accountId": link.group(1) if link else None})
        return {"tasks": tasks, "count": len(tasks),
                "note": None if listing.get("found") else "No task list on this page — EZLynx may have moved it."}
    return await _with_tab(f"{EZLYNX_BASE_URL}/web/dashboard", read)


@mcp.tool(annotations={"readOnlyHint": True, "openWorldHint": True})
async def find_account(name: str) -> dict[str, Any]:
    """An account id from a client's name — "requote Brandon Detweiler" — by
    looking where associates find them: their task list and the Renewal Center."""
    words = [w for w in re.findall(r"[a-z'-]+", _norm(name)) if len(w) > 1]
    if not words:
        raise ToolError("Give the client's name, e.g. 'Brandon Detweiler'.")
    first, last = (words[0], words[-1]) if len(words) > 1 else ("", words[0])

    async def read(b: Browser, tab: str) -> dict[str, Any]:
        found: list[dict[str, Any]] = []
        with suppress(CamofoxError, httpx.HTTPError):
            await _page_click(b, tab, "#task-list-header")
            await _settle(b, tab, 8)
        for item in (await b.evaluate(tab, JS_TASKS) or {}).get("items") or []:
            parsed = _parse_task(item["text"], date.today())
            if _name_match(parsed["client"], first, last):
                link = re.search(r"/account/(\d+)", item.get("link") or "")
                found.append({"source": "task", "client": parsed["client"], "title": parsed["title"],
                              "accountId": link.group(1) if link else None})
        with suppress(CamofoxError, httpx.HTTPError, JobError):
            await _open(b, tab, f"{EZLYNX_BASE_URL}/EZLynxRenewalCenter/overview/index")
            for row in await b.evaluate(tab, JS_RENEWALS) or []:
                if _name_match(row["text"], first, last):
                    found.append({"source": "renewal center", "accountId": row["accountId"], "text": row["text"][:160]})
        ids = sorted({f["accountId"] for f in found if f.get("accountId")})
        return {"name": name, "matches": found, "accountIds": ids,
                "note": None if ids else "No account id found in the task list or the Renewal Center — ask the associate for the account number (it is in the EZLynx URL)."}
    return await _with_tab(f"{EZLYNX_BASE_URL}/web/dashboard", read)


@mcp.tool(annotations={"destructiveHint": True, "openWorldHint": True})
async def update_task(account_id: str, note: str, approved_by: str, assign_to: str | None = None,
                      expected_task: str | None = None) -> dict[str, Any]:
    """Post the result note on the client's EZLynx task and, optionally, hand
    the task to the producer it names ("Goes To Tina") — what Salwa does after
    every requote. This writes to the agency's EZLynx: show the associate the
    exact note first, and pass `approved_by` = the name of the person who said
    yes. A job's result carries the drafted note (taskNote.draft) and the task's
    title (taskNote.task) — pass that as `expected_task` so nothing is written to
    a different task."""
    _check_account_id(account_id)
    if not MODEL_APPROVAL:
        raise ToolError("Task notes are posted from the Savvy app in this deployment, not here.")
    if not (approved_by or "").strip():
        raise ToolError("approved_by is required: the associate who approved posting this note.")
    if not note.strip():
        raise ToolError("The note is empty.")

    async def write(b: Browser, tab: str) -> dict[str, Any]:
        applicant = await _read_applicant(b, tab, account_id)
        if applicant is None:
            raise ToolError(f"EZLynx did not open account {account_id}.")
        task = await _find_task(b, tab, applicant.get("firstName") or "", applicant.get("lastName") or "", date.today(), account_id)
        if task is None:
            raise ToolError("No task for this client in your task list — post the note in EZLynx yourself.")
        if expected_task and _norm(expected_task) not in _norm(task["title"]):
            raise ToolError(f"The task found is \"{task['title']}\", not \"{expected_task}\" — nothing was written.")
        if not task.get("opened"):
            raise ToolError(f"Could not open the task \"{task['title']}\" to write in it — nothing was written.")
        out: dict[str, Any] = {"task": task["title"], "client": task["client"]}
        typed = await set_field(b, tab, '[name="taskNote"]', note)
        if not (typed.get("applied") or typed.get("skipped") == "already-set"):
            raise ToolError("The task's note field could not be typed into — nothing was saved.")
        # The Save button next to the note, inside the task detail — never a button elsewhere on the page.
        save = await b.evaluate(tab, _js(
            r"""const note = q('[name="taskNote"]'); if (!note) return null;
            let box = note.parentElement, btn = null;
            for (let d = 0; d < 6 && box && !btn; d++, box = box.parentElement)
              btn = qa('button', box).filter(vis).find((e) => /^(save|save note|add note|post)$/i.test(txt(e)));
            if (!btn) return null; btn.setAttribute('data-savvy-save', '1'); return txt(btn);"""))
        if not save:
            raise ToolError("Typed the note but found no Save button next to it — save it in EZLynx yourself.")
        await _page_click(b, tab, '[data-savvy-save="1"]')
        await _settle(b, tab, 8)
        out["saved"] = f"clicked '{save}'"
        if assign_to:
            try:
                assigned = await set_field(b, tab, "mat-form-field.assign-task input", assign_to)
                out["assignedTo"] = assigned.get("value")
            except FieldError as err:
                out["assignedTo"] = None
                out["assignWarning"] = str(err)
        out["approvedBy"] = approved_by.strip()
        return out
    return await _with_tab(f"{EZLYNX_BASE_URL}/web/account/{account_id}/details", write)


@mcp.tool(annotations={"readOnlyHint": True})
async def get_agency_defaults() -> dict[str, Any]:
    """The agency-wide defaults every associate's runs use — carriers per line,
    the 60-day effective-date limit, bundling, prior carrier/limits refresh,
    commute miles, fields, remembered carrier answers — and where they came from."""
    stored = store.read_quote(AGENCY, AGENCY_DEFAULTS_KEY)
    answers = store.read_quote(AGENCY, ANSWERS_KEY) or {}
    return {"defaults": _agency(), "source": "edited" if stored else "seeded from Salwa Noor's recordings (Sep 2026)",
            "rememberedAnswers": {k: {"value": v.get("value"), "by": v.get("by"), "at": v.get("at")}
                                  for k, v in answers.items() if v.get("auto")}}


@mcp.tool
async def set_agency_defaults(patch: dict[str, Any], changed_by: str) -> dict[str, Any]:
    """Change the agency-wide defaults for EVERY associate (merge: dicts merge,
    lists replace, null deletes) — e.g. {"carriers": {"auto": {"include":
    ["The Hartford", "GEICO"]}}} or {"commuteOneWayMiles": null}. Only on the
    say-so of someone who sets agency practice; `changed_by` is their name."""
    if not (changed_by or "").strip():
        raise ToolError("changed_by is required: who decided this agency default.")
    if AGENCY_ADMINS and USER.get() not in AGENCY_ADMINS:
        raise ToolError("Agency defaults are changed by the agency's admins (EZLYNX_AGENCY_ADMINS), not from this account.")
    merged = _deep_merge(_agency(), patch)
    if problems := _check_agency(merged):
        raise ToolError("Not saved: " + "; ".join(problems))
    merged["_changed"] = {"by": changed_by.strip(), "at": _now(), "patch": sorted(patch)}
    store.save_quote(AGENCY, AGENCY_DEFAULTS_KEY, merged)
    return {"defaults": merged}


# ================================================================ tools: facts

@mcp.tool(annotations={"readOnlyHint": True})
async def get_quote_facts(account_id: str) -> dict[str, Any]:
    """Facts this server remembered from earlier runs (licence numbers and birth
    dates masked). Optional: a requote does not need any."""
    _check_account_id(account_id)
    facts = store.read_quote(USER.get(), account_id)
    if facts is None:
        return {"accountId": account_id, "facts": None,
                "note": "Nothing stored here yet, and nothing needs to be: start_requote works from what EZLynx holds."}
    return {"accountId": account_id, "lines": facts.get("_lines") or _infer_lines(facts),
            "facts": _redact({k: v for k, v in facts.items() if not k.startswith("_")})}


@mcp.tool
async def update_quote_facts(account_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    """Merge confirmed fact changes into an account's stored facts — no browser.
    Dicts merge, lists replace, null deletes. A new dwelling.estimatedReplacementCost
    also becomes Coverage A and replaces the old figure in carrier answers."""
    _check_account_id(account_id)
    user = USER.get()
    async with _fact_locks.setdefault(user, asyncio.Lock()):
        stored = store.read_quote(user, account_id) or {}
        merged = _fan_out_rce(stored, _deep_merge(stored, patch))
        store.save_quote(user, account_id, merged)
    lobs = _lobs(merged.get("_lines") or _infer_lines(merged) or "auto,home")
    return {"accountId": account_id, "changed": sorted(patch), "missing": _missing(merged, lobs, False)}


# ================================================================ tools: runs

@mcp.tool(annotations={"openWorldHint": True})
async def start_quote(quote: dict[str, Any], lines: str | None = None, account_id: str | None = None,
                      effective_date: str | None = None) -> dict[str, Any]:
    """Quote a new applicant (or an existing account never quoted before) end to
    end: create the applicant, walk every auto and/or home screen, park on each
    question for the associate, park again before submitting to carriers, then
    collect the results.

    `quote` is the QuoteRequest JSON (applicant, address, drivers[], vehicles[],
    priorAuto/priorHome, autoCoverage, dwelling, homeCoverage, household, carriers
    {auto|home: {mode, include, exclude}}, quoteTemplates {auto|home},
    carrierAnswers {selector: value}, producer, csr, creditAuthorization). Anything
    unmodelled goes in `fields` {"auto/coverage": {"#selector": value}}.
    Returns {missing: [...]} instead of starting when EZLynx would refuse anyway —
    ask the associate for those. Otherwise returns a job id: follow it with
    job_status(job_id, wait_seconds=60)."""
    if account_id is not None:
        _check_account_id(account_id)
    lobs = _lobs(lines or _infer_lines(quote) or "")
    missing = _missing(quote, lobs, account_id is None)
    if missing:
        return {"started": False, "missing": missing}
    effective = None
    if effective_date is not None:
        effective = _date(effective_date)
        if effective is None or effective <= date.today():
            raise ToolError("effective_date must be a future date like 11/14/2026.")
    facts = dict(quote)
    if account_id:
        facts = _fan_out_rce(store.read_quote(USER.get(), account_id) or {}, _deep_merge(store.read_quote(USER.get(), account_id) or {}, quote))
    job = _start("quote", facts, lobs, account_id, effective)
    return {"started": True, "jobId": job.id, "lines": ",".join(lobs),
            "next": "job_status(job_id, wait_seconds=60); relay each question to the associate."}


@mcp.tool(annotations={"openWorldHint": True})
async def start_requote(account_id: str, lines: str | None = None, effective_date: str | None = None,
                        changes: dict[str, Any] | None = None) -> dict[str, Any]:
    """Requote ANY existing EZLynx account — nothing has to be stored first; the
    run reads what an associate reads. It opens the client's own task in the
    associate's task list (dates, carrier, roof year, hand-off, checklist), the
    account's applications (both exist -> the bundle, per agency default), the
    policies on the account overview with their applicant-portal summary as of
    Today against the renewal term (current carrier, renewal date and premium,
    vehicles and drivers on the policy now), and the Activity notes. Then it parks
    ONE question, kind 'brief': one effective date for every line (earliest
    evidence, never more than the agency's 60 days out) and numbered proposed
    changes (P1, P2 ... — prior carrier/limits, vehicles/drivers added or gone,
    roof year, agency carriers and defaults). Relay it verbatim; the associate
    answers 'ok' / 'ok except P2' / 'effective 11/22/2026' / 'rce 424000'.

    Then it walks every screen, adds/removes driver and vehicle rows, deletes
    incidents older than the lookback, answers what rules and remembered answers
    cover, asks about the rest, and parks at the submit gate with everything about
    to go out. `changes` (optional) are corrections in start_quote's quote shape —
    e.g. {"drivers": [{"firstName": "Abigail", "lastName": "Brown", "dateOfBirth":
    "09/27/2008", "driversLicenseStatus": "Permit", "relationship": "Child"}]} adds
    a driver; {"vehicles": [{"vin": "...", "remove": true}]} removes one; a driver
    or vehicle named but absent is added. Later corrections: amend_job."""
    _check_account_id(account_id)
    # EZLynx's saved application is the truth. Nothing from an earlier run rides
    # along — a stored RCE, prior carrier or credit consent would be retyped over
    # what EZLynx holds now without the brief ever showing it.
    facts = _amend_facts({}, changes or {})
    lobs = _lobs(lines) if lines else []  # empty: the run reads them from EZLynx
    effective = None
    if effective_date is not None:
        effective = _date(effective_date)
        if effective is None or effective <= date.today():
            raise ToolError("effective_date must be a future date like 11/14/2026.")
    job = _start("requote", facts, lobs, account_id, effective)
    return {"started": True, "jobId": job.id, "lines": ",".join(lobs) or "read from the account",
            "next": "job_status(job_id, wait_seconds=60); relay each question to the associate."}


@mcp.tool(annotations={"readOnlyHint": True})
async def job_status(ctx: Context, job_id: str | None = None, wait_seconds: float = 0) -> dict[str, Any]:
    """A job's state, current screen, the question it is waiting on (relay it to
    the associate verbatim), the submit summary at the gate, and the result.
    `wait_seconds` (<=110) long-polls until the job needs a person or finishes.
    Without job_id: every job of this user."""
    if job_id is None:
        return {"jobs": [j.view(events=3) for j in _jobs.values() if j.user == USER.get()]}
    job = _job(job_id)
    if wait_seconds > 0:
        await _wait(job, wait_seconds)
        await ctx.report_progress(progress=len(job.events), message=job.step or job.state)
    return job.view()


@mcp.tool
async def answer_question(job_id: str, question_id: str, answer: str, remember: bool = False) -> dict[str, Any]:
    """Resume a parked job with the associate's answer (see the question's
    `answerWith`). `remember` makes a carrier-question answer the AGENCY's
    default — every associate's later runs apply it without asking — so use it
    only for answers that hold for every client ("AAA vehicle safety: No"), never
    a client's own facts. The submit gate is not answered here: approve_submit."""
    job = _job(job_id)
    question = job.pending
    if question is None or question.id != question_id:
        raise ToolError(f"Job {job_id} is not waiting on {question_id}; job_status shows what it is waiting on.")
    if question.kind == "submit_approval":
        raise ToolError("Submission is released only by approve_submit with the approving person's name.")
    if remember:
        selector = question.context.get("selector") or ""
        lowered = _norm(answer)
        if not _rememberable(selector):
            raise ToolError("Only carrier-question answers can be remembered. Answer again with remember=false.")
        if lowered in ("skip", "done") or lowered == "drop" or lowered.startswith("drop "):
            raise ToolError("Only a real value can be remembered, not 'skip'/'done'/'drop'. Answer again with remember=false.")
        _learn(selector, answer, True, job.user)
        job.memo.pop("learned", None)
        job.note(f"{_answer_key(selector)} = {_mask(selector, answer)} is now the agency's answer for every associate")
    _release(job, question, answer)
    await _wait(job, 3)
    return job.view(events=5)


@mcp.tool(annotations={"destructiveHint": True, "openWorldHint": True})
async def approve_submit(job_id: str, approved_by: str, approve: bool = True) -> dict[str, Any]:
    """Release (or stop) a job parked at the submit gate. This is the real
    carrier submission — it can pull credit and underwriting reports.
    `approved_by` is the name of the person who reviewed submitSummary and said
    yes; never fill it in yourself. approve=false stops the job with everything
    saved and nothing submitted. Deployments that approve from their own UI turn
    this off (EZLYNX_MODEL_APPROVAL=0); declining still works."""
    if approve and not MODEL_APPROVAL:
        raise ToolError("Submission is approved in the Savvy app, not here. Ask the associate to approve the "
                        "submit card; you can still stop the job with approve=false.")
    job = _job(job_id)
    approve_job(job, approved_by, approve, "approve_submit")
    await _wait(job, 3)
    return job.view(events=5)


def approve_job(job: Job, approved_by: str, approve: bool, via: str) -> None:
    """Release or stop a job parked at the submit gate. The backend's own approval
    endpoint (an authenticated person clicking the submit card) calls this directly:
    job = mcp_server2._jobs[job_id]; check job.user; approve_job(job, name, True, "ui")."""
    question = job.pending
    if question is None or question.kind != "submit_approval":
        raise ToolError(f"Job {job.id} is not at the submit gate (state {job.state}).")
    name = (approved_by or "").strip()
    if approve and not name:
        raise ToolError("approved_by is required: the person who approved this submission.")
    job.approved_by, job.approved_via = (name if approve else None), via
    job.note(f"gate {'approved' if approve else 'declined'} by {name or '(no name)'} via {via}")
    _release(job, question, "approve" if approve else "decline")


@mcp.tool(annotations={"readOnlyHint": True})
async def read_screen(job_id: str) -> dict[str, Any]:
    """The live EZLynx screen of a parked job: every visible field (selector,
    label, value, error) and the validation messages — so the associate can see
    what the question is about. SSNs and licence numbers are masked."""
    job = _job(job_id)
    if job.state != "waiting_human":
        raise ToolError(f"read_screen works while the job waits on a question (it is {job.state}).")
    scan = await job.browser.evaluate(job.tab, JS_SCAN_FULL)
    return {"step": job.step, "path": scan["path"], "errors": [_mask_control(e) for e in scan["errors"]],
            "controls": [_mask_control(c) for c in scan["controls"]], "headers": scan["headers"]}


@mcp.tool
async def set_fields(job_id: str, fields: dict[str, Any]) -> dict[str, Any]:
    """Change fields on a parked job's live screen, as the associate directs.
    Keys are selectors from read_screen ("#bodily-injury") or exact labels
    ("Bodily Injury"). Then answer the question ('done') to resume."""
    job = _job(job_id)
    if job.state != "waiting_human":
        raise ToolError(f"set_fields works while the job waits on a question (it is {job.state}).")
    b, tab = job.browser, job.tab
    controls = None
    results = {}
    for key, value in fields.items():
        selector = key
        if not key.startswith(("#", "[")):
            controls = controls or (await b.evaluate(tab, JS_SCAN_FULL))["controls"]
            hits = [c for c in controls if _norm(c["label"]) == _norm(key)]
            if len(hits) != 1:
                results[key] = {"error": f"{len(hits)} fields are labelled {key!r}; use a selector from read_screen."}
                continue
            selector = hits[0]["selector"]
        try:
            result = await set_field(b, tab, selector, value)
        except FieldError as err:
            results[key] = {"error": str(err), "options": err.options}
            continue
        if result.get("applied"):
            _log_change(job, result, "human (set_fields)")
        results[key] = {**result, "from": _mask(result["selector"], result.get("from")),
                        "value": _mask(result["selector"], result.get("value"))}
    return {"results": results}


AMEND_LOBS = {"drivers": {"auto"}, "vehicles": {"auto"}, "priorAuto": {"auto"}, "autoCoverage": {"auto"},
              "driverVehicleAssignment": {"auto"}, "newPolicyTerm": {"auto"}, "priorHome": {"home"}, "household": {"home"},
              # the RCE is typed on the auto carrier questions too (#coveragehome_mn__105, recs 0-7)
              "dwelling": {"auto", "home"}, "homeCoverage": {"auto", "home"}}


@mcp.tool
async def amend_job(job_id: str, changes: dict[str, Any] | None = None, effective_date: str | None = None) -> dict[str, Any]:
    """Correct a running job with what the associate just said — any time before
    submission, parked or not: "also add Abigail, permit", "the Golf is gone",
    "comp and collision off the Accord", "effective 11/22". `changes` has
    start_quote's quote shape; a driver/vehicle row updates the one it names
    (name / VIN) or is added, {"remove": true} removes it; unmodelled screens go
    in {"fields": {"auto/coverage": {"#selector": value}}}. Screens the job
    already passed are gone through again before the submit gate."""
    job = _job(job_id)
    if job.state in FINISHED or job.state == "submitting" or "submittedAt" in job.memo:
        raise ToolError(f"Job {job_id} is {job.state}{' and already submitted' if 'submittedAt' in job.memo else ''}; "
                        "start a new requote for further changes.")
    changes = changes or {}
    if blocked := [k for k in changes if k in ("applicant", "address", "producer", "csr")]:
        raise ToolError(f"{', '.join(blocked)} are set on the applicant screen at the start of a run; cancel_job and start again with them.")
    affected: set[str] = set()
    for key, value in changes.items():
        if key in ("carriers", "quoteTemplates", "fields") and isinstance(value, dict):
            affected |= {k.split("/")[0] for k in value}
        else:
            affected |= AMEND_LOBS.get(key, {"auto", "home"})
    day = None
    if effective_date is not None:
        day = _date(effective_date)
        if day is None or day <= date.today():
            raise ToolError("effective_date must be a future date like 11/22/2026.")
    if changes:
        job.facts = _amend_facts(job.facts, changes)
        job.memo.setdefault("amendments", []).append(changes)  # the brief re-applies them over its proposals
    if day is not None:
        job.requested_effective = day
        job.memo["effectiveAmended"] = True
        job.effective = {lob: day for lob in job.lobs}
        job.memo["effectiveFrom"] = {lob: "the associate (amend_job)" for lob in job.lobs}
        affected |= set(job.lobs) or {"auto", "home"}
    passed = affected & job.memo.get("walked", set())
    job.memo.setdefault("rewalk", set()).update(passed)
    gate = job.pending if job.pending and job.pending.kind == "submit_approval" else None
    if gate is not None and passed:
        job.note("the submit gate was withdrawn for the correction; it comes back with a fresh summary")
        _release(job, gate, "rewalk")
    job.note(f"amended: {', '.join(sorted(changes)) or ''}{' effective ' + effective_date if effective_date else ''}"
             + (f" — will go through {', '.join(sorted(passed))} again before submitting" if passed else ""))
    return {**job.view(events=3), "amended": sorted(changes) + (["effectiveDate"] if effective_date else []),
            "revisits": sorted(passed)}


@mcp.tool(annotations={"openWorldHint": True})
async def drive_job(ctx: Context, job_id: str) -> dict[str, Any]:
    """Stay with a job to the end, putting each question — and the submit
    approval — straight to the person at the MCP client (elicitation). Returns
    early, with the pending question, when the client cannot ask, the person
    declines to answer now, or after 8 questions (call again to continue)."""
    job = _job(job_id)
    returned, reply, state = _returned_answer(ctx, "answer")
    if returned:  # a 2026-07-28 client came back with the reply to what we returned
        question = job.pending
        if question is None or question.id != state.get("question") or not _operator_answer(job, question, reply):
            return job.view()  # dismissed, left empty, or answered elsewhere meanwhile
    legs = state.get("legs", 0)
    while job.state not in FINISHED:
        await _wait(job, 60)
        await ctx.report_progress(progress=len(job.events), message=job.step or job.state)
        question = job.pending
        if question is None:
            continue
        if legs >= 8:  # clients cap the rounds of one call
            return job.view()
        asked = await _ask_operator(ctx, "answer", _operator_prompt(job, question),
                                    {"question": question.id, "legs": legs + 1}, question.kind == "submit_approval")
        if isinstance(asked, InputRequiredResult):
            return asked
        if job.pending is not question or not _operator_answer(job, question, asked):
            return job.view()  # relay the question in chat instead
        legs += 1
    return job.view()


def _operator_prompt(job: Job, question: Question) -> str:
    lines = [question.prompt]
    if question.kind == "submit_approval":
        lines.append(_gate_text(job.submit_summary or {}))
        lines.append("Tick 'Submit to the carriers now?' and give your name to submit; leave it unticked to stop "
                     "without submitting. Dismiss to decide later.")
    else:
        if question.options:
            lines.append("Options: " + " | ".join(question.options[:40]))
        if question.suggestion:
            lines.append(f"Suggested: {question.suggestion}")
        lines.append(f"Answer with {ANSWER_HELP.get(question.kind, 'a value')}.")
    return "\n".join(lines)


def _gate_text(summary: dict[str, Any]) -> str:
    """The submit summary as a person reads it: who, when, which carriers, what changed."""
    out = [summary.get("warning") or "",
           f"Account {summary.get('accountId')} — {summary.get('applicant') or ''} — {', '.join(summary.get('lines') or [])}",
           f"Effective: {summary.get('effectiveDates')} (from {summary.get('effectiveDatesFrom')})",
           f"Credit authorization: {summary.get('creditAuthorization')}"]
    carriers = summary.get("carriers")
    if isinstance(carriers, list):
        out.append("Carriers: " + "; ".join(f"{row.get('carrier')} ({', '.join(x['lob'] for x in row.get('lobs') or [] if x.get('on'))})"
                                           for row in carriers))
    elif carriers:
        out.append(f"Carriers: {str(carriers)[:800]}")
    if summary.get("droppedCarriers"):
        out.append("Dropped: " + "; ".join(f"{d['carrier']} ({d['lob']}): {d['reason']}" for d in summary["droppedCarriers"]))
    if summary.get("brief"):
        out.append("Accepted from the brief: " + "; ".join(summary["brief"].get("accepted") or []) or "none")
    if summary.get("aboutToSubmit"):
        out.append("About to submit: " + "; ".join(f"{k}: {v}" for k, v in summary["aboutToSubmit"].items()))
    if summary.get("problems"):
        out.append("Problems: " + "; ".join(summary["problems"]))
    out.append(f"{len(summary.get('changes') or [])} field changes this run (all in job_status).")
    text = "\n".join(x for x in out if x)
    return text if len(text) <= 6000 else text[:6000] + "\n… (the rest is in job_status)"


def _operator_answer(job: Job, question: Question, reply: dict[str, Any] | None) -> bool:
    """Apply what the person entered in the client's own prompt. At the gate only
    a ticked box with a name submits; unticked stops. False when nothing usable
    came back (dismissed, or an empty answer to a question)."""
    if reply is None:
        return False
    if question.kind == "submit_approval":
        name = str(reply.get("approved_by") or "").strip()
        if reply.get("approve") is True and not name:
            return False  # ticked without a name: the gate stays open
        approve_job(job, name, reply.get("approve") is True, "elicitation")
        return True
    text = str(reply.get("value") or "").strip()
    if not text:
        return False
    _release(job, question, text)
    return True


@mcp.tool
async def cancel_job(job_id: str) -> dict[str, Any]:
    """Stop a job. EZLynx keeps every screen it saved; a later run on the same
    account picks up from there."""
    job = _job(job_id)
    if job.state in FINISHED:
        return {"jobId": job.id, "state": job.state}
    job.task.cancel()
    with suppress(asyncio.CancelledError, Exception):
        await asyncio.wait_for(asyncio.shield(job.task), timeout=10)
    return job.view(events=3)


# ================================================================ tools: results

@mcp.tool(annotations={"readOnlyHint": True})
async def get_report(account_id: str) -> dict[str, Any]:
    """The account's last carrier comparison — premiums low to high, annualised,
    per line; carrier errors classified (decline, access, redirect, fixable,
    transient); dropped carriers with reasons. No browser."""
    _check_account_id(account_id)
    report = store.read_quote(USER.get(), _report_key(account_id))
    if report is None:
        raise ToolError(f"No report for account {account_id} yet.")
    return report


@mcp.tool(annotations={"openWorldHint": True})
async def refresh_results(account_id: str) -> dict[str, Any]:
    """Re-read the account's last results page — carriers that were still rating,
    or quoted after their follow-up questions. Updates get_report."""
    _check_account_id(account_id)
    user = USER.get()
    last = store.read_quote(user, _report_key(account_id))
    url = (last or {}).get("resultsUrl") or ""
    if not url.startswith(f"{EZLYNX_BASE_URL}/web/account/{account_id}/rating/quote-results/"):
        raise ToolError(f"No results page is known for account {account_id}. Submit first.")

    async def read(b: Browser, tab: str) -> dict[str, Any]:
        quote_cards, error_cards, _ = await _read_results(b, tab)
        report = build_report(account_id, url, quote_cards, error_cards,
                              last.get("droppedCarriers") or [], last.get("lines") or ["auto", "home"])
        store.save_quote(user, _report_key(account_id), report)
        return _summary(report)
    return await _with_tab(url, read)


# ================================================================ resources

@mcp.resource("ezlynx://jobs/{job_id}", mime_type="application/json")
async def job_resource(job_id: str) -> dict[str, Any]:
    """A job with its full event log."""
    job = _jobs.get(job_id)
    if job is None or job.user != USER.get():
        raise ResourceError(f"No job {job_id}.")
    return job.view(events=400)


@mcp.resource("ezlynx://reports/{account_id}", mime_type="application/json")
async def report_resource(account_id: str) -> dict[str, Any]:
    """The account's last carrier comparison."""
    report = store.read_quote(USER.get(), _report_key(account_id)) if ACCOUNT_ID.fullmatch(account_id) else None
    if report is None:
        raise ResourceError(f"No report for account {account_id}.")
    return report


# ================================================================ selftest

def _selftest() -> None:
    options = ["--Select--", "No Coverage", "No", "Yes", "100/300", "250/500", "500/500", "500 CSL -or- 500/500/500"]
    assert options[match_option("No", options)] == "No"
    assert options[match_option(True, options)] == "Yes"
    assert options[match_option("500 CSL", options)] == "500 CSL -or- 500/500/500"
    assert match_option("maybe", options) is None
    assert ["$1,000", "$5,000"][match_option("5000", ["$1,000", "$5,000"])] == "$5,000"
    assert ["HO3 - Dwelling", "HO5"][match_option("HO3", ["HO3 - Dwelling", "HO5"])] == "HO3 - Dwelling"
    # A different number is a question, never a silent pick.
    assert match_option("1", ["0", "10", "20"]) is None and match_option("$50", ["$0", "$100", "$500"]) is None
    assert match_option("2 Stories", ["1 Story", "1.5 Stories", "2 Story", "3 Stories"]) in (None, 2)
    assert match_option("100/300", ["100/300/100", "250/500/100"]) == 0
    assert _same("$953,000", 953000) and _same("11-14-2026", "11/14/2026") and not _same("No", "No Coverage")

    today = date(2026, 9, 22)
    assert _suggest_effective("11/14/2023", "11/14/2023", today) == date(2026, 11, 14)  # rec 5
    assert _suggest_effective("05/30/2024", "10/21/2024", today) == date(2026, 10, 21)  # rec 4
    assert _suggest_effective("11/12/2025", "10/15/2026", today) == date(2026, 10, 15)  # still running: renews then

    card = {"text": "National partner Local deal $6,077 directions_car $1,432 home $7,509 / 12 mo keyboard_arrow_down", "icons": ["directions_car", "home"]}
    assert parse_card(card)["components"] == {"auto": 6077.0, "home": 1432.0} and parse_card(card)["premium"] == 7509.0
    listed = parse_card({"text": "Local deal Alt Quote Dynamic Drive Premium View more details Go to carrier open_in_new $2,117.00 6 mo (Total Premium) keyboard_arrow_down"})
    assert listed["premium"] == 2117.0 and listed["annualPremium"] == 4234.0 and listed["altQuote"] == "Dynamic Drive Premium"
    declined = parse_card({"text": "Local deal Carrier Error: Based on underwriting guidelines, Acuity is not a market for the risk being quoted. Report error"})
    assert declined["errorClass"] == "decline" and "Acuity" in declined["error"]
    assert parse_card({"text": "Local deal Carrier Error : You do not have access to perform comparative rater quotes at this time. Please access InsuranceLink to submit this application. Report error"})["errorClass"] == "access"
    asks = parse_card({"text": "Progressive Insurance needs more information. Answer questions keyboard_arrow_down", "answerId": "answer-questions-25-Auto"})
    assert asks["needsAnswers"] and asks["lob"] == "auto"
    assert parse_card({"text": "National partner Local deal", "icons": []}).get("pending")
    promo = parse_card({"text": "National partner directions_car You could earn up to $1,000 for selling this policy. View more details Go to carrier open_in_new $2,733.00 12 mo (Paid-In-Full) keyboard_arrow_down", "icons": ["directions_car"]})
    assert promo["premium"] == 2733.0 and promo["lob"] == "auto"
    split = parse_card({"text": "$1,172 directions_car $2,152 home $3,324 / 12 mo", "graphIds": ["graph-692-auto", "graph-692-home"]})
    assert split["lob"] == "package" and split["carrierId"] == "692" and split["components"]["home"] == 2152.0
    one = build_report("1", None, [{"text": "View more details $371.50 6 mo (Paid-In-Full)"}], [], [], ["auto"])
    assert one["quotes"][0]["lob"] == "auto" and one["quotes"][0]["annualPremium"] == 743.0

    facts = {
        "effectiveDate": "11/14/2026", "creditAuthorization": {"authorized": True},
        "priorAuto": {"carrier": "Progressive", "liabilityLimits": "500CSL"},
        "drivers": [{"firstName": "Brian", "driversLicenseNumber": "E000143514100"}, {"firstName": "Trevor", "excluded": True}],
        "vehicles": [{"vin": "2GNAXUEV8K6221875", "use": "To/From Work", "oneWayMiles": 8, "annualMiles": 8840}],
        "dwelling": {"estimatedReplacementCost": 404000, "squareFeet": 1649},
        "carrierAnswers": {"#app_occupation__650": "No"},
        "fields": {"auto/coverage": {"#vehicle-0-extTransExpense": "No Coverage"}},
    }
    policy = dict(plan_fields(facts, "auto", "policy-info"))
    assert policy["#priorCarrier"] == "Progressive" and policy["#priorLiabilityLimits"] == "500CSL"
    assert policy["#creditCheckAuthorized"] == "Yes"
    drivers = dict(plan_fields(facts, "auto", "drivers-compact", {"drivers": {0: 0, 1: 2}}))
    assert drivers["#textD1DLNumber"] == "E000143514100" and drivers["#driver-2-ratedDriver"] == "Excluded"
    vehicles = dict(plan_fields(facts, "auto", "vehicles-compact", {"vehicles": {0: 1}}))
    assert "#selected-year-1" not in vehicles and vehicles["#selected-use-1"] == "To/From Work"
    home = dict(plan_fields(facts, "home", "coverage"))
    assert home["#dwelling"] == 404000 and home["#estReplacementCost"] == 404000
    assert dict(plan_fields(facts, "auto", "coverage"))["#vehicle-0-extTransExpense"] == "No Coverage"
    assert dict(plan_fields(facts, "auto", "carrier-questions"))["#app_occupation__650"] == "No"

    old = {"dwelling": {"estimatedReplacementCost": 500000}, "carrierAnswers": {"#coveragehome_mn__105": "500000", "#x": "y"}}
    new = _fan_out_rce(old, _deep_merge(old, {"dwelling": {"estimatedReplacementCost": 903500}}))
    assert new["homeCoverage"]["dwelling"] == 903500 and new["carrierAnswers"]["#coveragehome_mn__105"] == "903500"
    assert _deep_merge({"a": {"b": 1, "c": 2}}, {"a": {"c": None}}) == {"a": {"b": 1}}

    job = Job("t", "u", "requote", ["auto", "home"], facts, "1", None)
    job.effective["auto"] = date(2026, 11, 14)
    assert _derived_answer("#membershipsince_aaa__613", job, "auto") is None  # the client's own year: asked
    assert _derived_answer("#marketvalue_autoownersxml__105", job, "home") == 404000
    assert _derived_answer("#multipolicyhome_autoowners__105", job, "home") == "Yes"

    rows = [{"i": 0, "first": "BRIAN", "last": "MILLER", "dob": "06/27/1963"}, {"i": 1, "first": "ANGELA", "last": "MILLER", "dob": ""}]
    assert _match_rows([{"firstName": "Angela", "lastName": "Miller"}], rows, _same_driver) == {0: 1}
    assert _match_rows([{"vin": "X"}, {"vin": "Y", "replaces": "OLD"}], [{"i": 0, "vin": "OLD"}, {"i": 1, "vin": "X"}], _same_vehicle) == {0: 1, 1: 0}
    # A new driver is never typed over a different person; a blank row is fair game.
    people = [{"i": 0, "first": "Ann", "last": "Lee", "dob": ""}, {"i": 1, "first": "Bob", "last": "Stranger", "dob": ""}]
    assert _match_rows([{"firstName": "Ann", "lastName": "Lee"}, {"firstName": "Jane", "lastName": "Lee"}], people, _same_driver) == {0: 0}
    assert _match_rows([{"vin": "NEW"}], [{"i": 0, "vin": "", "year": "", "make": "", "model": ""}], _same_vehicle) == {0: 0}
    assert _match_rows([{"vin": "NEW"}], [{"i": 0, "vin": "", "year": "2019", "make": "HONDA"}], _same_vehicle) == {}  # a car, not a blank row
    # A vehicle named by year/make/model lands on that car, never on "the first row".
    cars = [{"i": 0, "vin": "A1", "year": "2018", "make": "HONDA", "model": "ACCORD LX"}, {"i": 1, "vin": "B2", "year": "2013", "make": "FORD", "model": "EDGE SEL"}]
    assert _match_rows([{"year": "2013", "make": "Ford", "model": "Edge", "annualMiles": 5000}], cars, _same_vehicle) == {0: 1}
    assert _match_rows([{"year": "2020", "make": "Honda", "model": "Civic"}], cars, _same_vehicle) == {}
    assert "1984" not in _row_label({"i": 0, "first": "PATRICK", "last": "CAIN", "dob": "06/06/1984"})
    grid = dict(plan_fields({"vehicles": [{}, {}], "driverVehicleAssignment": [[100, 0], [0, 100]]}, "auto", "vehicles-compact",
                            {"vehicles": {0: 0, 1: 1}, "drivers": {0: 0, 1: 1}}))
    assert grid == {"#vehicle-assignment-1-0": 100, "#vehicle-assignment-1-1": 0, "#vehicle-assignment-2-0": 0, "#vehicle-assignment-2-1": 100}

    missing = _missing({"applicant": {"firstName": "Jose"}}, ["auto", "home"], True)
    assert "applicant.lastName" in missing and not _missing({}, ["auto", "home"], False)  # an existing account needs nothing
    day = date(2026, 9, 23)
    assert _task_dates("Home Renews 11 14 26 Roof age 2007", day) == {"home": date(2026, 11, 14)}
    assert _task_dates("renewal 10/21/2026 auto", day) == {None: date(2026, 10, 21)}
    assert _task_dates("Renews 11 14 24", day) == {}  # past: not a renewal to quote for
    dupont = _parse_task("Richard Dupont - AAA 11 16 26 By Lea Lindhe Sep 22, 2026 0/2 completed", day)
    assert dupont["client"] == "Richard Dupont" and dupont["carrier"] == "AAA" and dupont["dates"] == {None: date(2026, 11, 16)}
    wincek = _parse_task("Danielle Wincek - Renews 11 23 26 Roof age 2018 Goes to Lisa By Lea Lindhe Sep 23, 2026 0/2 completed", day)
    assert wincek["handOffTo"] == "Lisa" and wincek["roofYear"] == "2018" and wincek["carrier"] is None
    assert _parse_task("Brandon Detweiler - Renews 11 24 26 Roof age 2023 Goes To Tina By Lea Lindhe Sep 23, 2026", day)["handOffTo"] == "Tina"
    assert _name_match("Richard Dupont", "RICHARD", "DUPONT") == 2 and _name_match("Mark Johnson", "Susan", "Johnson") == 1
    assert _name_match("Danielle Wincek", "RICHARD", "DUPONT") == 0
    # One date for the bundle, the earliest the evidence gives, capped at 60 days (recs 0-2: 9/23 -> 11/22).
    assert _bundle_effective([(date(2026, 11, 24), "task")], day, 60)[0] == date(2026, 11, 22)
    assert _bundle_effective([(date(2026, 11, 16), "task"), (date(2027, 5, 16), "auto")], day, 60) == (date(2026, 11, 16), "task")
    assert _bundle_effective([(date(2025, 5, 16), "stale")], day, 60) is None
    pol = _parse_policy("Active Homeowners | 5625714602 Auto-Owners Insurance Company assignment")
    assert pol == {"status": "Active", "type": "Homeowners", "lob": "home", "number": "5625714602", "carrier": "Auto-Owners Insurance Company"}
    assert _parse_policy("Pending Personal Auto | AUT702574018 AAA – Auto Club Group assignment")["carrier"] == "AAA – Auto Club Group"
    assert _carrier_short("Auto-Owners Insurance Company") == "Auto-Owners" and _carrier_short("AAA – Auto Club Group – Insurance Link") == "AAA"
    assert _carrier_key("The Hartford") == "hartford" and _carrier_key("Liberty Mutual (Formerly Safeco)") == "liberty mutual"
    assert _limit_key("500 CSL -or- 500/500/500") == "500CSL" and _limit_key("250/500/100") == "250/500" and _limit_key("No Coverage") is None
    assert _parse_term("11/24/2026 - RWL - $4052.55") == {"date": date(2026, 11, 24), "type": "RWL", "premium": 4052.55}
    assert VIN_TOKEN.findall("2019 HONDA ACCORD LX VIN: 1HGCV1F13JA057651 POLICYHOLDERNAMES") == ["1HGCV1F13JA057651"]
    ids = ["P1", "P2", "P3"]
    assert _parse_brief("ok", ids)["ok"] and _parse_brief("OK except P2 and p3", ids)["reject"] == {"P2", "P3"}
    assert _parse_brief("only P1", ids)["only"] == {"P1"} and _parse_brief("stop", ids)["stop"]
    both = _parse_brief("ok, effective 11/22/2026 and rce $424,000", ids)
    assert both["ok"] and both["effective"] == date(2026, 11, 22) and both["rce"] == 424000
    assert _parse_brief("effective 11/22/26", ids)["effective"] == date(2026, 11, 22)
    assert _parse_brief("lines auto", ids)["lines"] == ["auto"]
    loose = _parse_brief("ok but add Abigail as a permit driver", ids)
    assert not loose["ok"] and "Abigail" in loose["leftover"]  # never dropped silently
    # A P-id with no 'except'/'only' is a question back, never a guess (it used to decline what was approved).
    assert not _parse_brief("yes P1 and P3", ids)["ok"] and not _parse_brief("P2", ids)["ok"]
    five = ["P1", "P2", "P3", "P4", "P5"]
    assert _parse_brief("ok except 2 and 5", five)["reject"] == {"P2", "P5"} and _parse_brief("ok except 2 and 5", five)["ok"]
    assert not _parse_brief("ok except P9", five)["ok"]  # no such proposal
    assert _parse_brief("ok effective 11/22", ids, date(2026, 9, 24))["effective"] == date(2026, 11, 22)
    assert not _parse_brief("ok effective Nov 22", ids)["ok"]  # a date it cannot read is never dropped
    edit = _parse_brief("rce 424000", ids)
    assert not edit["ok"] and edit["edits"] and edit["rce"] == 424000  # an edit alone shows the brief again
    assert all(_parse_brief(x, ids)["ok"] for x in ("ok go ahead", "looks good, proceed", "yes please go ahead", "OK"))
    assert _money("$706,900.00") == 706900 and _money("424k") == 424000 and _money("1.2m") == 1200000
    assert _name_match("Christine Sontag", "Christopher", "Sontag") == 1 and _name_match("Danielle Smith", "Daniel", "Smith") == 1
    assert _name_match("Anthony Hartinger", "Tony", "Hartinger") == 2
    twin = {"firstName": "Ella", "lastName": "Smith", "dateOfBirth": "01/02/2008"}
    assert not _same_driver(twin, {"first": "EMMA", "last": "SMITH", "dob": "01/02/2008"})
    assert not _same_driver({"firstName": "Richard", "lastName": "Dupont", "dateOfBirth": "02/02/1990"},
                            {"first": "RICHARD", "last": "DUPONT", "dob": "03/04/1961"})  # Jr is not Sr
    golf = {"i": 1, "vin": "3VWDX7AJ5BM000111", "year": "2011", "make": "VOLKSWAGEN", "model": "GOLF"}
    assert _same_vehicle({"make": "VW", "model": "Golf", "remove": True}, golf)
    assert _same_vehicle({"vin": "NEW12345678901234", "replaces": "OLD"}, {"i": 0, "vin": "NEW12345678901234"})  # no second add
    hondas = [{"i": 0, "vin": "A", "year": "2019", "make": "HONDA", "model": "ACCORD"}, {"i": 1, "vin": "B", "year": "2020", "make": "HONDA", "model": "ACCORD"}]
    assert _match_rows([{"model": "Accord", "collisionDeductible": "No Coverage"}], hondas, _same_vehicle) == {}  # which Accord? ask
    assert not _addable("vehicle", {"model": "Accord"}) and _addable("driver", {"firstName": "A", "lastName": "B"})
    page = "Named Insured\nRICHARD DUPONT\nDrivers\nRICHARD DUPONT\nJOYCE DUPONT\nVehicles\n2019 HONDA ACCORD"
    section = _drivers_section(page)
    assert "JOYCE" in section and "HONDA" not in section and _drivers_section("Named Insured\nRICHARD DUPONT") is None
    assert _named_in({"first": "Richard", "last": "Dupont Jr."}, "RICHARD DUPONT JR") and not _named_in({"first": "Trevor", "last": "Dupont"}, section)
    scrubbed = _scrub("JOYCE DOB: 05/12/1963 DL D123456789012 joyce@example.com SSN 123456789")
    assert "1963" in scrubbed and "05/12" not in scrubbed and "…9012" in scrubbed and "j…@example.com" in scrubbed and "123456789" not in scrubbed
    assert _check_agency(AGENCY_SEED) == []
    bad = _check_agency({**AGENCY_SEED, "maxDaysAhead": "60 days", "carriers": {"auto": "GEICO"},
                         "fields": {"auto/policy-info": {"#creditCheckAuthorized": "Yes"}}})
    assert len(bad) == 3
    assert _task_dates("Call back 10 01 26 renews 11 16 26", day) == {None: date(2026, 11, 16)}
    assert _parse_task("Kim Lee - client openly shopping 11 16 26 By Lea Lindhe", day)["carrier"] is None
    assert _parse_task("Kim Lee - Progressive to AAA 11 16 26 By Lea Lindhe", day)["carrier"] == "Progressive"
    assert _answer_key("#aaasafetymichigan2") == "#aaasafetymichigan{n}" and _answer_key('[id="coveragehome_mn__105"]') == "#coveragehome_mn__105"
    assert _rememberable("#aaasafetymichigan1") and _rememberable("#app_occupation__650") and not _rememberable("#dwelling")
    assert not _rememberable("#annual-miles-0") and not _rememberable("#priorCarrier")
    amended = _amend_facts({"drivers": [{"firstName": "Sophia", "lastName": "Brown"}]},
                           {"drivers": [{"firstName": "Abigail", "lastName": "Brown"}, {"firstName": "Sophia", "lastName": "Brown", "driversLicenseNumber": "X"}]})
    assert [d["firstName"] for d in amended["drivers"]] == ["Sophia", "Abigail"] and amended["drivers"][0]["driversLicenseNumber"] == "X"
    diff = _text_changes("Drivers\nRICHARD DUPONT\nTREVOR DUPONT", "Drivers\nRICHARD DUPONT\n2020 HONDA CIVIC")
    assert diff == {"added": ["2020 HONDA CIVIC"], "removed": ["TREVOR DUPONT"]}
    assert _parse_lines("auto,home") == ["auto", "home"] and _parse_lines("just the home") == ["home"] and _parse_lines("both") == ["auto", "home"]
    assert any("RCE" in m for m in missing) and any("vehicles" in m for m in missing)
    assert _redact({"carrierAnswers": {"#q__12": "123-45-6789"}, "ssn": "x"}) == {"carrierAnswers": {"#q__12": "•••"}, "ssn": "•••"}
    assert _mask_control({"label": "SSN", "value": "471-40-4614"})["value"] == "•••"
    assert _mask("#textD3DLNumber", "E000143514100") == "…4100" and _mask('[id="driver-0-dob"]', "06/06/1984") == "xx/xx/1984"
    assert _mask("#applicant-date-of-birth", " 10/16/1978") == "xx/xx/1978" and _mask("#bodily-injury", "500/500") == "500/500"
    assert _lobs("home, auto") == ["auto", "home"]
    assert json.loads(JS_SCAN_FULL[JS_SCAN_FULL.rindex("})(") + 3:-1]) == {"full": True}
    print("selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        _selftest()
    elif "--http" in sys.argv:
        mcp.run(transport="http", host="127.0.0.1", port=int(os.environ.get("MCP_PORT", 8765)))
    else:
        mcp.run()
