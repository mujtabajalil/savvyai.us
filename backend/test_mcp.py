"""The parts of the MCP server that are logic rather than plumbing: the dates a
requote has to move, and the quote it keeps to move them on.

    uv run pytest
"""

import os
import tempfile
from datetime import date, timedelta

os.environ.setdefault("SAVVY_ENC_KEY", "0" * 64)  # test key
os.environ.setdefault("SAVVY_DB", os.path.join(tempfile.mkdtemp(), "test.db"))

import json

import pytest
from fastmcp.exceptions import ToolError

import mcp_server
from store import Store

FORMAT = "%m/%d/%Y"


def test_requote_moves_both_dates_forward():
    today = date.today()
    stale = {
        "effectiveDate": "03/01/2023",
        "priorAuto": {"carrier": "Safeco", "expirationDate": "03/01/2023"},
    }

    rolled = mcp_server._roll_dates(stale, None)
    effective = mcp_server._parse(rolled["effectiveDate"])
    expiration = mcp_server._parse(rolled["priorAuto"]["expirationDate"])

    assert effective > today, "EZLynx rejects an effective date in the past"
    # Under a year ago is the whole point: EZLynx rejects a prior policy that
    # expired longer ago than that.
    assert today - timedelta(days=365) < expiration < today
    assert rolled["priorAuto"]["carrier"] == "Safeco", "only the date moves"
    assert stale["effectiveDate"] == "03/01/2023", "the caller's quote is not edited"

    # A policy still running is a rewrite: its expiration is left alone.
    running = (today + timedelta(days=60)).strftime(FORMAT)
    kept = mcp_server._roll_dates({"priorHome": {"expirationDate": running}}, "12/31/2099")
    assert kept["priorHome"]["expirationDate"] == running
    assert kept["effectiveDate"] == "12/31/2099"

    for bad in ["2023-03-01", (today - timedelta(days=1)).strftime(FORMAT)]:
        with pytest.raises(ToolError):
            mcp_server._roll_dates(stale, bad)


def test_report_is_read_from_the_path_the_cli_printed(tmp_path):
    written = tmp_path / "report.json"
    written.write_text(json.dumps({"quotes": [{"carrier": "GEICO"}]}))

    assert mcp_server._report(f"Wrote {written}\nWrote {tmp_path / 'report.md'}\n") == {
        "quotes": [{"carrier": "GEICO"}]
    }
    assert mcp_server._report("Dry run complete — nothing was submitted.") is None
    assert mcp_server._report(f"Wrote {tmp_path / 'gone.json'}") is None


def test_stored_quotes_are_sealed_per_account(tmp_path):
    db = tmp_path / "s.db"
    store = Store(str(db), key=bytes(32))
    store.save_quote("agent-a", "64483309", {"applicant": {"ssn": "471-40-4614"}})

    assert store.read_quote("agent-a", "64483309")["applicant"]["ssn"] == "471-40-4614"
    assert b"471-40-4614" not in db.read_bytes()
    assert store.read_quote("agent-a", "99999999") is None

    # Bound to user *and* account, so the row cannot be read as another one.
    sealed = store._db.execute("SELECT quote FROM ezlynx_quotes").fetchone()["quote"]
    store._db.execute("INSERT INTO ezlynx_quotes VALUES ('agent-b', '64483309', ?, 'now')", (sealed,))
    with pytest.raises(Exception):
        store.read_quote("agent-b", "64483309")

    store.save("agent-a", "a@agency.com", "hunter2")
    store.forget("agent-a")
    assert store.read_quote("agent-a", "64483309") is None, "forgetting takes the quote PII too"


def _tool_call(name: str, arguments: str = "{}") -> dict:
    return {
        "role": "assistant",
        "content": None,
        "tool_calls": [{"id": "1", "type": "function", "function": {"name": name, "arguments": arguments}}],
    }


def test_chat_runs_the_tool_and_feeds_the_result_back(monkeypatch):
    import asyncio

    import chat

    asked: list[dict] = []

    async def fake_deepseek(http, api_key, body):
        asked.append(body)
        if len(asked) == 1:
            return _tool_call("ezlynx_status")
        return {"role": "assistant", "content": "Nothing is connected yet."}

    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(chat, "_ask", fake_deepseek)

    answer = asyncio.run(chat.reply(None, [{"role": "user", "content": "where do we stand?"}]))

    assert answer == {"reply": "Nothing is connected yet.", "toolCalls": ["ezlynx_status"]}
    assert asked[0]["messages"][0]["role"] == "system", "the safety rules lead every turn"
    assert {"start_quote", "start_requote"} <= {t["function"]["name"] for t in asked[0]["tools"]}
    # What the tool actually returned is what the model got to answer from.
    result = next(m for m in asked[1]["messages"] if m.get("role") == "tool")
    assert '"mfaPending": false' in result["content"]


