# How the EZLynx agent works

Written in plain English. No prior knowledge of the codebase assumed.

---

## 1. What this thing does

An agency staff member normally opens EZLynx, creates an applicant, and then types the same client
details into roughly 18 screens of a comparative rater — Auto first, then Home — before submitting
to carriers and reading back the premiums.

This agent does that typing. You give it the client's details in a file; it drives a real Firefox
browser through the same screens a person would use, fills every field, fixes the validation errors
EZLynx throws back, and returns a comparison of the quotes.

It is **not** an API integration. EZLynx has no public API for this, so the agent works the only way
available: by operating the website.

---

## 2. The three moving parts

Think of it as three programs that talk to each other over a local network connection.

```
   YOU
    |  type a command
    v
+------------------+        HTTP          +--------------------+       controls      +-----------+
|  ezlynx-agent    | -------------------> |  camofox-browser   | ------------------> |  Firefox  |
|  (the brain)     | <------------------- |  (the hands)       | <------------------ | (Camoufox)|
+------------------+                      +--------------------+                     +-----------+
    |                                                                                      |
    | asks questions when stuck                                                             | browses
    v                                                                                       v
+------------------+                                                               +-----------------+
|  DeepSeek (AI)   |                                                               |  EZLynx website |
+------------------+                                                               +-----------------+
```

**camofox-browser — the hands.** A server that already existed in this repository. It runs a real
Firefox browser and exposes simple web commands: "open a tab", "click this thing", "type this text",
"run this bit of code on the page". It listens on `http://localhost:9377`. The agent does not modify
it; it just uses it.

**ezlynx-agent — the brain.** The new part. It knows what EZLynx's screens look like, what order
they come in, what to put in each box, and what to do when something goes wrong. It never touches
the browser directly — it only sends instructions to camofox.

**DeepSeek — the advisor.** An AI service, used sparingly and only for judgement calls. More on this
in section 6.

Keeping the brain and the hands separate matters: the browser work is generic and already tested,
and all the insurance-specific knowledge lives in one place that can be changed without touching it.

---

## 3. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript** | Catches whole classes of mistakes before anything runs |
| Runtime | **Node.js 22+** (24 in use) | Required by camofox's browser library, which crashes on Node 20 |
| Validation | **zod** | Describes what a valid quote looks like, and rejects bad data at the door |
| CLI | **commander** | Standard, boring argument parsing |
| Tests | **node:test** (built in) | No extra tooling; works on Windows without fuss (181 tests) |
| HTTP | **built-in `fetch`** | No HTTP library needed |
| Browser control | **camofox-browser** (Express + Playwright + Camoufox/Firefox) | Already in this repo |
| AI | **DeepSeek**, OpenAI-compatible API, JSON mode | Cheap, and the agent only calls it for a few decisions |
| Storage | **Plain files** | No database. Inputs and outputs are JSON and Markdown |

Deliberately *not* used: no database, no message queue, no web UI, no cloud services, no `dotenv`
(the parent repo forbids it; Node reads the env file natively instead).

---

## 4. How information flows through a run

### Stage one — build the quote file

```
RCE document ─┐
client JSON  ─┼──> merge ──> validate ──> quote.json
agency defaults ─┘
```

Three sources are combined into a single file describing the whole quote. They have a strict pecking
order: **what you typed beats what was read from a document, which beats the agency default.**

The agent then prints where every value came from, so you can see at a glance which figures were
assumed rather than supplied. Agency defaults are things like "we always quote 12-month terms" —
editable policy, not facts about the client.

One rule is absolute: **permission to pull credit has no default and is never guessed.** It must be
stated explicitly, with who gave it and when. Without it the agent refuses to submit anything.

### Stage two — drive the website

```
for each screen:
    wait until the screen has actually appeared
    look at every field currently on it
    work out what needs changing
    fill those fields, checking each one took
    look for error messages
    fix them (see section 6)
    click Next
```

That loop runs for every screen: applicant details, then the Auto screens, then the Home screens.

### Stage three — collect the answers

Once submitted, carriers take time to respond. The agent waits for the progress bars to disappear,
answers any extra questions a carrier asks, switches the results page to list view (which shows exact
figures), and reads each quote card. It writes two files: a JSON file for machines and a Markdown
table for humans, sorted cheapest first, with errors and dropped carriers listed separately.

---

## 5. The part that does the actual typing

This is the heart of the system, and it needed care.

EZLynx is built with Angular Material, so its dropdowns are not normal web dropdowns. You cannot
simply set their value. You have to click the control, wait for a floating list to appear, click the
right item, and confirm it stuck.

