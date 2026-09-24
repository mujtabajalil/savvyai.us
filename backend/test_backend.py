"""The two things worth checking: the password never lands in the file readable,
and the one-time code is asked for once and never again.

    uv run pytest
"""

import os
import tempfile

os.environ.setdefault("SAVVY_ENC_KEY", "0" * 64)  # test key
os.environ["SAVVY_DB"] = os.path.join(tempfile.mkdtemp(), "test.db")

import pytest
from fastapi.testclient import TestClient

import main
from store import Store

USERNAME = '[data-savvy="username"]'
PASSWORD = '[data-savvy="password"]'
CODE = '[data-savvy="code"]'
SUBMIT = '[data-savvy="submit"]'
REMEMBER = '[data-savvy="remember"]'


def signed_in(client, name="agent-a"):
    """Create the user if needed and sign the test client in; the cookie rides along after."""
    main.app.state.store.add_user(name, "correct horse")
    assert client.post("/api/login", json={"username": name, "password": "correct horse"}).status_code == 200
    return client


def test_only_a_signed_in_session_reaches_the_api():
    with TestClient(main.app) as client:
        assert client.get("/api/ezlynx").status_code == 401
        # A header naming someone is not a sign-in any more.
        assert client.get("/api/conversations", headers={"x-savvy-user": "agent-a"}).status_code == 401

        main.app.state.store.add_user("agent-a", "correct horse")
        assert client.post("/api/login", json={"username": "agent-a", "password": "nope"}).status_code == 401
        assert client.post("/api/login", json={"username": "ghost", "password": "correct horse"}).status_code == 401
        with pytest.raises(ValueError):
            main.app.state.store.add_user("agent-a", "123")  # too short

        signed_in(client)
        assert client.get("/api/ezlynx").status_code == 200
        # The db holds the token's hash, never the token.
        token = client.cookies["savvy_session"]
        assert main.app.state.store._db.execute(
            "SELECT 1 FROM sessions WHERE token_hash = ?", (token,)
        ).fetchone() is None

        client.post("/api/logout")
        client.cookies.set("savvy_session", token)  # replaying the old cookie
        assert client.get("/api/ezlynx").status_code == 401

        for _ in range(main.LOGIN_FAILURES_MAX):
            client.post("/api/login", json={"username": "agent-a", "password": "nope"})
        locked = client.post("/api/login", json={"username": "agent-a", "password": "correct horse"})
        assert locked.status_code == 429
    main.failed_logins.clear()


def test_session_lookup_stays_on_the_event_loop():
    """A sync dependency runs in the threadpool, where two users' lookups on the one sqlite
    connection can swap results. Keep it async."""
    import inspect

    assert inspect.iscoroutinefunction(main.current_user)


def test_password_is_sealed_to_its_user(tmp_path):
    db = tmp_path / "s.db"
    store = Store(str(db), key=bytes(32))
    store.save("agent-a", "a@agency.com", "hunter2")

    assert store.read("agent-a") == ("a@agency.com", "hunter2")
    assert b"hunter2" not in db.read_bytes()
    assert store.status("agent-a")["connected"] is False
    store.mark_connected("agent-a")
    assert store.status("agent-a")["connected"] is True

    # The row is bound to its user id, so copying it into another name breaks the seal.
    sealed = store._db.execute("SELECT password FROM ezlynx_credentials").fetchone()["password"]
    store._db.execute(
        "INSERT INTO ezlynx_credentials VALUES ('agent-b', 'a@agency.com', ?, NULL, 'now')", (sealed,)
    )
    with pytest.raises(Exception):
        store.read("agent-b")