def test_chat_gives_up_rather_than_looping(monkeypatch):
    import asyncio

    import chat

    rounds = 0

    async def always_another_tool(http, api_key, body):
        nonlocal rounds
        rounds += 1
        return _tool_call("ezlynx_status")

    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(chat, "_ask", always_another_tool)

    answer = asyncio.run(chat.reply(None, [{"role": "user", "content": "go"}]))

    assert rounds == chat.MAX_ROUNDS
    assert "too many tool calls" in answer["reply"]


def test_a_broken_tool_call_answers_instead_of_raising(monkeypatch):
    import asyncio

    import chat
    from fastmcp import Client

    import mcp_server2

    async def go():
        async with Client(mcp_server2.mcp) as client:
            return [
                await chat._call(client, "ezlynx_status", "not json"),
                await chat._call(client, "ezlynx_status", "[1,2]"),
                # The tool's own refusal, not a crash: nothing has been quoted for it.
                await chat._call(client, "start_requote", '{"account_id": "not-an-account"}'),
            ]

    for message in asyncio.run(go()):
        assert message.startswith("error: "), message


def test_chat_says_so_when_there_is_no_key(monkeypatch):
    import asyncio

    import chat

    monkeypatch.setenv("DEEPSEEK_API_KEY", "")
    with pytest.raises(chat.ChatError):
        asyncio.run(chat.reply(None, [{"role": "user", "content": "hi"}]))


def test_the_tools_run_as_the_caller(monkeypatch):
    """The session is what keeps one agent's EZLynx vault out of another's chat."""
    from fastapi.testclient import TestClient

    import chat
    import main
    import mcp_server2

    seen: list[str] = []

    async def capture(http, history):
        seen.append(mcp_server2.USER.get())
        return {"reply": "ok", "toolCalls": []}

    monkeypatch.setattr(main, "reply", capture)
    from test_backend import signed_in

    with TestClient(main.app) as client:
        for who in ("agent-a", "agent-b"):
            signed_in(client, who)
            response = client.post(
                "/api/chat",
                json={"messages": [{"role": "user", "content": "hello"}]},
            )
            assert response.status_code == 200, response.text

        assert client.post("/api/chat", json={"messages": []}).status_code == 422

    assert seen == ["agent-a", "agent-b"]


def test_a_turn_that_fails_is_still_saved(monkeypatch):
    """Sign-out wipes the browser cache, so a chat must not live only there."""
    from fastapi.testclient import TestClient

    import chat
    import main

    async def broken(http, history):
        raise chat.ChatError("DeepSeek returned 500")

    monkeypatch.setattr(main, "reply", broken)
    from test_backend import signed_in

    with TestClient(main.app) as client:
        signed_in(client, "agent-c")
        response = client.post(
            "/api/chat",
            json={"messages": [{"role": "user", "content": "requote 64483309"}], "conversationId": "c-failed"},
        )
        assert response.status_code == 502
        listed = client.get("/api/conversations").json()

    assert [c["id"] for c in listed] == ["c-failed"]


def test_a_conversation_id_cannot_be_written_by_another_user(monkeypatch):
    """Ids come from the browser. Sending into someone else's must not touch theirs."""
    from fastapi.testclient import TestClient

    import main
    from test_backend import signed_in

    async def ok(http, history):
        return {"reply": "ok", "toolCalls": []}

    monkeypatch.setattr(main, "reply", ok)
    turn = {"messages": [{"role": "user", "content": "mine"}], "conversationId": "c-owned"}
    with TestClient(main.app) as client:
        signed_in(client, "owner")
        assert client.post("/api/chat", json=turn).status_code == 200

        signed_in(client, "intruder")
        intrude = {**turn, "messages": [{"role": "user", "content": "overwritten"}]}
        assert client.post("/api/chat", json=intrude).status_code == 404
        assert client.get("/api/conversations/c-owned").status_code == 404
        kept = main.app.state.store.read_conversation("owner", "c-owned")
        assert kept["messages"][0]["content"] == "mine"