The agent splits the work in two:

- **Reading** happens by running small bits of JavaScript on the page — what fields exist, what
  they contain, what options a dropdown offers, what errors are showing.
- **Acting** happens through the browser's real click and typing commands, so the website receives
  genuine mouse and keyboard events exactly as it would from a person.

That split matters. Faking clicks in JavaScript would appear to work while silently doing nothing on
covered or disabled controls.

**Choosing the right dropdown option** runs through a ladder, cheapest first:

1. Exact match
2. Match ignoring case, spacing and punctuation
3. A known synonym list
4. Fuzzy match, but only when one candidate clearly wins
5. Ask the AI — and even then it must pick from the real list, never invent

If two options are too close to call, it refuses to choose. A concrete example: the carrier list
shows "Liberty Mutual (formerly Safeco)", while the prior-carrier dropdown lists "Liberty Mutual" and
"Safeco" as separate entries. Guessing would quietly record the wrong prior carrier on every quote.

**Every value written is read back.** EZLynx pre-fills fields with stale data often enough that
"it looks right" is not evidence.

---

## 6. What happens when a field won't accept a value

EZLynx pushes back constantly — dates in the past, carrier-specific questions, figures that must
match another screen. The agent tries three things in order:

**1. A rule.** Hand-written logic for problems seen before. If the effective date is rejected as
being in the past, use the prior policy's expiry date instead. If a carrier demands the pending home
coverage amount, copy it from the home side.

**2. The AI.** Given the field, the error message, the allowed options, and a small slice of the
quote, DeepSeek suggests a fix. It gets the minimum information needed — never a social security
number, never names or dates of birth. It replies in a fixed format that is checked before use; a
malformed reply is retried once, then treated as a failure.

**3. You.** If neither works, it stops and asks. This is deliberate. The AI is explicitly told to
prefer asking over guessing at client facts, because a plausible-but-wrong value produces a wrong
premium and nothing flags it.

Only fields EZLynx actually marks as mandatory can block progress. Errors on optional fields are
noted in the report and stepped over.

**Carriers are never dropped silently.** If one has to be removed to get a quote through, the reason
is recorded and appears in the final report.

---

## 7. Where the screen knowledge comes from

The agent knows EZLynx's screens because a full quote was recorded once, and that recording was
turned into a map: for every screen, the exact field identifiers, the button that advances, the
options each dropdown offers, and the error messages seen.

Two rules keep that map honest:

**Fields are identified by their code-level ID, never by their on-screen label.** Many labels in
EZLynx are useless — some are just the current value ("Yes", "4"), and some contain stray page code.

**Identifiers are copied exactly, never guessed from a pattern.** The real form contains genuine
inconsistencies: drivers are numbered from zero, but their licence fields are numbered from one; one
field is missing a hyphen its neighbours have. Any system that inferred names would get these wrong.

There is also a discovery tool for screens that were never recorded. Point it at a page and it
reports every control, every dropdown's options, and everything clickable — so new screens are mapped
from observation rather than assumption. That tool is how applicant creation was added.

---

## 8. Privacy and safety

Client data is the main risk here, so several things are structural rather than optional:

- **Logs are scrubbed at source.** Social security numbers never appear, licence numbers show only
  the last four digits, dates of birth are reduced to a year. There is no route around it.
- **The recording contains real client data**, so it stays out of version control, and a script
  produces an anonymised copy for testing. That script refuses to write if anything sensitive
  survives, and re-checks the output independently.
- **Crash reporting must be switched off.** camofox sends anonymised crash data by default; EZLynx
  pages contain client information, so the agent refuses to start unless it's disabled.
- **Nothing is submitted without confirmation.** Submitting can trigger credit checks on a real
  person, so the agent prints a full summary and waits for you to type `y`.
- **Passwords and MFA are never automated.** You log in by hand once; the browser session is saved
  and reused.
- **Test mode still writes to EZLynx.** A dry run never contacts a carrier, but every "Next" click
  genuinely saves. There's no way around that, so the supplied test data is obviously fake.

---

## 9. Honest status

**Working and verified against the live site:** login and session reuse, creating an applicant and
filling every field on that screen without prompting, dropdown handling, error recovery, and the
supporting tooling.

**Built and unit-tested, but never yet run against the live site:** the Auto and Home rating screens,
carrier selection, submission, and results parsing. These were built from the recording, which was
made under a different EZLynx user account, so some field identifiers may have shifted. Expect to fix
things there.

