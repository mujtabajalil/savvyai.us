# ezlynx-agent

Fills the EZLynx comparative rater for **Personal Auto** and **Homeowners (HO3)**, submits to
carriers, handles carrier follow-up questions, and returns a quote comparison.

It drives [camofox-browser](../README.md) over its REST API. **No camofox core files are
modified** — this is a separate package that talks to `http://localhost:9377`.

---

## How it works

Deterministic first, LLM second.

- Known fields are filled from a **selector map** generated from a recorded session
  ([`flow/ezlynx.flow.json`](flow/ezlynx.flow.json)). Fields are keyed by **selector, never by label** —
  many recorded labels are the current value ("Yes", "No", "4") or polluted with inline JS.
- **DeepSeek** is used for exactly three things: extracting data from source documents, resolving
  validation errors and unknown carrier questions, and mapping a free-text value onto a dropdown's
  real option list. It never decides what to click.
- Every value written is **read back and verified**. EZLynx prefills are stale often enough that
  "it looks right" is not evidence.

### Angular Material dropdowns

EZLynx uses `mat-select`, not `<select>`. camofox's `POST /select` calls Playwright's
`selectOption()`, which only works on native selects, and `POST /type` rejects `role="combobox"`.
So the agent splits responsibilities:

- **`/evaluate` reads** — classify the control, read option lists out of the CDK overlay, read
  validation errors, poll readiness predicates.
- **`/click` and `/type` act** — Angular gets real input events and Playwright's actionability
  checks (visible, stable, enabled, hit-target).

Per dropdown: click to open → wait for the panel → read options → match → click the option **by its
own id** (never `nth-child`, because the 299-entry Prior Carrier list can virtualise) → verify the
panel closed and the trigger updated.

Option matching runs a deterministic ladder — exact → normalized → alias → fuzzy — and only
escalates to DeepSeek when nothing is confident, or when the top two candidates are too close to
call. Ambiguity escalates rather than guessing: the rating page says
`Liberty Mutual (formerly Safeco)` while the prior-carrier list has `Liberty Mutual` and `Safeco` as
separate options, and picking the wrong one silently corrupts the quote.

---

## Setup

### Requirements

- **Node 22 or newer** (`better-sqlite3` in the parent repo also requires it)
- camofox-browser running locally
- A DeepSeek API key (optional — without it the agent uses deterministic rules only and asks you
  about anything it cannot resolve)

### Install

```bash
cd ezlynx-agent
npm install
npm run build
npm test
```

### Configure

Copy [`.env.example`](.env.example) to `.env` and fill it in. Nothing is auto-loaded — pass the file
explicitly with Node's built-in flag:

```bash
node --env-file=.env dist/src/cli.js run --account 201601955 --quote ./quote.json
```

The `dotenv` package is deliberately not used; the parent repo's
[CONTRIBUTING.md](../CONTRIBUTING.md) forbids it.

| Variable | Notes |
|---|---|
| `CAMOFOX_URL` | default `http://localhost:9377` |
| `CAMOFOX_ACCESS_KEY` | required if the server sets one |
| `CAMOFOX_USER_ID` | identifies the persisted browser session — keep it stable |
| `CAMOFOX_CRASH_REPORT_ENABLED` | **must be `false`** — the agent refuses to start otherwise |
| `DEEPSEEK_API_KEY` | note the spelling: no underscore after `DEEP` |
| `DEEPSEEK_MODEL` | `deepseek-flash` (default) or `deepseek-v4-pro` |
| `REQUIRE_SUBMIT_CONFIRMATION` | `true` by default; requires an explicit `y` before submitting |

**`CAMOFOX_CRASH_REPORT_ENABLED=false` is mandatory.** EZLynx pages contain client PII and
camofox-browser sends crash/hang telemetry by default. Set it for **both** the agent and the camofox
server process. Startup fails if it is not exactly `false`.

---

## First-time login

Credential entry and MFA are **never automated**.

Two camofox defaults fight the manual-login flow and must be relaxed for this one step:

| Default | Problem |
|---|---|
| `TAB_INACTIVITY_MS=300000` | the login tab is reaped after 5 minutes and the window disappears mid-login |
| `BROWSER_IDLE_TIMEOUT_MS=300000` | the browser shuts down 5 minutes after the last session closes |
| `SESSION_TIMEOUT_MS=600000` | the session expires while you are still typing |

