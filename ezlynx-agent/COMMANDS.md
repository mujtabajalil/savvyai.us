# Commands (cmd.exe)

Connect the VPN first. Two terminals: **A** = server (leave running), **B** = agent.

## A — start server (headless, for automation)

```cmd
cd /d c:\Users\absir\Desktop\SAVV\camofox-browser && set "CAMOFOX_INTERACTIVE=off" && set "CAMOFOX_CRASH_REPORT_ENABLED=false" && set "HANDLER_TIMEOUT_MS=90000" && npm start
```

`HANDLER_TIMEOUT_MS` must exceed `newPageTimeoutMs` (45s in `camofox.config.json`);
at the 30s default the request aborts while the page is still opening.

## B — check session

```cmd
cd /d c:\Users\absir\Desktop\SAVV\camofox-browser\ezlynx-agent && node --env-file=.env dist/src/cli.js login --check
```

Valid → skip to Run. Expired → do Login.

## Login (only when expired)

Restart **A** in desktop mode:

```cmd
cd /d c:\Users\absir\Desktop\SAVV\camofox-browser && set "CAMOFOX_INTERACTIVE=desktop" && set "CAMOFOX_CRASH_REPORT_ENABLED=false" && set "HANDLER_TIMEOUT_MS=90000" && npm start
```

Then **B** (a window opens; it waits for you — password only, no MFA):

```cmd
cd /d c:\Users\absir\Desktop\SAVV\camofox-browser\ezlynx-agent && node --env-file=.env dist/src/cli.js login
```

Then restart **A** headless (first command). Desktop mode can't automate on Windows.

## Run

```cmd
cd /d c:\Users\absir\Desktop\SAVV\camofox-browser\ezlynx-agent && node --env-file=.env dist/src/cli.js run --create --quote ./quote.json --lob auto,home --dry-run
```

| Variant | Change |
|---|---|
| Existing account | `--account 123456789` instead of `--create` |
| Auto only | `--lob auto` |
| Real submit | drop `--dry-run` (prompts before submitting) |

`--dry-run` never submits to carriers, but **does** create a real applicant record.

## Other

```cmd
:: build + test
cd /d c:\Users\absir\Desktop\SAVV\camofox-browser\ezlynx-agent && npm test

:: quote file from example
copy examples\test-applicant.json quote.json

:: capture a screen's selectors
node --env-file=.env dist/src/cli.js --help
node --env-file=.env dist/scripts/discover-screen.js --url "<url>" --out discovery/name.json

:: test one dropdown
node --env-file=.env dist/scripts/spike-matselect.js --url "<url>" --selector "#applicant-gender"

:: parse existing results
node --env-file=.env dist/src/cli.js results --url "<quote-results-url>"
```

## Stop / cleanup

Ctrl+C in **A**, answer `Y`. Then:

```cmd
tasklist | findstr /i camoufox
taskkill /F /IM camoufox.exe /T
```

---

## Watch it live (Docker + noVNC)

Runs the browser on a virtual screen inside a container. You watch it in a browser
tab and can alt-tab and use your machine normally — host window focus is
irrelevant, which is what makes `CAMOFOX_INTERACTIVE=desktop` unusable for
automation on Windows.

Needs **Docker Desktop running**. First build takes several minutes (it downloads
the browser); afterwards it is seconds.

```cmd
:: start the container (run from ezlynx-agent)
cd /d c:\Users\absir\Desktop\SAVV\camofox-browser\ezlynx-agent && docker compose up -d --build

:: open a tab so the screen has something on it, and check the session
node --env-file=.env dist/scripts/watch.js
```

Then open **http://localhost:6080/vnc.html** in any browser.

- **First time:** log into EZLynx *inside* that noVNC window — you can click and
  type in it. No more desktop/headless restart dance. The session is saved to a
  Docker volume and survives restarts.
- **Then:** start a run in another terminal and watch every field fill in.

```cmd
node --env-file=.env dist/src/cli.js run --create --quote ./quote.json --lob auto,home --dry-run
```

Stop / logs:

```cmd
docker compose logs -f camofox
docker compose down
```

`docker compose down` keeps the saved session (named volume). To wipe it and log
in fresh: `docker compose down -v`.

**Ports are bound to 127.0.0.1 on purpose.** noVNC has no password by default and
the browser holds client PII — do not change them to `0.0.0.0` without setting
`VNC_PASSWORD`.

When the container is running you do not need the local `npm start` server. Both
listen on 9377, so run one or the other, not both.

## Gotchas

- Node must be **22+** (`node --version`) — camoufox segfaults on 20.
- `npm start` alone shows **no window**; one appears only when a tab is created.
- Use full paths like `/web/account/...` — the bare domain is Cloudflare-blocked.
- 403 "Unauthorized Access" = that EZLynx user can't open that account.
- `DeepSeek HTTP 401` = bad `DEEPSEEK_API_KEY`. It is optional — without it the
  agent uses deterministic rules and asks you about anything it cannot resolve.
- Connect the **VPN** before running; EZLynx sessions appear expired without it.
- **Nothing at localhost:6080?** Check `docker compose logs camofox | findstr vnc-watcher`.
  `/usr/share/novnc not found` means the VNC packages never installed. That was a
  CRLF checkout of `plugins/*/apt.txt` handing apt `x11vnc\r` — fixed in
  `.gitattributes`, but it needs `docker compose up -d --build` to take effect.
  Healthy looks like `Starting noVNC (websockify)` + `Attaching x11vnc to DISPLAY=:0`;
  `curl http://localhost:9377/vnc/status` should report `"running":true`.