**Known limitation:** marital status "Married" makes EZLynx add a hidden spouse-contact section that
is required but cannot be filled, which blocks saving. Co-applicants are affected by the same issue.
Both are documented in the README, and the agent warns loudly rather than failing obscurely.

---

## 10. Current blockers

### Hard blockers — work stops here

- **Married applicants cannot be saved.** Setting marital status to "Married" (or Domestic Partner)
  makes EZLynx create a spouse-contact section that is **required but hidden**, so it cannot be
  filled and the applicant cannot be saved. Proven by A/B test: Married produces the hidden row,
  Single does not.
  *Workaround in use:* the test applicant is "Single". A real married client will hit this.

- **Co-applicants cannot be saved, for a related reason.** Clicking EZLynx's "Add contact" does
  produce a fillable contact row — and all ten contact fields fill correctly — but it also
  **removes the Save / Go to auto / Go to home buttons** from the page (29 buttons before, 25
  after). The control that commits the contact and brings those buttons back has not been found.
  *To unblock:* someone needs to click "Add contact" in the browser and report what closes or
  confirms that contact card — a tick, "Done", "Save contact", an X. One observation ends it.

### Unvalidated — built and unit-tested, never actually run

- **The Auto and Home rating screens have never executed.** Every screen after applicant creation —
  carriers, policy info, drivers, vehicles, incidents, coverages, carrier questions, finish — was
  built from the recording and has not been driven once.
- **The recording was made under a different EZLynx user** than the one now in use. Per-user
  differences in permissions, enabled carriers and custom fields may have shifted field identifiers.
  Some drift is likely.
- **Submission has never been exercised.** The confirmation gate, the submit buttons and the
  post-submit flow are unrun.
- **Results parsing was tested only against saved fixtures**, not a live results page.
- **Two fields in the map cannot be read** by the page reader, because the recorder captured them in
  a form the reader cannot use (the submit-page LOB dropdown and the results premium sort). They are
  flagged and must be driven by clicking only.

### Environment and process friction

- **No test account.** Runs use a real user's login, and every dry run creates a real applicant
  record that has to be cleaned up afterwards. A dummy applicant in EZLynx would remove this.
- **A dry run still writes to EZLynx.** It never contacts a carrier, but every "Next" saves. This is
  how EZLynx works and cannot be avoided.
- **EZLynx sessions are short-lived** (a few hours) and appear to be tied to the network — the
  session reads as expired when the VPN is off. The VPN must be connected for every run.
- **Re-logging in means restarting the browser server twice** — once into visible mode to type the
  password, once back into headless for automation. Visible mode cannot be used for automation on
  Windows, because clicks only reach the window that currently has focus.
- **Speed.** Each dropdown takes roughly 5–9 seconds. At 150–250 dropdowns for a full Auto + Home
  quote that is around 20–30 minutes of dropdown time alone. Acceptable for now; there is a known
  optimisation (moving the dropdown handling into the browser server) that was deliberately deferred.

### Decisions still needed from the agency

- **Effective date policy** when the client's supplied date is in the past — use the prior policy's
  expiry, or today plus a fixed number of days?
- **RCE documents** — are they text PDFs or scans? Scans would need OCR, which is not built. Today
  the file must be converted to text first.
- **Alternate quotes** — carriers often return several variants. Report all of them, or only the
  cheapest per carrier?
- **Unanswerable carrier questions** — drop that carrier automatically with a recorded reason, or
  always stop and ask?
- **Annual premium** — confirm that doubling a 6-month premium is the right comparison, marked as an
  estimate.
- **Other states.** Minnesota is the only state with a recording. Each additional state needs its
  own recorded session before it can be trusted.

---

## 11. Where things live

```
ezlynx-agent/
  src/
    cli.ts          the commands you type
    config.ts       settings, checked at startup
    camofox/        talking to the browser: reading pages, clicking, typing, waiting
    domain/         what a valid quote is; cleaning up dates, licence numbers, money
    llm/            talking to DeepSeek
    flow/           the screens, in order, and the loop that works through them
    recovery/       what to do when a field is rejected
    results/        reading the quote results and writing the report
    recording/      turning the recorded session into a screen map
  config/           agency defaults and the carrier list — edit these, not the code
  flow/             the generated screen map
  examples/         a fake applicant for testing
  results/          run output (not version controlled)
```

Two files are meant to be edited by the agency rather than a developer: `config/defaults.json` for
standard practice, and `config/carriers.json` for which carriers to quote.