1. Start camofox in **login mode** — desktop window, reapers relaxed (cmd, from the repo root):

   ```cmd
   cd /d <repo> && set "CAMOFOX_INTERACTIVE=desktop" && set "CAMOFOX_CRASH_REPORT_ENABLED=false" && set "TAB_INACTIVITY_MS=3600000" && set "SESSION_TIMEOUT_MS=0" && set "BROWSER_IDLE_TIMEOUT_MS=0" && npm start
   ```

   `SESSION_TIMEOUT_MS=0` and `BROWSER_IDLE_TIMEOUT_MS=0` disable those timers entirely.
   `TAB_INACTIVITY_MS` has no disable value, so it is set to an hour.

2. `npm start` alone shows **no window** — a headed browser with zero pages renders nothing.
   Create a tab to make one appear (second terminal):

   ```cmd
   curl -s -X POST http://localhost:9377/tabs -H "content-type: application/json" -d "{\"userId\":\"ezlynx-agent\",\"sessionKey\":\"default\",\"url\":\"https://app.ezlynx.com/auth/account/login\"}"
   ```

   Go straight to `/auth/account/login`. The bare domain `app.ezlynx.com` is blocked by Cloudflare,
   and an account the logged-in user cannot open returns EZLynx's own in-app 403.

3. Log into EZLynx by hand in that window, including MFA.
3. The persistence plugin saves the session under `~/.camofox/profiles/<sha256(userId)>/`, keyed by
   `CAMOFOX_USER_ID`.
4. Later runs reuse it. If a run lands on a login page it stops with a clear re-authenticate
   message rather than trying to log in.

---

## Usage

```bash
# 1. Extract from source documents and merge with your input JSON
node --env-file=.env dist/src/cli.js extract --rce ./rce.txt --input ./client.json --out ./quote.json

# 2. Fill every step without submitting
node --env-file=.env dist/src/cli.js run --account 201601955 --quote ./quote.json --lob auto,home --dry-run

# 3. Real run (prompts before submitting)
node --env-file=.env dist/src/cli.js run --account 201601955 --quote ./quote.json --lob auto,home

# 4. Parse an existing results page
node --env-file=.env dist/src/cli.js results --url "https://app.ezlynx.com/web/account/.../quote-results/..."
```

`extract` prints a **provenance diff** showing which values came from your input, which were
extracted from documents, and which fell back to agency defaults — review it before running.

RCE PDFs must be converted to text first (`pdftotext rce.pdf rce.txt`). Binary PDF parsing is not
bundled; the CLI detects a raw PDF and tells you.

### `--dry-run`

Fills and validates every step and never submits to a carrier. It **cannot** avoid creating or
modifying a real quote record — EZLynx saves on every "next" click. Prefer a dummy applicant while
you are shaking things out.

---

## Safety rails

- **Credit authorisation has no default.** `creditAuthorization` must come from the client and is
  required by the schema. A run refuses to start if `authorized` is false, and the submit gate
  refuses without it. Submitting can trigger credit and underwriting reports on a real person.
- **The submit gate** prints applicant, drivers, vehicles, selected carriers, dropped carriers with
  reasons, and flags — then requires an explicit `y`.
- **No carrier is dropped silently.** Every drop carries a reason and appears in the report.
- **Logging is redacted at the source.** SSNs never appear, DL numbers show the last 4, DOBs degrade
  to a birth year. There is no unredacted path out of the logger.
- **The LLM gets minimal slices.** No SSNs, no names, no DOBs, no VINs — scoped to the field being
  resolved.

---

## Re-recording after an EZLynx UI change

The flow map is generated, hand-reviewed, and committed. When EZLynx changes its UI:

1. Record a fresh full Auto + Home session and save it to
   `../fixtures/private/ezlynx-recording.json` (gitignored — it contains real client PII).
2. Regenerate both artefacts:

   ```bash
   npm run build
   node dist/scripts/build-flow-map.js      # -> flow/ezlynx.flow.json
   node dist/scripts/redact-recording.js    # -> fixtures/ezlynx-recording.redacted.json
   ```

