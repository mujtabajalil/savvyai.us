"""EZLynx quoting over MCP.

Five tools: sign in, finish a one-time code, quote, requote, and say where the
session stands. The quoting itself is not reimplemented here — `ezlynx-agent`
already fills the comparative rater through camofox, so this starts its CLI and
reports what came back. Everything that touches EZLynx goes through the camofox
browser, this process only spawns and reads.

    uv run python mcp_server.py          # stdio, for an MCP client

Over stdio that is one operator, picked by SAVVY_USER. Served through the
backend's /api/chat the caller's own id is used instead, so one process can hold
several agents' EZLynx sessions without mixing them.
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import os
import re
import tempfile
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
from fastmcp import FastMCP
from fastmcp.exceptions import ToolError

from ezlynx import Camofox, CamofoxError, login, submit_code
from store import Store

# Whose stored credentials and quotes a tool call uses. The env var is the
# default for a plain stdio server; the chat endpoint sets it per request, so one
# backend can serve several agents without their EZLynx sessions mixing.
USER: contextvars.ContextVar[str] = contextvars.ContextVar(
    "savvy_user", default=os.environ.get("SAVVY_USER", "default")[:64]
)
EZLYNX_BASE_URL = os.environ.get("EZLYNX_BASE_URL", "https://app.ezlynx.com")
CAMOFOX_URL = os.environ.get("CAMOFOX_URL", "http://localhost:9377")
CAMOFOX_ACCESS_KEY = os.environ.get("CAMOFOX_ACCESS_KEY", "")
# The persisted browser profile is keyed by this, so the tab the agent opens is
# only signed in if it matches the one that signed in. Same default as the agent.
CAMOFOX_USER_ID = os.environ.get("CAMOFOX_USER_ID", "ezlynx-agent")
DB_FILE = os.environ.get("SAVVY_DB", "savvy.db")
AGENT_DIR = Path(os.environ.get("EZLYNX_AGENT_DIR", Path(__file__).resolve().parent.parent / "ezlynx-agent"))
# A full Auto + Home run fills ~16 screens in a real browser.
RUN_TIMEOUT_S = float(os.environ.get("EZLYNX_RUN_TIMEOUT_S", 1800))
# How far ahead a requote dates the new policy when the caller does not say.
EFFECTIVE_LEAD_DAYS = int(os.environ.get("EZLYNX_EFFECTIVE_LEAD_DAYS", 30))
MFA_WINDOW_S = 600
CAMOFOX_TIMEOUT_S = 120

DATE_FORMAT = "%m/%d/%Y"
REPORT_LINE = re.compile(r"^Wrote (.+\.json)$", re.M)
ACCOUNT_ID = re.compile(r"^\d+$")
# Exit codes the agent CLI uses; anything else is an ordinary failure.
EXIT_HELP = {
    2: "The quote was rejected before the browser opened — fix the fields it names and try again.",
    3: f"camofox is not running at {CAMOFOX_URL}.",
    4: "The saved EZLynx session has expired. Call ezlynx_login first.",
    5: "That EZLynx user cannot open this account.",
}

mcp = FastMCP("ezlynx")
store = Store(DB_FILE)
# One camofox conversation at a time: two would fight over the same browser session.
busy = asyncio.Lock()
# tabId of a sign-in parked on the code screen, per user. Lost on restart, correctly.
awaiting_code: dict[str, tuple[str, float]] = {}


def _camofox(client: httpx.AsyncClient) -> Camofox:
    # sessionKey "default" is the agent's, so a login here leaves the session the
    # agent will pick up rather than a second one beside it.
    return Camofox(client, CAMOFOX_URL, CAMOFOX_USER_ID, CAMOFOX_ACCESS_KEY, session_key="default")


def _held() -> None:
    if busy.locked():
        raise ToolError("An EZLynx run is already going. Wait for it to finish.")


async def _agent(args: list[str], timeout_s: float) -> tuple[int, str]:
    """Run the ezlynx-agent CLI and hand back its exit code and output."""
    cli = AGENT_DIR / "dist" / "src" / "cli.js"
    if not cli.exists():
        raise ToolError(f"ezlynx-agent is not built. Run `npm install && npm run build` in {AGENT_DIR}.")

    command = ["node"]
    env_file = AGENT_DIR / ".env"
    if env_file.exists():
        command.append(f"--env-file={env_file}")
    command += [str(cli), *args]

    # Real environment beats --env-file in Node, so these win over the agent's file.
    env = {
        **os.environ,
        "CAMOFOX_URL": CAMOFOX_URL,
        "CAMOFOX_ACCESS_KEY": CAMOFOX_ACCESS_KEY,
        "CAMOFOX_USER_ID": CAMOFOX_USER_ID,
        "EZLYNX_BASE_URL": EZLYNX_BASE_URL,
        "CAMOFOX_CRASH_REPORT_ENABLED": "false",
        # Nobody is at a terminal. The tool's own `submit` argument is the
        # confirmation, and the agent still refuses without credit authorisation.
        "REQUIRE_SUBMIT_CONFIRMATION": "false",
    }

    process = await asyncio.create_subprocess_exec(
        *command,
        cwd=AGENT_DIR,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        env=env,
    )
    try:
        output, _ = await asyncio.wait_for(process.communicate(), timeout=timeout_s)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()
        raise ToolError(
            f"The run passed {timeout_s:.0f}s and was stopped. EZLynx may hold a half-filled quote — "
            "open the account before running again."
        ) from None
    return process.returncode or 0, output.decode(errors="replace")


def _report(output: str) -> dict[str, Any] | None:
    """The CLI prints the path it wrote; the JSON beside it is the quote comparison."""
    for path in REPORT_LINE.findall(output):
        file = Path(path)
        if file.is_file():
            return json.loads(file.read_text())
    return None


async def _run(account_id: str | None, quote: dict[str, Any], lines: str, submit: bool) -> dict[str, Any]:
    if account_id is not None and not ACCOUNT_ID.fullmatch(account_id):
        raise ToolError("An EZLynx account id is digits only.")

    lobs = ",".join(part for part in (p.strip().lower() for p in lines.split(",")) if part in ("auto", "home"))
    if not lobs:
        raise ToolError('lines must be "auto", "home", or "auto,home".')

    # The quote holds SSNs and licence numbers: 0600, and gone when the run ends.
    handle, path = tempfile.mkstemp(prefix="ezlynx-quote-", suffix=".json")
    try:
        with os.fdopen(handle, "w") as file:
            json.dump(quote, file)
        args = ["run", "--quote", path, "--lob", lobs]
        args += ["--account", account_id] if account_id else ["--create"]
        if not submit:
            args.append("--dry-run")
        code, output = await _agent(args, RUN_TIMEOUT_S)
    finally:
        os.unlink(path)

    created = re.search(r"Created applicant — account (\d+)", output)
    account = account_id or (created.group(1) if created else None)
    # Only a run that finished is worth requoting from; a rejected quote would
    # come back as the stored one and fail again.
    if account and code == 0:
        store.save_quote(USER.get(), account, quote)

    result: dict[str, Any] = {
        "ok": code == 0,
        "accountId": account,
        "lines": lobs,
        "submitted": submit and code == 0,
        "log": output.strip(),
    }
    if code != 0:
        result["error"] = EXIT_HELP.get(code, "The run did not finish — the log says where it stopped.")
    report = _report(output)
    if report is not None:
        result["report"] = report
    return result


def _parse(value: Any) -> date | None:
    try:
        return datetime.strptime(str(value), DATE_FORMAT).date()
    except (TypeError, ValueError):
        return None


def _a_year_before(day: date) -> date:
    try:
        return day.replace(year=day.year - 1)
    except ValueError:  # 29 February
        return day - timedelta(days=365)


def _roll_dates(quote: dict[str, Any], effective_date: str | None) -> dict[str, Any]:
    """Move the two dates EZLynx refuses to rate on.

    Every recorded requote starts the same way: the effective date is in the past
    and the prior policy expired more than a year ago, so EZLynx rejects both
    before a carrier is ever asked. The operators retype them; this does the same.
    A prior policy that is still running is left alone — that is a rewrite, and
    its expiration is the date the new policy should start.
    """
    today = date.today()
    if effective_date is not None and _parse(effective_date) is None:
        raise ToolError("effective_date must look like 03/01/2027.")
    effective = _parse(effective_date) or today + timedelta(days=EFFECTIVE_LEAD_DAYS)
    if effective <= today:
        raise ToolError("effective_date is in the past; EZLynx will not rate it.")

    rolled = {**quote, "effectiveDate": effective.strftime(DATE_FORMAT)}
    # ponytail: a month of margin under EZLynx's 1-year cutoff, not a read of its
    # exact boundary. Tighten if a requote ever comes back rejected on this field.
    stale = today - timedelta(days=330)
    for key in ("priorAuto", "priorHome"):
        prior = rolled.get(key)
        if not isinstance(prior, dict):
            continue
        expiration = _parse(prior.get("expirationDate"))
        if expiration is None or expiration < stale:
            rolled[key] = {**prior, "expirationDate": _a_year_before(effective).strftime(DATE_FORMAT)}
    return rolled


@mcp.tool
async def ezlynx_status() -> dict[str, Any]:
    """Whether EZLynx credentials are saved, whether the last sign-in worked, and
    whether a one-time code is still expected."""
    parked = awaiting_code.get(USER.get())
    pending = parked is not None and parked[1] > time.monotonic()
    return {**store.status(USER.get()), "mfaPending": pending, "user": USER.get(), "camofoxUserId": CAMOFOX_USER_ID}


@mcp.tool
async def ezlynx_login() -> dict[str, Any]:
    """Sign in to EZLynx with the credentials already saved (the Connections page
    saves them; this never takes a password).

    Returns `connected`, or `mfa_required` when EZLynx wants a one-time code —
    call ezlynx_verify with it. After the first code the device is trusted and
    later sign-ins replay the credentials alone.
    """
    _held()
    credentials = store.read(USER.get())
    if credentials is None:
        raise ToolError(f"No EZLynx credentials are saved for '{USER.get()}'. Save them on the Connections page first.")

    async with busy:
        awaiting_code.pop(USER.get(), None)
        async with httpx.AsyncClient(timeout=CAMOFOX_TIMEOUT_S) as client:
            try:
                result = await login(_camofox(client), EZLYNX_BASE_URL, *credentials)
            except (CamofoxError, httpx.HTTPError) as err:
                raise ToolError(f"camofox is not answering: {err}") from err

        store.mark_connected(USER.get(), result["status"] == "connected")
        if result["status"] == "mfa_required":
            awaiting_code[USER.get()] = (result["tabId"], time.monotonic() + MFA_WINDOW_S)
        return {"result": result["status"], "message": result.get("message")}


@mcp.tool
async def ezlynx_verify(code: str) -> dict[str, Any]:
    """Finish a sign-in that asked for a one-time code. The code is never stored."""
    _held()
    async with busy:
        pending = awaiting_code.pop(USER.get(), None)
        if pending is None or pending[1] < time.monotonic():
            raise ToolError("That sign-in expired. Call ezlynx_login again.")
        async with httpx.AsyncClient(timeout=CAMOFOX_TIMEOUT_S) as client:
            try:
                result = await submit_code(_camofox(client), pending[0], code.strip())
            except (CamofoxError, httpx.HTTPError) as err:
                raise ToolError(f"camofox is not answering: {err}") from err

        store.mark_connected(USER.get(), result["status"] == "connected")
        return {"result": result["status"], "message": result.get("message")}


@mcp.tool
async def quote(
    quote: dict[str, Any],
    account_id: str | None = None,
    lines: str = "auto,home",
    submit: bool = False,
) -> dict[str, Any]:
    """Quote an EZLynx account: fill the comparative rater and, if asked, send it
    to the carriers.

    `quote` is the agent's quote JSON — applicant, address, drivers, vehicles,
    dwelling, prior policies, carrier selection and creditAuthorization. See
    ezlynx-agent/examples/test-applicant.json.

    `account_id` quotes an existing applicant; leave it out to create a new
    Personal Lines applicant and use the id that comes back.

    `submit` is the carrier submission, and it is real: it can trigger credit and
    underwriting reports on the applicant, so leave it false to fill and validate
    every screen without submitting. The run refuses either way unless
    creditAuthorization.authorized is true.

    The quote is kept, sealed, against the account id so requote needs only that.
    """
    _held()
    async with busy:
        return await _run(account_id, quote, lines, submit)


@mcp.tool
async def requote(
    account_id: str,
    effective_date: str | None = None,
    quote: dict[str, Any] | None = None,
    lines: str = "auto,home",
    submit: bool = False,
) -> dict[str, Any]:
    """Requote an account: run the rater again on the last quote with the dates
    moved forward.

    `effective_date` is mm/dd/yyyy and must be in the future; without it the new
    policy starts EZLYNX_EFFECTIVE_LEAD_DAYS out. A prior policy that expired
    over a year ago is moved to a year before the effective date — that is the
    edit every recorded requote makes, and EZLynx will not rate without it.

    `quote` replaces the stored one, and is required for an account this server
    has never quoted. `submit` carries the same weight as in `quote`.
    """
    _held()
    if quote is None:
        quote = store.read_quote(USER.get(), account_id)
        if quote is None:
            raise ToolError(
                f"No stored quote for account {account_id}. Pass `quote` with the applicant's details."
            )
    async with busy:
        return await _run(account_id, _roll_dates(quote, effective_date), lines, submit)


if __name__ == "__main__":
    mcp.run()