class FakeEzlynx:
    """The four screens EZLynx shows, in order, with its defaults.

    "Trust this computer" arrives ticked — a fake that starts it unticked would
    hide the bug where clicking it turns device trust off.
    """

    def __init__(self, phase="login"):
        self.phase = phase
        self.typed = {}
        self.checkpoints = 0
        self.remember_checked = True

    async def open_tab(self, url):
        return "tab-1"

    async def close_tab(self, tab_id):
        pass

    async def wait(self, tab_id, timeout_ms=0):
        pass

    async def checkpoint(self):
        self.checkpoints += 1

    async def type(self, tab_id, selector, text):
        self.typed[selector] = text

    async def click(self, tab_id, selector):
        if selector == REMEMBER:
            self.remember_checked = not self.remember_checked
            return
        if selector != SUBMIT:
            return
        if self.phase == "login" and self.typed.get(USERNAME) and self.typed.get(PASSWORD):
            self.phase = "mfa-choice"
        elif self.phase == "mfa-choice":
            self.phase = "mfa"
        elif self.phase == "mfa" and self.typed.get(CODE):
            self.phase = "authenticated"

    async def probe(self, tab_id):
        if self.phase == "login":
            return {"phase": "login", "title": "Sign in", "error": None,
                    "username": USERNAME, "password": PASSWORD, "submit": SUBMIT}
        if self.phase == "mfa-choice":
            # The live screen has its one option preselected, so there is nothing to click.
            return {"phase": "mfa-choice", "title": "Two Factor Verification", "error": None,
                    "option": None, "submit": SUBMIT}
        if self.phase == "mfa":
            return {"phase": "mfa", "title": "Two Factor Verification", "error": None,
                    "code": CODE, "remember": REMEMBER, "rememberChecked": self.remember_checked,
                    "submit": SUBMIT}
        return {"phase": "authenticated", "title": "Dashboard", "error": None}


def test_code_is_asked_once_then_never_again(monkeypatch):
    fake = FakeEzlynx()
    monkeypatch.setattr(main, "camofox_for", lambda user_id: fake)

    with TestClient(main.app) as client:
        signed_in(client)
        saved = client.post("/api/ezlynx", json={"username": "a@agency.com", "password": "hunter2"}).json()
        assert saved["result"] == "mfa_required"
        assert saved["mfaPending"] is True
        assert saved["connected"] is False

        done = client.post("/api/ezlynx/mfa", json={"code": "123456"}).json()
        assert done["result"] == "connected"
        assert done["connected"] is True
        assert fake.typed[CODE] == "123456"
        assert fake.checkpoints == 1  # the session was written to disk
        assert fake.remember_checked is True  # device trust left on, or the code comes back

        # Device trusted, session persisted: the stored credentials log in with no code.
        fake.phase = "authenticated"
        again = client.post("/api/ezlynx/login").json()
        assert again["result"] == "connected"
        assert again["mfaPending"] is False

        # And the password never comes back out over HTTP.
        assert "password" not in client.get("/api/ezlynx").json()


def test_a_block_page_is_not_a_login(monkeypatch):
    """Cloudflare's block page once read as 'signed in'. It must fail, and must clear
    a connection that was previously good."""

    class Blocked(FakeEzlynx):
        async def probe(self, tab_id):
            return {"phase": "blocked", "title": "Attention Required! | Cloudflare",
                    "error": "Cloudflare is challenging the browser, not EZLynx."}

    fake = FakeEzlynx()
    monkeypatch.setattr(main, "camofox_for", lambda user_id: fake)
    with TestClient(main.app) as client:
        signed_in(client)
        client.post("/api/ezlynx", json={"username": "a@agency.com", "password": "hunter2"})
        assert client.post("/api/ezlynx/mfa", json={"code": "123456"}).json()["connected"] is True

        monkeypatch.setattr(main, "camofox_for", lambda user_id: Blocked())
        result = client.post("/api/ezlynx/login").json()
        assert result["result"] == "failed"
        assert "Cloudflare" in result["message"]
        assert result["connected"] is False


def test_a_bad_password_fails_without_asking_for_a_code(monkeypatch):
    class Rejecting(FakeEzlynx):
        async def probe(self, tab_id):
            state = await super().probe(tab_id)
            if self.typed.get(PASSWORD):  # form came back with an error
                state["error"] = "Invalid username or password."
            return state

        async def click(self, tab_id, selector):
            pass  # EZLynx stays on the login screen

    monkeypatch.setattr(main, "camofox_for", lambda user_id: Rejecting())
    with TestClient(main.app) as client:
        signed_in(client)
        result = client.post("/api/ezlynx", json={"username": "a@agency.com", "password": "wrong"}).json()
        assert result["result"] == "failed"
        assert result["message"] == "Invalid username or password."
        assert result["mfaPending"] is False
