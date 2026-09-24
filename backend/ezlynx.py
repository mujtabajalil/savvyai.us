"""EZLynx login, driven through camofox.

One page-side probe decides which screen is up (credentials, one-time code, or
already in) and tags the fields it found with `data-savvy`, so acting on them is
a plain CSS selector away. When EZLynx changes its markup the fix is a selector
list here, not a rewrite.

The one-time code is needed once per browser profile: EZLynx sets a device-trust
cookie, camofox's persistence plugin checkpoints it when the session is
destroyed, and later logins replay username + password alone. Later still they
skip the login page altogether — which is why this starts at the dashboard URL
and lets EZLynx decide whether to redirect to login.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any
from urllib.parse import quote

import httpx

# Runs in the page. Self-contained expression: camofox evaluates it and awaits the result.
PROBE = r"""(() => {
  const visible = (el) => !!el && !el.disabled && el.getClientRects().length > 0;
  const first = (selectors) => {
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) if (visible(el)) return el;
    }
    return null;
  };
  const mark = (el, name) => {
    if (!el) return null;
    el.setAttribute('data-savvy', name);
    return '[data-savvy="' + name + '"]';
  };
  const submit = () => mark(first(['button[type="submit"]', 'input[type="submit"]', 'button']), 'submit');

  for (const el of document.querySelectorAll('[data-savvy]')) el.removeAttribute('data-savvy');

  const title = document.title || '';
  const body = document.body ? document.body.innerText || '' : '';
  const error = Array.from(document.querySelectorAll(
    'mat-error, .mat-error, [role="alert"], .alert-danger, .field-validation-error, .validation-summary-errors'
  )).filter(visible).map((el) => (el.innerText || '').trim()).filter(Boolean)[0] || null;

  const password = first(['input[type="password"]']);
  if (password) {
    return {
      phase: 'login', title, error,
      username: mark(first([
        'input[autocomplete="username"]', 'input[type="email"]',
        'input[name*="user" i]', 'input[id*="user" i]', 'input[name*="email" i]',
        'input[type="text"]',
      ]), 'username'),
      password: mark(password, 'password'),
      submit: submit(),
    };
  }

  // EZLynx asks where to send the code before it shows the box. One option, still a screen.
  const twoFactor = /TwoFactorVerification/i.test(location.pathname) || /where you would like to receive the code/i.test(body);
  const radios = twoFactor ? Array.from(document.querySelectorAll('input[type="radio"]')).filter(visible) : [];
  if (radios.length) {
    const chosen = radios.find((el) => el.checked) || radios[0];
    return {
      phase: 'mfa-choice', title, error,
      option: chosen.checked ? null : mark(chosen.closest('mat-radio-button') || chosen, 'option'),
      submit: submit(),
    };
  }

  const wantsCode = /verification code|security code|one-?time|authentication code|passcode|two-?factor|multi-?factor|we (sent|texted|emailed)/i.test(body);
  const code = first([
    'input[autocomplete="one-time-code"]', 'input[name*="code" i]', 'input[id*="code" i]',
    'input[name*="otp" i]', 'input[type="tel"]', 'input[type="text"]',
  ]);
  if (wantsCode && code) {
    const remember = Array.from(document.querySelectorAll('input[type="checkbox"], mat-checkbox'))
      .filter(visible)
      .find((el) => /remember|trust|do not ask|don.t ask/i.test(
        ((el.closest('label') || el.parentElement || el).innerText || '') + ' ' + (el.name || '') + ' ' + (el.id || '')
      ));
    const ticked = (el) => !!el && (el.type === 'checkbox' ? el.checked : (el.querySelector('input') || {}).checked === true);
    return {
      phase: 'mfa', title, error, code: mark(code, 'code'),
      // Material hides the real input under the wrapper, so the wrapper takes the click.
      remember: mark(remember && (remember.closest('mat-checkbox') || remember), 'remember'),
      rememberChecked: ticked(remember),
      submit: submit(),
    };
  }

  // A username-only first step (no password rendered yet) still counts as login.
  const username = first([
    'input[autocomplete="username"]', 'input[type="email"]',
    'input[name*="user" i]', 'input[id*="user" i]', 'input[name*="email" i]',
  ]);
  const onAuthPage = /\/auth\//i.test(location.pathname);
  if (onAuthPage && username) {
    return { phase: 'login', title, error, username: mark(username, 'username'), password: null, submit: submit() };
  }

  // Cloudflare sits in front of EZLynx. Its block and challenge pages have no password
  // field and no /auth/ in the path, so without this they read as a successful login.
  if (/just a moment|attention required|you have been blocked|checking your browser|enable javascript and cookies/i.test(title + ' ' + body)
      || document.querySelector('#challenge-form, #cf-challenge-running, #cf-wrapper, [data-translate="checking_browser"]')) {
    return { phase: 'blocked', title, error: 'Cloudflare is challenging the browser, not EZLynx.' };
  }

  // Signed in means the app shell, not merely "not the login page".
  return { phase: /^\/web\//i.test(location.pathname) ? 'authenticated' : 'blocked', title, error };
})()"""


class Camofox:
    """The camofox REST calls this file needs. Nothing else."""

    def __init__(self, client: httpx.AsyncClient, base_url: str, user_id: str,
                 access_key: str = "", session_key: str = "ezlynx") -> None:
        self._client = client
        self._root = base_url.rstrip("/")
        self._user_id = user_id
        self._session_key = session_key
        self._headers = {"authorization": f"Bearer {access_key}"} if access_key else {}

    async def _call(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        response = await self._client.request(
            method, f"{self._root}{path}", json=body, headers=self._headers
        )
        try:
            payload = response.json() if response.content else {}
        except ValueError:  # an HTML error page from a proxy in front of camofox
            payload = {}
            if not response.is_error:
                raise CamofoxError(f"camofox {method} {path} answered with something that is not JSON") from None
        if response.is_error:
            raise CamofoxError(payload.get("error") or f"camofox {method} {path} failed ({response.status_code})")
        return payload

    def _tab(self, tab_id: str, suffix: str = "") -> str:
        return f"/tabs/{quote(tab_id, safe='')}{suffix}"

    async def open_tab(self, url: str) -> str:
        created = await self._call("POST", "/tabs", {"userId": self._user_id, "sessionKey": self._session_key, "url": url})
        return created["tabId"]

    async def close_tab(self, tab_id: str) -> None:
        await self._call("DELETE", self._tab(tab_id, f"?userId={quote(self._user_id, safe='')}"))

    async def wait(self, tab_id: str, timeout_ms: int = 20_000) -> None:
        await self._call("POST", self._tab(tab_id, "/wait"), {"userId": self._user_id, "timeout": timeout_ms})

    async def probe(self, tab_id: str) -> dict[str, Any]:
        done = await self._call("POST", self._tab(tab_id, "/evaluate"), {"userId": self._user_id, "expression": PROBE})
        return done["result"]

    async def type(self, tab_id: str, selector: str, text: str) -> None:
        await self._call("POST", self._tab(tab_id, "/type"),
                         {"userId": self._user_id, "selector": selector, "text": text, "clear": True})

    async def click(self, tab_id: str, selector: str) -> None:
        await self._call("POST", self._tab(tab_id, "/click"), {"userId": self._user_id, "selector": selector})

    async def checkpoint(self) -> None:
        """Destroying the session is what makes the persistence plugin write the cookies to disk."""
        await self._call("DELETE", f"/sessions/{quote(self._user_id, safe='')}")


class CamofoxError(RuntimeError):
    pass


async def _quietly(coro) -> None:
    try:
        await coro
    except Exception:  # noqa: BLE001 - cleanup must not mask the real failure
        pass


async def _settle(cf: Camofox, tab_id: str, leaving: str, timeout_s: float = 25.0) -> dict[str, Any]:
    """Poll until the screen is no longer `leaving`, or the page reports an error."""
    deadline = time.monotonic() + timeout_s
    state = await cf.probe(tab_id)
    while time.monotonic() < deadline and state["phase"] == leaving and not state.get("error"):
        await asyncio.sleep(1.0)
        state = await cf.probe(tab_id)
    return state


async def _finish(cf: Camofox, tab_id: str) -> dict[str, Any]:
    await _quietly(cf.close_tab(tab_id))
    await cf.checkpoint()
    return {"status": "connected"}


async def login(cf: Camofox, base_url: str, username: str, password: str) -> dict[str, Any]:
    """Open EZLynx and get as far as the credentials allow.

    Returns `connected` (the persisted session was still good, or the password
    was enough), `mfa_required` with the tab left open for the code, or `failed`.
    """
    tab_id = await cf.open_tab(f"{base_url.rstrip('/')}/web/dashboard")
    try:
        await _quietly(cf.wait(tab_id))
        state = await _settle(cf, tab_id, "blocked")
        typed_username = typed_password = False

        # Rounds, not recursion: username, then password, then "where do we send the code".
        for _ in range(6):
            if state["phase"] == "authenticated":
                return await _finish(cf, tab_id)
            if state["phase"] == "mfa":
                return {"status": "mfa_required", "tabId": tab_id}
            if state["phase"] == "mfa-choice":
                # Sending the code is the point of the click, so no confirmation here.
                if state.get("option"):
                    await cf.click(tab_id, state["option"])
                if state.get("submit"):
                    await cf.click(tab_id, state["submit"])
                await _quietly(cf.wait(tab_id))
                state = await _settle(cf, tab_id, "mfa-choice")
                continue
            if state["phase"] != "login":
                await _quietly(cf.close_tab(tab_id))
                return {"status": "failed",
                        "message": state.get("error") or f"EZLynx showed a screen this does not handle: {state['title']}"}

            typed = False
            if state.get("username") and not typed_username:
                await cf.type(tab_id, state["username"], username)
                typed = typed_username = True
            if state.get("password") and not typed_password:
                await cf.type(tab_id, state["password"], password)
                typed = typed_password = True
            if not typed:
                # Same form, nothing left to fill: EZLynx rejected what it was given.
                await _quietly(cf.close_tab(tab_id))
                return {"status": "failed",
                        "message": state.get("error") or "EZLynx did not accept that username and password."}

            if state.get("submit"):
                await cf.click(tab_id, state["submit"])
            await _quietly(cf.wait(tab_id))
            state = await _settle(cf, tab_id, "login")

        await _quietly(cf.close_tab(tab_id))
        return {"status": "failed", "message": "Login did not complete."}
    except Exception:
        await _quietly(cf.close_tab(tab_id))
        raise


async def submit_code(cf: Camofox, tab_id: str, code: str) -> dict[str, Any]:
    """Type the one-time code into the tab `login` left open. The code is never stored."""
    state = await cf.probe(tab_id)
    if state["phase"] == "authenticated":
        return await _finish(cf, tab_id)
    if state["phase"] != "mfa":
        return {"status": "failed",
                "message": state.get("error") or "EZLynx is no longer asking for a code. Start again."}

    # "Trust this computer" is what buys the codeless logins afterwards, and EZLynx
    # ships it ticked — clicking it again would turn it off.
    if state.get("remember") and not state.get("rememberChecked"):
        await _quietly(cf.click(tab_id, state["remember"]))
    await cf.type(tab_id, state["code"], code)
    if state.get("submit"):
        await cf.click(tab_id, state["submit"])
    await _quietly(cf.wait(tab_id))

    state = await _settle(cf, tab_id, "mfa")
    if state["phase"] == "authenticated":
        return await _finish(cf, tab_id)
    return {"status": "failed", "message": state.get("error") or "EZLynx did not accept that code."}