3. **Read the warnings.** The builder reports steps with no observed next-button, steps with more
   than one, and Playwright-dialect selectors that the DOM reader cannot use.
4. Review the diff on `flow/ezlynx.flow.json`, then run the tests — the recording tests assert step
   coverage, per-step option scoping, and the literal-selector quirks.

The redactor refuses to write if any sensitive value survives, and runs a second, independent
PII-shape sweep that does not depend on its own selector rules.

---

## Testing

```bash
npm test          # build + full suite (147 tests)
npm run typecheck
```

No test touches EZLynx or DeepSeek. Integration tests run against a mock camofox server; the
results parser is tested against cards and HTML captured in the recording.

For a real dry run against a real account:

```bash
npm run ezlynx:smoke -- --account 201601955 --quote ./quote.json
```

### Validating the dropdown driver

The `mat-select` driver is the assumption everything else rests on. To check it against a live page:

```bash
node --env-file=.env dist/scripts/spike-matselect.js \
  --url "https://app.ezlynx.com/web/account/<id>/rating/auto/<quoteId>/policy-info" \
  --selector "#priorCarrier"
```

Read-only by default; reports whether the panel opens, how many options render, whether they carry
stable ids, and whether the list virtualises. Add `--set "Progressive" --verify` to actually select.

---

## Layout

```
src/
  cli.ts              extract | run | results
  config.ts           zod-validated env, fails fast
  camofox/            REST client, DOM readers, waits, control dispatcher
  domain/             schema, normalizers, option matcher, defaults merge
  llm/                DeepSeek client + the three prompts
  flow/               step definitions, runner, carrier selection/prune
  recovery/           deterministic rules -> LLM -> ask human
  results/            results collection, parsing, reporting
  recording/          recording parser, redactor, flow-map builder
config/               defaults.json (agency policy), carriers.json
flow/                 ezlynx.flow.json (generated, committed)
fixtures/             redacted recording (committed); private/ is gitignored
scripts/              redact-recording, build-flow-map, spike, smoke
```

## Windows notes

Findings from bringing this up on Windows 11:

- **Node 22+ is mandatory.** `camoufox-js` declares `engines: >= 22` and **segfaults** on Node 20 inside
  `launchOptions()` — the server binds its port, then dies the moment it launches the browser.
- **`newPageTimeoutMs` was raised from 10000 to 45000** in `camofox.config.json`. Desktop mode has to
  create a real OS window, which regularly exceeded 10s here; the server would tear the session down,
  retry, and fail the request with a 500 even though the page was still loading. At 45s a tab opens
  first-try in ~11s. This is the one camofox file this project changes, and only a tuning value.
- **The reapers cut manual login short** — see First-time login above.
- `npm test` uses `node --test "dist/**/*.test.js"`. Node 24 rejects the bare `node --test dist/`
  directory form that worked on Node 20.

## Known limits

- **Married applicants and co-applicants are not supported yet.** Two linked findings, both
  verified live:

  1. Setting marital status to **Married** (or Domestic Partner) makes EZLynx create a
     spouse-contact row as soon as Address State is set. The row is **required** but rendered
     `visibility: hidden`, so it cannot be filled and the applicant cannot be saved.
     A/B tested: `Married` -> hidden contact row appears; `Single` -> no row, saves cleanly.
  2. Clicking **"Add contact"** to get a fillable row switches the form into a contact-editing
     mode that **removes the Save / Go to auto / Go to home buttons** (29 buttons before, 25
     after). The control that commits the contact and restores the action bar has not been
     identified.

  So married applicants and explicit `coApplicant` data both block the applicant step. The agent
  warns loudly in either case. Use `Single` until this is resolved.

  To finish this: in the browser, click "Add contact" and note which control closes/commits the
  contact card — that selector is the missing piece.

- **Minnesota only, for now.** MN is the only state with a recording. State-specific fields live in
  the flow map keyed by state rather than in code, so adding a state means recording it — not
  rewriting the steps.
- **Two Playwright-dialect selectors** in the recording (the submit-page LOB dropdown and the
  results premium sort) cannot be read by the `/evaluate` reader. They are flagged by the flow-map
  builder and driven through `/click` only.
- **The live `mat-select` spike has not yet been run against real EZLynx.** Until it has, treat the
  dropdown driver as designed-but-unverified.
