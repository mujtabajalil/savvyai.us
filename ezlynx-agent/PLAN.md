# EZLynx Auto + Home Quoting Agent — Implementation Plan

**Status: awaiting approval. No implementation code has been written.**

This plan covers module layout, the Angular Material dropdown strategy, the step-by-step
flow, and open questions. Section 12 is the list I need answered before I start.

---

## 0. What I read

| Source | Outcome |
|---|---|
| `AGENTS.md` | Route/OpenAPI rules, plugin `ctx` API, 29-event bus, code-separation conventions |
| `CONTRIBUTING.md` | **"Do not use `dotenv` or load `.env` files"** — see Q3 |
| `README.md` | Architecture, security model, interactive desktop mode, persistence |
| `server.js` (7,177 ln) | All 44 routes, session/tab model, tab locking, error handling |
| `lib/config.js` | Every env var; `evaluateMaxBodySize`, `handlerTimeoutMs`, `interactiveMode` |
| `lib/select-option.js` | **The critical gap — see §2** |
| `lib/snapshot.js` | 80,000-char snapshot cap with windowed offsets |
| `plugins/persistence/` | `session:creating` → loads `storageState`; profiles at `~/.camofox/profiles/<sha256(userId)>/` |
| `plugins/vnc/` | Linux-only (`apt.txt`: x11vnc/novnc). **On Windows use `CAMOFOX_INTERACTIVE=desktop`** |
| `openapi.json`, `docs/` | Request/response shapes |

---

## 1. Blockers found before anything else

### 1.1 The recording is not in the repo

```
fixtures/private/ezlynx-recording.json   → does not exist
ezlynx-agent/                            → did not exist (created for this plan)
```

I only have the excerpt pasted into chat, which was truncated mid–`drivers-compact`. **I cannot
build the flow map or the selector map without the full file.** Please drop it at
`ezlynx-agent/fixtures/private/ezlynx-recording.json` (gitignored — see §10).

Everything below is designed from the excerpt plus your step table, which together are enough to
commit to an architecture, but not enough to generate `ezlynx.flow.json`.

### 1.2 Node version

You are on **Node v20.19.0**. This repo requires `>=22`, and `better-sqlite3@13.0.1` (a production
dependency) also requires `>=22`. The agent package will require `>=22` as well. Please install
Node 22 or 24 (CI uses 24) before we go further.

### 1.3 Windows: npm test scripts don't run

Covered in my earlier message — the repo's test scripts use POSIX `VAR=x cmd` syntax and fail under
cmd.exe. `ezlynx-agent` will ship **cross-platform npm scripts** (no inline env prefixes) so this
problem is not inherited.

---

## 2. Endpoint capability audit (task step 2)

### What exists and works for us

| Need | Endpoint | Verdict |
|---|---|---|
| Fill text/date inputs | `POST /tabs/:tabId/type` (`mode: fill\|keyboard`) | ✅ `fill()` dispatches proper `input`/`change`, which Angular forms need |
| Click | `POST /tabs/:tabId/click` (ref \| selector \| coordinates) | ✅ Real Playwright click with actionability checks |
| Run page JS | `POST /tabs/:tabId/evaluate` | ✅ Arbitrary expression, promise-aware, 1 MB body |
| Keyboard | `POST /tabs/:tabId/press` | ✅ For `Escape` to close overlays |
| Native `<select>` | `POST /tabs/:tabId/select` | ✅ **Only** for real `<select>` |
| Page-level readiness | `POST /tabs/:tabId/wait` | ⚠️ Partial — see gap 2 |
| Structured extraction | `POST /tabs/:tabId/extract` | ⚠️ Deterministic, but `x-ref`-based → requires a snapshot first |
| Session isolation / persistence | `userId` + persistence plugin | ✅ This is our login story |
| Screenshots, traces | `GET /screenshot`, `/sessions/:userId/traces` | ✅ Off by default, debug only |

### Gaps

**Gap 1 — `/select` cannot drive Angular Material dropdowns. (Critical)**

[`lib/select-option.js`](../lib/select-option.js) is:

