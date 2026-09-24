"""EZLynx credential store.

One SQLite row per app user. The password is sealed with AES-256-GCM under
SAVVY_ENC_KEY and bound to the user id as associated data, so a row lifted into
another user's name will not decrypt.

The password has to be replayable — EZLynx sessions expire and the whole point
is logging back in with nobody watching — so hashing is not an option. Keeping
the key out of the database is.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

NONCE_BYTES = 12
_HEX_KEY = re.compile(r"[0-9a-fA-F]{64}")


def load_key(env: os._Environ[str] | dict[str, str] = os.environ) -> bytes:
    """32 bytes as 64 hex characters. Refuse anything else — a short key is a silent downgrade."""
    raw = (env.get("SAVVY_ENC_KEY") or "").strip()
    if not raw:
        raise RuntimeError(
            "SAVVY_ENC_KEY is not set. Generate one with:\n"
            '  python3 -c "import secrets; print(secrets.token_hex(32))"'
        )
    if not _HEX_KEY.fullmatch(raw):
        raise RuntimeError("SAVVY_ENC_KEY must be 32 bytes written as 64 hex characters.")
    return bytes.fromhex(raw)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


SESSION_DAYS = 7
MIN_PASSWORD = 4  # ponytail: 4-digit passwords by request; raise before wider use


def _scrypt(password: str, salt: bytes) -> bytes:
    return hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)


def _token_key(token: str) -> str:
    """Sessions are stored by hash, so a copy of the database is not a pile of live logins."""
    return hashlib.sha256(token.encode()).hexdigest()


class Store:
    def __init__(self, file: str = "savvy.db", key: bytes | None = None) -> None:
        self._aes = AESGCM(key if key is not None else load_key())
        # One connection, used only from the event loop thread.
        self._db = sqlite3.connect(file, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute(
            """CREATE TABLE IF NOT EXISTS ezlynx_credentials (
                   user_id      TEXT PRIMARY KEY,
                   username     TEXT NOT NULL,
                   password     BLOB NOT NULL,
                   connected_at TEXT,
                   updated_at   TEXT NOT NULL
               ) STRICT"""
        )
        # Last quote per account, so a requote needs only the account id. Sealed
        # like the password: quote JSON carries SSNs, DOBs and licence numbers.
        self._db.execute(
            """CREATE TABLE IF NOT EXISTS ezlynx_quotes (
                   user_id    TEXT NOT NULL,
                   account_id TEXT NOT NULL,
                   quote      BLOB NOT NULL,
                   updated_at TEXT NOT NULL,
                   PRIMARY KEY (user_id, account_id)
               ) STRICT"""
        )
        # Chat history. `messages` is the plain {role, content} list as sent to
        # DeepSeek — not sealed, unlike credentials/quotes: it is operator chat
        # text, not applicant PII on its own, and needs to stay easy to read back.
        self._db.execute(
            """CREATE TABLE IF NOT EXISTS conversations (
                   id         TEXT PRIMARY KEY,
                   user_id    TEXT NOT NULL,
                   title      TEXT NOT NULL,
                   messages   TEXT NOT NULL,
                   created_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL
               ) STRICT"""
        )
        # App sign-in. Unlike the EZLynx password this one never needs replaying, so it is hashed.
        self._db.execute(
            """CREATE TABLE IF NOT EXISTS users (
                   username      TEXT PRIMARY KEY,
                   password_hash BLOB NOT NULL,
                   created_at    TEXT NOT NULL
               ) STRICT"""
        )
        self._db.execute(
            """CREATE TABLE IF NOT EXISTS sessions (
                   token_hash TEXT PRIMARY KEY,
                   username   TEXT NOT NULL,
                   expires_at TEXT NOT NULL
               ) STRICT"""
        )
        self._db.execute(
            "CREATE INDEX IF NOT EXISTS conversations_by_user ON conversations (user_id, updated_at)"
        )
        self._db.commit()

    def _seal(self, user_id: str, plaintext: str) -> bytes:
        nonce = secrets.token_bytes(NONCE_BYTES)
        return nonce + self._aes.encrypt(nonce, plaintext.encode(), user_id.encode())

    def _unseal(self, user_id: str, sealed: bytes) -> str:
        nonce, body = sealed[:NONCE_BYTES], sealed[NONCE_BYTES:]
        return self._aes.decrypt(nonce, body, user_id.encode()).decode()

    def save(self, user_id: str, username: str, password: str) -> None:
        """New credentials clear connected_at: they are unproven until a login succeeds."""
        self._db.execute(
            """INSERT INTO ezlynx_credentials (user_id, username, password, connected_at, updated_at)
               VALUES (?, ?, ?, NULL, ?)
               ON CONFLICT(user_id) DO UPDATE SET
                   username = excluded.username,
                   password = excluded.password,
                   connected_at = NULL,
                   updated_at = excluded.updated_at""",
            (user_id, username, self._seal(user_id, password), _now()),
        )
        self._db.commit()

    def read(self, user_id: str) -> tuple[str, str] | None:
        """Username and plaintext password, for replaying a login. Never put this in a response."""
        row = self._db.execute(
            "SELECT username, password FROM ezlynx_credentials WHERE user_id = ?", (user_id,)
        ).fetchone()
        if row is None:
            return None
        return row["username"], self._unseal(user_id, row["password"])

    def status(self, user_id: str) -> dict[str, object]:
        """What the frontend is allowed to see."""
        row = self._db.execute(
            "SELECT username, connected_at FROM ezlynx_credentials WHERE user_id = ?", (user_id,)
        ).fetchone()
        if row is None:
            return {"saved": False, "connected": False, "username": None, "connectedAt": None}
        return {
            "saved": True,
            "connected": row["connected_at"] is not None,
            "username": row["username"],
            "connectedAt": row["connected_at"],
        }

    def mark_connected(self, user_id: str, connected: bool = True) -> None:
        self._db.execute(
            "UPDATE ezlynx_credentials SET connected_at = ? WHERE user_id = ?",
            (_now() if connected else None, user_id),
        )
        self._db.commit()

    def save_quote(self, user_id: str, account_id: str, quote: dict[str, object]) -> None:
        self._db.execute(
            """INSERT INTO ezlynx_quotes (user_id, account_id, quote, updated_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(user_id, account_id) DO UPDATE SET
                   quote = excluded.quote, updated_at = excluded.updated_at""",
            (user_id, account_id, self._seal(f"{user_id}:{account_id}", json.dumps(quote)), _now()),
        )
        self._db.commit()

    def read_quote(self, user_id: str, account_id: str) -> dict[str, object] | None:
        row = self._db.execute(
            "SELECT quote FROM ezlynx_quotes WHERE user_id = ? AND account_id = ?", (user_id, account_id)
        ).fetchone()
        if row is None:
            return None
        return json.loads(self._unseal(f"{user_id}:{account_id}", row["quote"]))

    def forget(self, user_id: str) -> None:
        """Credentials and the quotes kept for requoting — all of it is that user's."""
        self._db.execute("DELETE FROM ezlynx_credentials WHERE user_id = ?", (user_id,))
        self._db.execute("DELETE FROM ezlynx_quotes WHERE user_id = ?", (user_id,))
        self._db.commit()

    def list_conversations(self, user_id: str) -> list[dict[str, object]]:
        """Sidebar data: no message bodies, newest first."""
        rows = self._db.execute(
            """SELECT id, title, created_at, updated_at FROM conversations
               WHERE user_id = ? ORDER BY updated_at DESC""",
            (user_id,),
        ).fetchall()
        return [
            {"id": r["id"], "title": r["title"], "createdAt": r["created_at"], "updatedAt": r["updated_at"]}
            for r in rows
        ]

    def read_conversation(self, user_id: str, conversation_id: str) -> dict[str, object] | None:
        row = self._db.execute(
            """SELECT id, title, messages, created_at, updated_at FROM conversations
               WHERE user_id = ? AND id = ?""",
            (user_id, conversation_id),
        ).fetchone()
        if row is None:
            return None
        return {
            "id": row["id"],
            "title": row["title"],
            "messages": json.loads(row["messages"]),
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }

    def save_conversation(
        self, user_id: str, conversation_id: str, title: str, messages: list[dict[str, str]]
    ) -> None:
        """Upsert the whole history. The caller always has the full list already.

        Ids come from the browser, so one naming another user's conversation must not
        overwrite it: the update only applies to the caller's own row.
        """
        now = _now()
        written = self._db.execute(
            """INSERT INTO conversations (id, user_id, title, messages, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                   title = excluded.title, messages = excluded.messages, updated_at = excluded.updated_at
               WHERE conversations.user_id = excluded.user_id""",
            (conversation_id, user_id, title, json.dumps(messages), now, now),
        ).rowcount
        self._db.commit()
        if not written:
            raise PermissionError(conversation_id)

    def delete_conversation(self, user_id: str, conversation_id: str) -> None:
        self._db.execute(
            "DELETE FROM conversations WHERE user_id = ? AND id = ?", (user_id, conversation_id)
        )
        self._db.commit()

    def add_user(self, username: str, password: str) -> None:
        """Create or reset a user. Resetting logs them out everywhere."""
        if len(password) < MIN_PASSWORD:
            raise ValueError(f"Password must be at least {MIN_PASSWORD} characters.")
        salt = secrets.token_bytes(16)
        self._db.execute(
            """INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)
               ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash""",
            (username, salt + _scrypt(password, salt), _now()),
        )
        self._db.execute("DELETE FROM sessions WHERE username = ?", (username,))
        self._db.commit()

    def check_password(self, username: str, password: str) -> bool:
        row = self._db.execute(
            "SELECT password_hash FROM users WHERE username = ?", (username,)
        ).fetchone()
        # Hash even for an unknown name, so the response time does not say which names exist.
        stored = row["password_hash"] if row else bytes(48)
        return hmac.compare_digest(stored[16:], _scrypt(password, stored[:16])) and row is not None

    def create_session(self, username: str) -> str:
        token = secrets.token_urlsafe(32)
        expires = datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)
        self._db.execute(
            "INSERT INTO sessions VALUES (?, ?, ?)",
            (_token_key(token), username, expires.isoformat(timespec="seconds")),
        )
        self._db.commit()
        return token

    def session_user(self, token: str) -> str | None:
        row = self._db.execute(
            "SELECT username FROM sessions WHERE token_hash = ? AND expires_at > ?",
            (_token_key(token), _now()),
        ).fetchone()
        return row["username"] if row else None

    def drop_session(self, token: str) -> None:
        self._db.execute("DELETE FROM sessions WHERE token_hash = ?", (_token_key(token),))
        self._db.commit()

    def close(self) -> None:
        self._db.close()


if __name__ == "__main__":
    # uv run python store.py add-user <name>   (with .env loaded, for SAVVY_ENC_KEY)
    import getpass
    import sys

    if len(sys.argv) != 3 or sys.argv[1] != "add-user":
        sys.exit("usage: python store.py add-user <username>")
    password = getpass.getpass("Password: ")
    if password != getpass.getpass("Again: "):
        sys.exit("Passwords do not match.")
    store = Store(os.environ.get("SAVVY_DB", "savvy.db"))
    try:
        store.add_user(sys.argv[2], password)
    except ValueError as err:
        sys.exit(str(err))
    print(f"{sys.argv[2]} can sign in.")
