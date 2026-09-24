"""The chat behind the frontend's composer.

DeepSeek does the talking and the EZLynx tools do the work. The tools are the
MCP server's own — `mcp_server2.py` is imported and called in-process rather than
spoken to over a transport, because the only client is this file.

Nothing here decides anything about a quote: the model picks a tool and its
arguments, the tool drives camofox, and the reply is what came back.
"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx
from fastmcp import Client
from fastmcp.exceptions import ToolError

import mcp_server2

DEEPSEEK_BASE_URL = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
DEEPSEEK_MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-flash")
# Enough rounds to sign in, read the status, and quote. A loop, so it is bounded.
MAX_ROUNDS = int(os.environ.get("SAVVY_CHAT_ROUNDS", 8))

SYSTEM = """You are the quoting assistant for an insurance agency. You work in \
EZLynx through the tools you have been given; they drive a real browser against \
the agency's real EZLynx account, for whichever associate is chatting with you.

- Every tool call is real. Requotes start from the associate's EZLynx task: \
`my_tasks` lists them, `find_account` turns a client's name into an account id, \
and `start_requote(account_id)` needs nothing else — it reads the task, the \
policies, the activity notes and the saved applications itself.
- Relay every job question to the associate VERBATIM (the requote "brief" \
included) and pass back exactly what they answer. Never answer a question, \
accept a brief, or approve a submission on your own.
- When the associate adds or corrects something mid-run, call `amend_job`.
- Submitting to carriers can pull credit and underwriting reports: call \
`approve_submit` only when the associate has said in plain words to submit, and \
pass `approved_by` as their name — never fill that in yourself. The same goes for \
posting a task note with `update_task`.
- Never invent applicant data. Dates of birth, SSNs, licence numbers, VINs, \
addresses and prior-policy details come from EZLynx or the associate.
- If a tool says the EZLynx session has expired, call ezlynx_login. When it \
returns mfa_required, ask the associate for the one-time code EZLynx just texted \
them and pass it to ezlynx_verify.
- Jobs run in the background: poll `job_status` and report progress rather than \
going silent while you wait.
- Report what actually happened, including carriers that declined and errors. Do \
not soften a failed run into a success.

The EZLynx server's own instructions follow.

""" + (mcp_server2.mcp.instructions or "")


class ChatError(RuntimeError):
    pass


def _schemas(tools: list[Any]) -> list[dict[str, Any]]:
    """MCP tool definitions in the shape DeepSeek's function calling wants."""
    return [
        {
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description or "",
                "parameters": tool.input_schema,
            },
        }
        for tool in tools
    ]


async def _call(client: Client, name: str, arguments: str) -> str:
    """Run one tool. Failures go back to the model as text so it can explain them."""
    try:
        parsed = json.loads(arguments or "{}")
    except json.JSONDecodeError:
        return f"error: {name} was called with arguments that are not JSON."
    if not isinstance(parsed, dict):
        return f"error: {name} takes named arguments."

    try:
        result = await client.call_tool(name, parsed)
    except ToolError as err:
        return f"error: {err}"
    if result.data is not None:
        return json.dumps(result.data, default=str)
    return "\n".join(getattr(block, "text", "") for block in result.content) or "done"


async def _ask(http: httpx.AsyncClient, api_key: str, body: dict[str, Any]) -> dict[str, Any]:
    response = await http.post(
        f"{DEEPSEEK_BASE_URL.rstrip('/')}/chat/completions",
        headers={"authorization": f"Bearer {api_key}"},
        json=body,
    )
    if response.is_error:
        detail = response.json().get("error", {}).get("message") if response.content else None
        raise ChatError(f"DeepSeek returned {response.status_code}: {detail or 'no detail'}")
    return response.json()["choices"][0]["message"]


async def reply(http: httpx.AsyncClient, history: list[dict[str, str]]) -> dict[str, Any]:
    """One assistant turn: think, run whatever tools it asks for, answer.

    `history` is the conversation so far as {role, content}. Returns the text and
    the names of the tools that ran, so the operator can see what touched EZLynx.
    """
    api_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not api_key:
        raise ChatError("DEEPSEEK_API_KEY is not set, so the assistant cannot answer.")

    messages: list[dict[str, Any]] = [{"role": "system", "content": SYSTEM}, *history]
    used: list[str] = []

    async with Client(mcp_server2.mcp) as client:
        tools = _schemas(await client.list_tools())

        for _ in range(MAX_ROUNDS):
            message = await _ask(http, api_key, {"model": DEEPSEEK_MODEL, "messages": messages, "tools": tools})
            calls = message.get("tool_calls") or []
            messages.append(message)
            if not calls:
                return {"reply": message.get("content") or "", "toolCalls": used}

            for call in calls:
                name = call["function"]["name"]
                used.append(name)
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call["id"],
                        "content": await _call(client, name, call["function"].get("arguments", "")),
                    }
                )

    return {
        "reply": "I stopped after too many tool calls without reaching an answer. "
        "Check EZLynx before asking again — a quote may be half-filled.",
        "toolCalls": used,
    }