```js
export async function selectOption(locator, option) {
  try { return await locator.selectOption({ label: option }); }
  catch (labelError) {
    try { return await locator.selectOption({ value: option }); }
    catch { throw labelError; }
  }
}
```

Playwright's `selectOption()` throws on anything that is not a native `<select>`. EZLynx is
`mat-select`, so **every dropdown in the flow — roughly 150–250 per Auto+Home quote — fails on this
endpoint.** `POST /type` doesn't help either: `assertLocatorFillable()` ([server.js:259](../server.js#L259))
rejects anything that isn't `input`/`textarea`/`contenteditable`/`role=textbox|searchbox` with a 422,
and `mat-select` is `role="combobox"`.

**Gap 2 — no element-level wait.** `POST /wait` only calls `waitForPageReady()`
([server.js:2065](../server.js#L2065)): `domcontentloaded` → `networkidle` → a hydration poll →
a fixed settle. There is no "wait for selector / wait until predicate". We need that for VIN decode,
make→model cascades, `use`→miles reveals, carrier-question sections, the `mat-option` panel, and
`mat-progress-bar` on results.

**Gap 3 — no bulk read of field values or validation state.** Nothing returns "current value of
these 40 selectors" or "all visible field errors". The a11y snapshot is lossy for `mat-select`
display values and is **capped at 80,000 chars** ([lib/snapshot.js:6](../lib/snapshot.js#L6)) —
the drivers, vehicles, and carrier-questions pages will exceed that.

### How I close all three with zero core changes

**All three collapse into `POST /evaluate` for *reading* and `POST /click` for *acting*.**

That split matters. I use `/evaluate` to read the DOM (option lists, current values, error text,
readiness predicates) and `/click` to actually interact, so Angular still receives real browser
input events with Playwright's actionability guarantees (visible, stable, enabled, hit-target)
rather than synthetic `el.click()` calls.

- Gap 1 → the dropdown driver in §4.
- Gap 2 → a `waitFor(predicate, timeoutMs)` client helper that ships an async poll loop inside a
  single `/evaluate`. Bounded by `HANDLER_TIMEOUT_MS` (default **30 s** — `requestTimeoutMs()` at
  [server.js:5422](../server.js#L5422)), so long waits (carrier rating can take minutes) are
  **chunked client-side**: repeated ≤25 s evaluates until the overall deadline.
- Gap 3 → a `scanStep()` evaluate that walks a step's container and returns a compact JSON of every
  control (selector, kind, value, disabled, required, error text, `Required for Carrier: X` markers).
  One round trip, no 80 KB cap, no snapshot needed.

**Recommendation: do not modify camofox core, and do not add a plugin in phase 1.** The cost is
~5 HTTP round-trips per dropdown. If that proves too slow or too racy in practice, phase 2 adds a
**generic** (not EZLynx-specific) plugin at `plugins/matselect/` exposing
`POST /tabs/:tabId/mat-select`, which performs open → await panel → read options → click → verify as
one atomic operation inside the server's existing `withTabLock`. I'd rather earn that decision with
a measurement than assume it. Trigger to revisit: >8 s median per dropdown, or any observed
interleaving failure.

---

## 3. Where the code lives

A standalone package at `ezlynx-agent/`, talking to camofox only over REST. **No changes to
`server.js` or `lib/`.**

```
ezlynx-agent/
  PLAN.md  README.md  .env.example  package.json  tsconfig.json  eslint.config.js
  src/
    cli.ts                      extract | run | results
    config.ts                   zod-validated env, fails fast at startup
    camofox/
      client.ts                 typed REST client (fetch, retries, access key, tab lifecycle)
      dom.ts                    evaluate-payload builders (scan / read / waitFor / verify)
      controls.ts               setField dispatcher by control kind
      waits.ts                  waitFor, waitForStable, waitForOptions, waitForNoProgress
    llm/
      deepseek.ts               OpenAI-compatible, JSON mode, timeout+backoff, schema check
      prompts/                  extract-rce · resolve-error · map-option
    domain/
      schema.ts                 zod QuoteRequest + sub-schemas
      defaults.ts               merge input JSON > extracted > defaults, with provenance
      normalize.ts              DL# · dates · currency · VIN · phone
    flow/
      ezlynx.flow.json          GENERATED, hand-reviewed, committed
      flow.schema.ts
      runner.ts                 step loop, recovery loop, attempt budget
      steps/                    applicant · auto-* (7) · home-* (7) · submit
    recovery/
      rules.ts                  deterministic fixes first
      recover.ts                rules → DeepSeek → ask_human
    results/
      parse.ts  report.ts
    log/
      logger.ts  redact.ts
  config/
    defaults.json               agency defaults (§7)
    carriers.json               carrierId ↔ name/slug (613 AAA, 650 GEICO, 105 Auto-Owners, …)
  scripts/
    redact-recording.ts  build-flow-map.ts
  fixtures/
    private/                    GITIGNORED — real recording, real PII
    ezlynx-recording.redacted.json
    pages/                      static HTML for integration tests
  tests/
    unit/  integration/
  results/                      GITIGNORED — run output
  debug/                        GITIGNORED — screenshots/traces when explicitly enabled
```

TypeScript, ESM, `"type": "module"`, extending the repo's `tsconfig.json` conventions
(ES2022 / NodeNext). zod for every schema boundary.

---

## 4. Angular Material dropdowns — the core mechanism

`mat-select` renders its options into a **CDK overlay appended to `<body>`**, not inside the form
field. Setting `.value` does nothing; Angular's `ControlValueAccessor` owns the state.

### Per-dropdown algorithm

1. **Classify** (`/evaluate`): return `{kind, currentValue, disabled, controlId, panelId}` where
   `kind ∈ native-select | mat-select | mat-autocomplete | radio-group | checkbox | toggle`.
   Never assume from the flow map alone — EZLynx mixes native `<select>` (applicant portal) with
   `mat-select` (rater).
2. **Short-circuit**: if `currentValue` already equals the target → no-op, log as `already-set`.
3. **native-select** → existing `POST /select`. Free.
4. **mat-select**:
   - `POST /click` on the control → Angular opens the panel.
   - `POST /evaluate` → poll for `[role=listbox] mat-option` to exist and be non-empty; return
     `[{index, id, text, disabled}]`.
   - **Match** (below).
   - `POST /click` on `#<option.id>` — by **the option's own id**, never `nth-child`, because the
     250-entry Prior Carrier list may virtualize.
   - If virtualized and the target isn't rendered: `/evaluate` to scroll
     `cdk-virtual-scroll-viewport` to the index, re-poll, then click.
   - **Verify** (`/evaluate`): panel closed (`aria-expanded="false"`) *and* trigger text equals the
     chosen option. One retry, then escalate to recovery.
5. **mat-autocomplete** (`input[role=combobox]`) → `/type` the text, poll for options, click match.
6. **Settle**: if the flow map marks dependents for this field, `waitForStable()` on them before the
   step continues (VIN decode, make→model, use→miles, carrier-question sections).

### Option matching ladder (deterministic first)

| Tier | Rule |
|---|---|
| 1 | Exact after trim + case-fold + whitespace collapse |
| 2 | Normalized: unify `-`/`–`/`—`, `&`↔`and`, strip punctuation, drop `--Select--` |
| 3 | Alias table in the flow map (e.g. `Geico` ↔ `GEICO`, `St. Paul/Travelers` ↔ `Travelers`) |
| 4 | Token-set / edit-distance fuzzy above a confidence threshold |
| 5 | **DeepSeek** `map-option` — only here. Gets the field label, the desired value, and the option list. Returns an exact option string or `null`. |

Tiers 1–4 are pure functions and unit-tested against the recording's captured option lists. Tier 5
is the only LLM involvement and it **selects from a closed list** — it never invents a value and
never clicks.

### Escaping

All selectors go through `CSS.escape` inside the evaluate payload. This is mandatory here — real IDs
from your recording include:

```
#carrier-613-aaa-–-auto-club-group-–-insurance-link-button   ← en-dashes
#prior_liabilityasi\*MN                                       ← asterisk
#marketvalue_autoownersxml__105
```

---

## 5. Step-by-step flow

Driven by `flow/ezlynx.flow.json` (generated from the recording, hand-reviewed, committed). The
runner is generic; the per-step modules supply field mappings and dependency hints.

```
for each step in flow[lob]:
  1. navigate/assert URL matches the step pattern (account + quote id)
  2. scanStep()                      → all controls + values + errors, one evaluate
  3. plan = diff(desired, actual)    → skip already-correct fields
  4. apply(plan)                     → controls.ts, dropdown driver above
  5. waitForStable(dependents)
  6. rescan → collect field errors + "Required for Carrier: X"
  7. if errors → recovery loop (max 3 attempts/step)
  8. click next-button from the flow map
  9. assert the next URL/step header; dedupe notices ("Applicant Saved" ×3)
```

Steps 1–18 exactly as in your table, including the two traps you flagged:
- **Step 14** Home → endorsements uses `#go-to-drivers-btn` for "Carrier questions". The flow map
  records the observed button ID per step; nothing is derived by naming convention.
- **Step 17** submit-details LOB checkboxes share one selector with 18 matches → addressed by index,
  with the index recorded in the flow map.

### Why "key by selector, never by label" is non-negotiable

Your recording already proves it three ways:

- `#contactdrivers-license-state-67645461` — **missing hyphen** after `contact`, while its siblings
  are `#contact-drivers-license-status-...`. A convention-derived selector would miss it.
- Drivers are 0-based (`#driver-0-dob`) but DL# is 1-based (`#textD1DLNumber`, `#drpD1DLState`).
- ICQ labels are the current value ("Yes", "No", "4", "info") — useless as keys.

The flow map therefore stores **literal observed selectors**, and `build-flow-map.ts` will **fail
loudly** rather than infer a selector it didn't observe.

### Recording noise filter

`build-flow-map.ts` keeps only events where `path` matches
`/web/account/{accountId}/(details|rating/(auto|home)/{quoteId}/...)`. That drops:
- `/applicantportal/...` policy-summary tabs (labels polluted with inline JS/CSS),
- the results tab from **a different account** (`/web/account/145923320/...`).

It also pins to the rating tab id (`1568781575` in your excerpt) as a cross-check and reports any
event it discarded, so we can eyeball that nothing real was dropped.

---

## 6. Data model and extraction

`QuoteRequest` (zod) covers everything you listed. Two rules baked into the schema:

- **`creditAuthorization` is required with no default.** Not in `defaults.json`, not inferred. The
  submit gate refuses outright if it's absent.
- Every field carries **provenance** (`input` | `extracted` | `default` | `prefill`), so the
  pre-run diff shows exactly where each value came from. Prefill never wins over source data.

Pipeline: `RCE/docs → text → DeepSeek (JSON mode, schema in prompt) → merge (input > extracted >
default) → zod validate → print provenance diff → proceed`.

### Normalizers (all unit-tested)

| Input | Rule |
|---|---|
| DL# `" E000-143-514-100"` | strip whitespace/tabs/dashes, uppercase, per-state format check, **reject anything URL-shaped** |
| Dates | canonical ISO internally; write in the format the field accepts, then **read back and verify** (you typed `MM-DD-YYYY`, the field displays `MM/DD/YYYY`) |
| Currency | strip `$`/commas → integer |
| VIN | 17 chars, uppercase, no I/O/Q, check digit |

---

## 7. Agency defaults — please confirm each

From the one recorded client. **These are the ones I'd put in `config/defaults.json`:**

| Field | Selector | Proposed default | Confirm? |
|---|---|---|---|
| Bridge email to carriers | `[name="isEmailBridgedToCarriers"]` | **Yes** | ☐ |
| Quote as Package | `#package` | **Yes** | ☐ |
| New Policy Term | `#newPolicyTerm` | **12 Month** | ☐ |
| Prior Policy Term | `#priorPolicyTerm` | **12 Month** | ☐ |
| Paperless auto | `#coverage_paperlessauto_common` | **Yes** | ☐ |
| Residence insurance | `#resins` | **Homeowner/Condo Insurance** | ☐ |
| Travelers book transfer | `#booktransfer_travlers` | **No** | ☐ |
| Home policy form | `#policyFormType` | **HO3 - Dwelling** | ☐ |
| Carrier selection | `#all-non-preferred-button` | **Select all non-preferred**, then per-LOB overrides | ☐ |

**Deliberately NOT defaulted — these are client data, not agency practice:**
`#creditCheckAuthorized` (must come from the client), `#numberofresidents_common` (recorded 4),
`#yearsWithPriorCarrier` (3), `#yearsWithContinuousCoverage` (5), `#priorLiabilityLimits` (500CSL),
education, industry/occupation, and every dwelling value. Also note the recording's prefills that
must never be trusted: effective date `11/12/2025`, sq ft `1750`, dwelling `$800,000`.

---

## 7a. Carrier selection strategy (Q6 — decided)

**Select-all-then-prune, config-driven.**

Default behaviour: hit `#all-non-preferred-button` and `#all-preferred-button` for the LOB, then let
the error-recovery loop drop individual carriers that fail validation, each with a recorded reason.

Rationale: it matches what you actually did in the recording, and maximising the comparison set is
the entire point of a comparative rater. The recording's final deselections (Auto-Owners 105,
Nationwide 348, Travelers 13) were *that client's* validation failures, not agency policy — baking
them in as permanent exclusions would overfit to one quote.

Tradeoff, stated plainly: more carriers means more carrier-questions to fill, slower runs, and more
chances to hit an `ask_human` pause. If that gets annoying in practice, `config/carriers.json`
carries per-LOB `allow` / `deny` lists (both empty by default) to curate without a code change.

Observed carrier IDs seeded into `config/carriers.json`:
`613` AAA · `650` GEICO · `25` Progressive · `35` Liberty/Safeco · `545` Encova · `196` Acuity ·
`692` The Hartford · `105` Auto-Owners · `348` Nationwide · `13` Travelers · `377` Progressive Home (ASI).

## 7b. State coverage (Q8 — decided)

**Minnesota-first, but state-parameterised. No MN logic hardcoded in step modules.**

- State-specific controls live in the flow map keyed by state, not in code: MN PIP
  (`#MNPIPOptions`, `#MNPIPDeductible`, `#MNWorkLoss`) and state ICQs
  (`#prior_liabilityasi\*MN`, `#aaadrivemichigan{n}`, `#aaasafetymichigan{n}`).
- DL validation uses a per-state format table.
- `QuoteRequest.ratingState` drives which blocks apply; an unknown state fails fast with a clear
  message rather than guessing.

Honest limitation: MN is the only state I have ground truth for. Adding a state requires a recording
from that state to populate its flow map. The architecture won't block it; I just won't claim
support I can't test.

## 8. Error recovery, submission gate, results

**Recovery** (per step, max 3 attempts) — deterministic rules first:

| Error | Rule |
|---|---|
| "Invalid Effective Date Specified. Date can not be the in past." | use prior expiration if future, else **stop and ask** |
| "Effective date cannot be in the past" (home) | same |
| `#coveragehome_mn__105` — "Coverage A or C Amount of Pending Homeowners Policy is invalid." | mirror home Coverage A (`#dwelling`) |
| `#marketvalue_autoownersxml__105` — "Market Value is invalid." | provided market value → fall back to dwelling amount **and flag it in the report** |

Then DeepSeek `resolve-error` (field selector, nearby label, error text, allowed options, minimal
data slice) → `{action: "set" | "skip_carrier" | "ask_human", value?, reason}`. `skip_carrier`
deselects that carrier for that LOB **with a recorded reason**; `ask_human` pauses the CLI. On
`finish`, if `#step-header-finish` reads "warning Invalid", identify failing carriers, deselect with
reasons, re-check. **Never a silent drop.**

**Finish-step carrier pruning — revised after auditing the full recording.** The original plan said
"identify the failing carriers and deselect them." The recording shows the human actually ran a
*backtracking search*: deselect a carrier → re-check `finish` → if still invalid, **re-select it**
and try a different one. Liberty Mutual (35) and Acuity (196) were each dropped, found innocent, and
restored before Travelers (13) turned out to be the real culprit.

So the runner does:
1. **Identify deterministically first.** Per-carrier `Required for Carrier: X` markers are already
   collected on `carrier-questions`; read per-carrier validity off the `finish` DOM before guessing.
2. **Only if that fails**, fall back to toggle-and-recheck — and **restore any carrier that proves
   innocent**, exactly as the human did. A carrier is only left off with a concrete recorded reason.
3. Bound the search (carriers tried ≤ N) and report anything still unresolved rather than flailing.

**Submission gate**: print applicant/drivers/vehicles/coverages/selected+dropped carriers, require
explicit `y` unless `REQUIRE_SUBMIT_CONFIRMATION=false`, and **refuse entirely** without credit
authorization.

**Results**: chunked poll until no `mat-progress-bar`; loop `#answer-questions-{carrierId}-{Auto|Home}`
→ fill → `#submit-answers-button*` → await notice + re-rate; toggle Graph View **off** for the list
view; parse carrier (from `img.carrier-img` alt), LOB, premium, term, basis, alt-quote name, badges,
`Carrier Error: ...`; also parse graph-view package totals. Normalize to annual (6-mo × 2, **marked
estimated**). Emit `results/{accountId}-{timestamp}.json` + a Markdown table sorted by combined
annual premium, errors and skipped carriers listed separately. The recording's `cards[]` and
`htmlSample` become the parser's test fixtures.

---

## 9. DeepSeek client

**Model names verified against current DeepSeek docs (Sept 2026)** — the old `deepseek-chat` /
`deepseek-coder` names are legacy:

| Model | Maps to | Context | JSON mode |
|---|---|---|---|
| `deepseek-flash` | DeepSeek-V4.1-Flash | 1M | ✅ |
| `deepseek-v4-pro` | DeepSeek-V4-Pro-0813 | 1M (384K out) | ✅ |

Proposed default `DEEPSEEK_MODEL=deepseek-flash`, kept configurable as you asked.

Client: OpenAI-compatible `/chat/completions`, `response_format: {type: "json_object"}`, the literal
word "json" plus a schema example in the prompt (a documented requirement), explicit `max_tokens`
to avoid truncated JSON, timeout, retries with backoff, **zod validation on every response**,
one re-ask on invalid JSON, then fail loudly. Guards for the documented **empty-content** edge case.

---

## 10. Security, privacy, Windows

- `CAMOFOX_CRASH_REPORT_ENABLED=false` is **mandatory** — documented in `.env.example`, `README.md`,
  and **asserted at startup** (the agent refuses to run otherwise). EZLynx pages contain client PII
  and `lib/reporter.js` ships telemetry by default.
- Redacting logger: SSN, full DL#, DOB never printed (DL# → last 4 only).
- DeepSeek receives the minimum slice per call; **SSN is never sent**.
- Screenshots/traces off by default → `debug/` (gitignored) with a warning when enabled.
- No credentials stored. Login is manual, once, via `CAMOFOX_INTERACTIVE=desktop`
  (**the right mode on Windows** — the VNC plugin is Linux-only). Persistence plugin saves the
  session under `~/.camofox/profiles/<sha256(userId)>/`. A run that lands on a login page stops with
  a clear "re-authenticate" message. **MFA and credential entry are never automated.**
- Gitignore additions: `ezlynx-agent/fixtures/private/`, `ezlynx-agent/results/`,
  `ezlynx-agent/debug/`, `ezlynx-agent/.env`.
- `scripts/redact-recording.ts` produces the committed redacted fixture (fake names, DOBs, DL#s,
  VINs, addresses, emails, phones) with **stable pseudonyms** so relationships survive redaction.
  A unit test greps the redacted file for the real values and fails if any survive.

---

## 11. Testing

- **Unit**: recording parser, flow-map builder, normalizers (DL#/date/currency/VIN), option-matching
  ladder, results parser (recording fixtures), DeepSeek client (mocked transport).
- **Integration**: mock camofox server + static HTML fixtures for drivers, vehicles,
  carrier-questions, and results — including a real `mat-select` overlay to exercise the dropdown
  driver end to end.
- **No test touches EZLynx or DeepSeek.** Manual `npm run ezlynx:smoke` does a dry run against a
  real test account.
- Cross-platform npm scripts so `npm test` works in PowerShell.

---

## 12. Open questions — I need these before implementing

### Resolved

- **Q3 — `.env` vs CONTRIBUTING.md.** ✅ Approved. The agent reads the real environment and supports
  Node's built-in `--env-file`. No `dotenv` dependency; nothing auto-loaded into the camofox process.
- **Q5 — test account.** ⚠️ Resolved with a caveat. No test account exists; a real client's account
  will be used. `--dry-run` never submits, so **no credit/underwriting pull is triggered** — but it
  *will* create or modify a real quote record on that person's account. See §12.1.
- **Q6 — carrier list.** ✅ Decided by me: select-all-then-prune, config-driven. See §7a.
- **Q8 — states.** ✅ Decided by me: Minnesota-first, state-parameterised. See §7b.

### Still open

1. **The recording file.** Please place the full `ezlynx-recording.json` at
   `ezlynx-agent/fixtures/private/`. **Blocking** — the flow map cannot be generated without it.
2. **Node 22+.** You're on 20.19.0. Confirm you'll upgrade.
4. **Paths.** You wrote `fixtures/` and `scripts/` unprefixed, but repo root already has a
   `scripts/`. I've put both under `ezlynx-agent/` to avoid polluting core. OK?
7. **Effective date policy.** Default to prior expiration date, or today + N days?
9. **RCE format.** Text-based PDF or scanned? Determines whether I need OCR. A sample would help.
10. **Alt quotes.** Carriers return multiple alternates — report all, or lowest per carrier?
11. **Unanswerable carrier questions.** Default to `skip_carrier` with a reason, or always
    `ask_human`?
12. **Annual normalization.** Confirm 6-month × 2, flagged as estimated.

### 12.1 Recommended before touching a client account

EZLynx lets you create an applicant freely. Creating a **dummy applicant** — your own name, a real
MN address, plausible vehicles — costs a few minutes and gives a disposable target for every dry
run, so no real client record accumulates junk quotes and mistakes during bring-up are free. Build
and shake out the flow against that, then do one supervised dry run on the real account as the final
check.

If you'd rather go straight at the real account: runs are non-submitting by default and the submit
gate requires an explicit `y`, so nothing reaches a carrier by accident. Just confirm you have that
client's authorisation on file, since the quote activity lands on their record.

### 12.2 Secrets

A DeepSeek API key was pasted into chat during planning. It is compromised and must be rotated. The
replacement goes in `ezlynx-agent/.env` (gitignored) and is never written to `.env.example`,
fixtures, logs, or commits. The variable name is **`DEEPSEEK_API_KEY`** (not `DEEP_SEEK_API_KEY`).

---

## 12.3 Recording audit — received and validated

File landed at **repo-root `fixtures/private/ezlynx-recording.json`** (not `ezlynx-agent/fixtures/`).
It arrived **untracked and NOT gitignored** — `git add -A` would have staged 249 KB of real client
PII. Added `fixtures/private/`, `ezlynx-agent/fixtures/private/`, `ezlynx-agent/results/`, and
`ezlynx-agent/debug/` to `.gitignore`. Verified ignored; verified never committed to any branch.

| Metric | Value |
|---|---|
| Events / size / duration | 273 · 249 KB · 9m23s (20:14:34 → 20:23:57Z) |
| Distinct selectors | **615** |
| Coverage | **All 18 steps, both LOBs** — account 201601955, auto quote 183176951, home quote 183186261 |
| Screens | 37 (drivers 104 fields, vehicles 93, dwelling-info 56, home policy-info 53, auto coverage 49) |
| Captured option lists | 30 controls |
| Results snapshots | 7 (10–19 cards, 3.2–6 KB htmlSample each) |
| Noise confirmed | 14 `/applicantportal/` events + **3 from account 145923320** — exactly as you warned |

**Four findings that change the build:**

1. **Option lists must be keyed by `(lob, step, selector)`, not selector alone.** `#priorCarrier`
   has **299 options on auto but 265 on home**, and they are genuinely different lists — auto-only
   entries (`1st Auto`, `Ag Workers Mutual Auto`) vs home-only (`American Integrity`,
   `Anchor Insurance`, `Allied Trust`). A selector-keyed map would silently corrupt the home step.

2. **The recording mixes two selector dialects.** Most are plain CSS, but a few are *Playwright*
   pseudo-selectors: `a:has-text("Details")`,
   `mat-form-field:has(mat-label:text-is("Premium: Low-High")) mat-select`. These work on `/click`
   and `/type` (Playwright `locator()` handles them, and `selectorValidationError()` at
   [server.js:228](../server.js#L228) only balances brackets/quotes, so they pass) but **`document.querySelector`
   throws on them**, so they cannot be used by the `/evaluate` reader. `build-flow-map.ts` will tag
   each selector `css | playwright` and the reader will refuse the latter, resolving it to a stable
   id once instead.

3. **Results must be parsed from the DOM, not the flattened `cards[]` text.** The card text has no
   carrier name (that's `img.carrier-img` alt) and is polluted with Material icon ligatures —
   `directions_car`, `home`, `keyboard_arrow_down` leak in as words. `cards[]` becomes an assertion
   fixture; the real parser reads structure via `/evaluate`.

4. **Finish-step pruning is a backtracking search**, not a simple drop — see §8.

Also confirmed: `#submit-answers-button1912830791` / `...773` carry **dynamic numeric suffixes**
(not carrier IDs), so prefix matching is mandatory; and the step-17 LOB checkbox really is addressed
positionally (`div.lob-action:nth-of-type(1) > mat-checkbox > div > div > input`).

---

## 12.4 Live validation results (run against real EZLynx)

The §2 architecture — `/evaluate` reads, `/click` + `/type` act — is **confirmed working**
against the live EZLynx create-applicant form. 10/10 fields set and verified by readback:

| Kind | Median | Notes |
|---|---:|---|
| text / date | ~200ms | `fill()` + readback |
| **mat-select** | **~7s** | open → read options → match → click by option id → verify |

Four bugs the live run exposed, all fixed:

1. **Panel discovery was scoped wrongly.** `openPanelOptions()` queried
   `.cdk-overlay-container .cdk-overlay-pane` as a *descendant*. EZLynx renders select panels
   with `position: static` **outside** the overlay container, leaving it empty — so every
   dropdown silently reported "did not open". Now resolved via the control's `aria-owns`
   (`#applicant-gender-panel`), falling back to any visible `.mat-mdc-select-panel` /
   `[role=listbox]`, then a *global* `.cdk-overlay-pane`. Same bug affected `panelClosedExpr`
   (it always reported "closed") and `scrollVirtualOptionExpr`.
2. **Desktop mode cannot run automation on Windows.** Each tab is a real OS window and native
   mouse events reach only the focused one → `native mouse down timed out`. Desktop mode is
   login-only; automation runs headless, where clicks work first time.
3. **`/wait` is not enough for this Angular shell.** networkidle + hydration returns while the
   form is still unpainted — a scan then finds ~1 control instead of 50. Steps must wait for a
   known anchor control to exist.
4. **`newPageTimeoutMs` 10s was too tight** for Windows; raised to 45s (see Windows notes in
   the README).

**Plugin decision (§2).** The stated trigger was ">8s median per dropdown". Measured median is
~7s — just under. At ~150–250 dropdowns per Auto+Home quote that is roughly 17–29 minutes of
dropdown time alone, so the `plugins/matselect/` option is worth revisiting for throughput,
but it is not required for correctness.

**Applicant creation entry point** (previously unrecorded): `#root-NavMenu_Applicants` opens a
flyout containing `#CreateApplicant` → **`/web/account/create/personal`**. That screen reuses the
same selectors as the recorded `/details` screen (`#applicant-first-name`, `#applicant-gender`,
`#applicant-primary-address-*`), so the existing applicant field map largely applies.

## 13. Proposed build order (after approval)

1. Package skeleton, `config.ts`, redacting logger, camofox client + `dom.ts`/`waits.ts` **(+ a live
   spike against one real `mat-select` to validate §4 before building on it)**
2. `redact-recording.ts` → redacted fixture → `build-flow-map.ts` → hand-review `ezlynx.flow.json`
3. Schemas, normalizers, defaults merge + provenance diff
4. DeepSeek client + the three prompts
5. Step runner + recovery loop; Auto steps 1–9
6. Home steps 10–16
7. Submit gate + results parsing/reporting
8. Tests, README, smoke script
