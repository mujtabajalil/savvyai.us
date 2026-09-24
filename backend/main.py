"""Savvy backend: the EZLynx connection the frontend talks to.

Loopback by default and no CORS middleware — the Angular dev server proxies
/api here (see frontend/proxy.conf.json), so the browser only ever talks to its
own origin. Open this up and you are publishing a credential vault.

    POST   /api/login         { username, password } — sets the session cookie
    POST   /api/logout        drops it
    GET    /api/ezlynx        what the connections page renders
    POST   /api/ezlynx        { username, password } — save and log in
    POST   /api/ezlynx/mfa    { code } — finish a login that asked for one
    POST   /api/ezlynx/login  replay the stored credentials (before a run)
    DELETE /api/ezlynx        forget the credentials
    POST   /api/chat          { messages, conversationId? } — the composer, DeepSeek with the MCP tools
    GET    /api/conversations            past conversations for the sidebar (no message bodies)
    GET    /api/conversations/{id}       one conversation, in full
    DELETE /api/conversations/{id}       forget it
"""

from __future__ import annotations

import asyncio
import os
import secrets
import time
from contextlib import asynccontextmanager
from typing import Annotated, Any, Literal

import httpx
from fastapi import Cookie, Depends, FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, Field

import mcp_server2
from chat import ChatError, reply
from ezlynx import Camofox, CamofoxError, login, submit_code
from store import SESSION_DAYS, Store

EZLYNX_BASE_URL = os.environ.get("EZLYNX_BASE_URL", "https://app.ezlynx.com")
CAMOFOX_URL = os.environ.get("CAMOFOX_URL", "http://localhost:9377")
CAMOFOX_ACCESS_KEY = os.environ.get("CAMOFOX_ACCESS_KEY", "")
DB_FILE = os.environ.get("SAVVY_DB", "savvy.db")
MFA_WINDOW_S = 600
SESSION_COOKIE = "savvy_session"
# ponytail: in-memory lockout per username, lost on restart. Move to the db if that matters.
LOGIN_FAILURES_MAX = 5
LOGIN_LOCKOUT_S = 300
failed_logins: dict[str, list[float]] = {}
# A cold camofox has to launch Camoufox before the first tab exists (~46s).
CAMOFOX_TIMEOUT_S = 120

# tabId of a login parked on the code screen, per user. Lost on restart, which is correct.
awaiting_code: dict[str, tuple[str, float]] = {}
# One camofox conversation per user at a time — two would fight over the same browser session.
locks: dict[str, asyncio.Lock] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.store = Store(DB_FILE)
    async with httpx.AsyncClient(timeout=CAMOFOX_TIMEOUT_S) as client:
        app.state.http = client
        yield
    app.state.store.close()


app = FastAPI(title="savvy-backend", lifespan=lifespan)


class Credentials(BaseModel):
    username: str = Field(min_length=1, max_length=256)
    password: str = Field(min_length=1, max_length=256)


class Code(BaseModel):
    code: str = Field(min_length=1, max_length=16)


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=8000)


class Conversation(BaseModel):
    messages: list[Turn] = Field(min_length=1, max_length=100)
    conversationId: str | None = Field(default=None, max_length=64)


def _title_from(text: str) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= 40 else flat[:40].rsplit(" ", 1)[0] + "…"


class SignIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


async def current_user(savvy_session: Annotated[str | None, Cookie()] = None) -> str:
    """The session cookie is what separates one agent's EZLynx vault from another's.

    Async on purpose: a plain def runs in FastAPI's threadpool, and two threads on the one
    sqlite connection can hand each other's session lookups back — user A resolved as B.
    """
    user = app.state.store.session_user(savvy_session) if savvy_session else None
    if user is None:
        raise HTTPException(401, "Your session has ended. Sign out and sign in again.")
    return user


User = Annotated[str, Depends(current_user)]


def camofox_for(user_id: str) -> Camofox:
    return Camofox(app.state.http, CAMOFOX_URL, f"ezlynx-{user_id}", CAMOFOX_ACCESS_KEY)


def state(user_id: str, **extra: Any) -> dict[str, Any]:
    """Everything the connections page needs, and nothing the password touches."""
    pending = awaiting_code.get(user_id)
    return {
        **app.state.store.status(user_id),
        "mfaPending": bool(pending and pending[1] > time.monotonic()),
        **extra,
    }


@asynccontextmanager
async def one_at_a_time(user_id: str):
    lock = locks.setdefault(user_id, asyncio.Lock())
    if lock.locked():
        raise HTTPException(409, "A login is already running. Wait for it to finish.")
    async with lock:
        yield


async def run_login(user_id: str) -> dict[str, Any]:
    credentials = app.state.store.read(user_id)
    if credentials is None:
        raise HTTPException(409, "No EZLynx credentials are saved.")

    awaiting_code.pop(user_id, None)
    try:
        result = await login(camofox_for(user_id), EZLYNX_BASE_URL, *credentials)
    except (CamofoxError, httpx.HTTPError) as err:
        raise HTTPException(502, f"camofox is not answering: {err}") from err

    app.state.store.mark_connected(user_id, result["status"] == "connected")
    if result["status"] == "mfa_required":
        awaiting_code[user_id] = (result["tabId"], time.monotonic() + MFA_WINDOW_S)
    return state(user_id, result=result["status"], message=result.get("message"))


