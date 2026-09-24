# savvy-backend

The EZLynx connection behind the frontend's Connections page. FastAPI, SQLite,
and camofox doing the actual signing in.

## What it is for

EZLynx asks for a one-time code the first time a browser signs in. After that it
trusts the device, so the code is a one-off and the stored username and password
are enough. This service is what makes that true across restarts:

1. The agent saves their EZLynx username and password once.
2. camofox opens EZLynx, types them, and stops at the code screen.
3. The agent types the code in the frontend; it goes straight into that browser
   session and is never stored.
4. camofox's persistence plugin checkpoints the cookies — device trust included —
   so every later sign-in replays the saved credentials alone. Usually it does not
   even reach the login page: the saved session is still valid.

## Run it

```bash
cp .env.example .env                                   # then fill in SAVVY_ENC_KEY
python3 -c "import secrets; print(secrets.token_hex(32))"
set -a && . ./.env && set +a
uv run uvicorn main:app --port 8000
```

camofox must be running and reachable at `CAMOFOX_URL` — headless is fine, no
window is needed any more. From `ezlynx-agent/`: `docker compose up -d --build`
(it publishes on 127.0.0.1 only). Running it bare from `camofox/` instead, bind it
to loopback yourself — it has no auth without `CAMOFOX_ACCESS_KEY`, and anyone on
the network could otherwise drive every agent's EZLynx session by profile name:

```bash
CAMOFOX_BIND_HOST=127.0.0.1 CAMOFOX_CRASH_REPORT_ENABLED=false npm start
```

The Angular dev server proxies `/api` here (`frontend/proxy.conf.json`), so start
the frontend with `npm start` in `frontend/` and use the Connections page.

```bash
uv run pytest
```

## API

| | |
|---|---|
| `GET /api/ezlynx` | what the Connections page renders |
| `POST /api/ezlynx` | `{username, password}` — save and sign in |
| `POST /api/ezlynx/mfa` | `{code}` — finish a sign-in that asked for one |
| `POST /api/ezlynx/login` | replay the stored credentials, e.g. before a quoting run |
| `DELETE /api/ezlynx` | forget the credentials |
| `POST /api/chat` | `{messages}` — one assistant turn: DeepSeek with the tools below |

Every response is the connection state: `saved`, `connected`, `username`,
`connectedAt`, `mfaPending`, plus `result` and `message` for the call just made.
`result` is `connected`, `mfa_required` or `failed`. The password is never in a
response.

`POST /api/login` checks the app password (scrypt-hashed in `users`) and sets an
HttpOnly `savvy_session` cookie; every other route answers 401 without one. Users
are added from the shell, never in code:

```bash
set -a && . ./.env && set +a
uv run python store.py add-user snoor
```

Running it again for an existing name resets the password and signs them out
everywhere. Each agent gets their own camofox profile, so EZLynx sessions never mix.

## Quoting over MCP

`mcp_server2.py` is a FastMCP server that quotes and requotes any EZLynx
account. It does not reimplement the rater: [`ezlynx-agent`](../ezlynx-agent)
already fills all sixteen screens through camofox, so this starts its CLI and
reports what came back. Every browser session runs as a background job — tools
return a job id immediately and `job_status` polls it — and carrier submission
is its own explicit, human-attributed step. Build the agent first —
`npm install && npm run build` in `ezlynx-agent/` — then:

```bash
set -a && . ./.env && set +a
uv run python mcp_server2.py
```

| tool | |
|---|---|
| `ezlynx_status` | credentials saved, sign-in state, code still expected |
| `ezlynx_login` | replay the stored credentials; may return `mfa_required` |
| `ezlynx_verify` | the one-time code that finishes it |
| `build_quote` | turn raw material (applicant JSON, an RCE, documents) into a validated quote — no browser |
| `get_quote_facts` / `update_quote_facts` | read or patch an account's stored quote — no browser |
| `start_quote` / `start_requote` | fill and validate the rater for an account, or a new applicant — never submits |
| `submit_quotes` | submit the stored quote to carriers, `approved_by=<human>` required |
| `job_status` / `cancel_job` | poll or stop a background run |
| `fetch_results` / `get_report` | re-poll or read an account's carrier comparison |

The frontend's composer posts to `POST /api/chat`, which is DeepSeek
([chat.py](chat.py)) holding exactly these tools — the MCP server is imported and
called in-process, not spoken to over a transport, because this is its only
client. The tools run as the signed-in user, so two agents chatting at
the same backend never touch each other's EZLynx session. Set `DEEPSEEK_API_KEY`
or the page answers that it cannot.

A reply that ran a tool says which one, under the message: submitting to carriers
is not something to discover later. No tool takes a `submit` boolean — only
`submit_quotes` reaches the carriers, and it requires `approved_by`, the name of
the human who reviewed the filled quote and said to send it. Every run refuses
regardless without `creditAuthorization.authorized`.

A successful `start_quote`/`start_requote` run's quote is kept, sealed, against
its account id, which is what lets `start_requote` take an account id and
nothing else.

Requoting moves two dates, because every recorded requote does: the effective
date goes `EZLYNX_EFFECTIVE_LEAD_DAYS` out, and a prior policy that expired over
a year ago moves to a year before it. EZLynx rejects both otherwise.

Leave `CAMOFOX_USER_ID` unset for the backend: each agent then gets its own
`ezlynx-{username}` profile, the same one the Connections-page sign-in uses,
so two agents' sessions never mix. Set it only for a standalone stdio run under
a profile that already signed in under another name.

## What is stored, and how

One SQLite row per agent in `savvy.db`. The password is sealed with AES-256-GCM
under `SAVVY_ENC_KEY` and bound to the user id, so a row copied into another name
will not decrypt. Hashing is not an option — the password has to be replayable,
which is the whole point — so the protection is that the key lives outside the
database. Lose the key and every saved password is unreadable.

The MCP server's stored quotes live in the same file and are sealed the same
way, bound to user *and* account id. They carry SSNs, DOBs and licence numbers,
so `DELETE /api/ezlynx` drops them along with the password.

`savvy.db` is gitignored. Keep it off shared disks. Serving it over ngrok is fine
now that sign-in is server-side; the session cookie is marked `Secure` when the
request arrived over https. Five wrong passwords lock a username for five minutes.

The one-time code is never written down, and no request body is ever logged.

## When EZLynx changes its login page

Every selector lives in one page-side probe in `ezlynx.py`. It tags the fields it
finds with `data-savvy` and reports which screen is up (`login`, `mfa`,
`authenticated`, `blocked`). A markup change costs a selector list, not a rewrite.
`blocked` means EZLynx showed something unhandled — a security question, a locked
account — and the message names the page title so you know what to add.