@app.post("/api/login")
async def sign_in(body: SignIn, request: Request, response: Response) -> dict[str, str]:
    name = body.username.strip()
    now = time.monotonic()
    recent = [t for t in failed_logins.get(name, []) if now - t < LOGIN_LOCKOUT_S]
    if len(recent) >= LOGIN_FAILURES_MAX:
        raise HTTPException(429, "Too many wrong passwords. Wait five minutes and try again.")
    if not app.state.store.check_password(name, body.password):
        failed_logins[name] = [*recent, now]
        raise HTTPException(401, "That username and password do not match.")
    failed_logins.pop(name, None)
    response.set_cookie(
        SESSION_COOKIE,
        app.state.store.create_session(name),
        max_age=SESSION_DAYS * 86400,
        httponly=True,
        samesite="lax",
        # ngrok terminates TLS and forwards plain http, saying so in this header.
        secure=request.headers.get("x-forwarded-proto", request.url.scheme) == "https",
    )
    return {"username": name}


@app.post("/api/logout")
async def sign_out(response: Response, savvy_session: Annotated[str | None, Cookie()] = None) -> dict[str, str]:
    if savvy_session:
        app.state.store.drop_session(savvy_session)
    response.delete_cookie(SESSION_COOKIE)
    return {"status": "signed out"}


@app.get("/api/ezlynx")
async def read_connection(user: User) -> dict[str, Any]:
    return state(user)


@app.post("/api/ezlynx")
async def connect(credentials: Credentials, user: User) -> dict[str, Any]:
    async with one_at_a_time(user):
        app.state.store.save(user, credentials.username.strip(), credentials.password)
        return await run_login(user)


@app.post("/api/ezlynx/login")
async def reconnect(user: User) -> dict[str, Any]:
    """Log in again with what is already stored. No code, unless EZLynx forgot the device."""
    async with one_at_a_time(user):
        return await run_login(user)


@app.post("/api/ezlynx/mfa")
async def finish_mfa(body: Code, user: User) -> dict[str, Any]:
    async with one_at_a_time(user):
        pending = awaiting_code.pop(user, None)
        if pending is None or pending[1] < time.monotonic():
            raise HTTPException(409, "That login expired. Save the credentials again to start over.")
        try:
            result = await submit_code(camofox_for(user), pending[0], body.code.strip())
        except (CamofoxError, httpx.HTTPError) as err:
            raise HTTPException(502, f"camofox is not answering: {err}") from err

        app.state.store.mark_connected(user, result["status"] == "connected")
        return state(user, result=result["status"], message=result.get("message"))


@app.post("/api/chat")
async def chat(conversation: Conversation, user: User) -> dict[str, Any]:
    """One assistant turn. The tools it may reach are the MCP server's, run as this user.

    Quoting tools return a job id and poll rather than block, so this call
    itself stays fast even while a browser run is still going in the background.
    """
    # Contextvars copy into this request's task, so the tools see the caller's id
    # and not whoever asked last.
    mcp_server2.USER.set(user)
    history = [turn.model_dump() for turn in conversation.messages]
    conversation_id = conversation.conversationId or f"c-{secrets.token_hex(8)}"
    title = _title_from(history[0]["content"]) if history else "New chat"
    # Saved before the model runs, so a turn that errors still exists server-side. The
    # browser cache is wiped on sign-out; a chat held only there is lost with it.
    try:
        app.state.store.save_conversation(user, conversation_id, title, history)
    except PermissionError:
        raise HTTPException(404, "No conversation with that id.") from None
    try:
        result = await reply(app.state.http, history)
    except ChatError as err:
        raise HTTPException(502, str(err)) from err
    except httpx.HTTPError as err:
        raise HTTPException(502, f"DeepSeek is not answering: {err}") from err

    full = [*history, {"role": "assistant", "content": result["reply"]}]
    app.state.store.save_conversation(user, conversation_id, title, full)
    return {**result, "conversationId": conversation_id}


@app.get("/api/conversations")
async def list_conversations(user: User) -> list[dict[str, Any]]:
    return app.state.store.list_conversations(user)


@app.get("/api/conversations/{conversation_id}")
async def read_conversation_endpoint(conversation_id: str, user: User) -> dict[str, Any]:
    found = app.state.store.read_conversation(user, conversation_id)
    if found is None:
        raise HTTPException(404, "No conversation with that id.")
    return found


@app.delete("/api/conversations/{conversation_id}")
async def delete_conversation_endpoint(conversation_id: str, user: User) -> dict[str, str]:
    app.state.store.delete_conversation(user, conversation_id)
    return {"status": "deleted"}


@app.delete("/api/ezlynx")
async def forget(user: User) -> dict[str, Any]:
    awaiting_code.pop(user, None)
    app.state.store.forget(user)
    return state(user)
