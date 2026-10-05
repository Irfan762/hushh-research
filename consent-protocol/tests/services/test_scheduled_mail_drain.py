"""The scheduled-mail drain sends each due email at most once, or says why not.

The drain is driven against an in-memory ledger that interprets both its own
SQL and the SQL of the UNCHANGED ``GmailDeliveryService.execute()``, so these
tests prove the arming contract (a row the drain arms is one execute() will
send) and the send-once/fail-closed boundaries end to end, with only Gmail's
HTTP endpoint and the I1 seal pair faked.
"""

from __future__ import annotations

import asyncio
import base64
import copy
import json
from datetime import datetime, timedelta, timezone
from email import message_from_bytes
from email.policy import default as default_policy
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest

from hushh_mcp.services import gmail_scheduled_drain as drain
from hushh_mcp.services.gmail_delivery_service import GmailDeliveryService, normalize_draft
from hushh_mcp.services.gmail_scheduled_drain import drain_scheduled_mail

NOW = datetime(2026, 10, 5, 12, 0, tzinfo=timezone.utc)
OWNER = "owner-uid"
RECIPIENT = "priya-uid"
ADDRESS = "priya@example.com"
SUBJECT = "Diwali plans"
BODY = "See you at seven."
NAME = "Priya Sharma"


class _Delivery(GmailDeliveryService):
    """The real service plus a stand-in for Stream S's I1 seal pair."""

    def open_schedule_payload(self, *, user_id: str, action_id: str, sealed: str) -> dict:
        prefix = f"sealed:{user_id}:{action_id}:"
        if not sealed.startswith(prefix):
            raise ValueError("unopenable")
        return json.loads(sealed[len(prefix) :])

    @staticmethod
    def scheduled_draft_payload(payload: dict[str, Any]) -> dict[str, Any]:
        return {"to": [payload["to"]], "subject": payload["subject"], "body": payload["body"]}


def _payload(**changes: str) -> dict[str, str]:
    return {
        "to": ADDRESS,
        "subject": SUBJECT,
        "body": BODY,
        "recipient_user_id": RECIPIENT,
        **changes,
    }


class _Ledger:
    """gmail_owner_send_actions, with NOW() pinned and SQL interpreted."""

    def __init__(self) -> None:
        self.rows: dict[str, dict[str, Any]] = {}
        self.statements: list[str] = []

    def pool(self) -> _Pool:
        return _Pool(self)

    def row(self, action_id: str) -> dict[str, Any]:
        return self.rows[action_id]


class _Pool:
    def __init__(self, ledger: _Ledger) -> None:
        self.ledger = ledger

    def acquire(self) -> _Acquire:
        return _Acquire(self.ledger)


class _Acquire:
    def __init__(self, ledger: _Ledger) -> None:
        self.ledger = ledger

    async def __aenter__(self) -> _Conn:
        return _Conn(self.ledger)

    async def __aexit__(self, *exc: object) -> bool:
        return False


class _Transaction:
    def __init__(self, ledger: _Ledger) -> None:
        self.ledger = ledger
        self.snapshot: dict[str, dict[str, Any]] = {}

    async def __aenter__(self) -> _Transaction:
        self.snapshot = copy.deepcopy(self.ledger.rows)
        return self

    async def __aexit__(self, exc_type: object, *exc: object) -> bool:
        if exc_type is not None:
            self.ledger.rows.clear()
            self.ledger.rows.update(self.snapshot)
        return False


def _orphaned(row: dict[str, Any]) -> bool:
    return (
        row["state"] == "prepared"
        and row["send_at"] is not None
        and row["sending_at"] is None
        and row["updated_at"] < NOW - timedelta(minutes=10)
    )


class _Conn:
    def __init__(self, ledger: _Ledger) -> None:
        self.ledger = ledger

    def transaction(self) -> _Transaction:
        return _Transaction(self.ledger)

    async def execute(self, query: str, *args: Any) -> str:
        self._run(query, args)
        return "OK"

    async def fetchrow(self, query: str, *args: Any) -> dict[str, Any] | None:
        return self._run(query, args)

    async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
        return self._run(query, args)

    def _owned(self, action_id: str, user_id: str) -> dict[str, Any] | None:
        row = self.ledger.rows.get(action_id)
        return row if row is not None and row["user_id"] == user_id else None

    def _run(self, query: str, args: tuple[Any, ...]) -> Any:  # noqa: C901 - one SQL table
        self.ledger.statements.append(query)
        rows = self.ledger.rows
        if query == drain._STALE_SENDING_SQL:
            stale = sorted(
                (
                    row
                    for row in rows.values()
                    if row["state"] == "sending"
                    and row["send_at"] is not None
                    and row["sending_at"] < NOW - timedelta(minutes=10)
                ),
                key=lambda row: row["sending_at"],
            )[: args[0]]
            for row in stale:
                row.update(
                    state="outcome_unknown", safe_error_code="drain_interrupted", updated_at=NOW
                )
            return [{"action_id": row["action_id"], "user_id": row["user_id"]} for row in stale]
        if query == drain._CLAIM_SQL:
            due = sorted(
                (
                    row
                    for row in rows.values()
                    if row["action_id"] not in args[0]
                    and ((row["state"] == "scheduled" and row["send_at"] <= NOW) or _orphaned(row))
                ),
                key=lambda row: (row["send_at"], row["action_id"]),
            )
            if not due:
                return None
            row = due[0]
            return {
                **{
                    key: row[key]
                    for key in ("action_id", "user_id", "state", "attempt_count", "payload_sealed")
                },
                "window_passed": row["expires_at"] <= NOW,
            }
        if query in (drain._SETTLE_UNSENT_SQL, drain._ARM_SQL):
            row = self._owned(args[0], args[1])
            if row is None or row["state"] not in ("scheduled", "prepared") or row["sending_at"]:
                return None
            if query == drain._ARM_SQL:
                row.update(state="prepared", attempt_count=row["attempt_count"] + 1, updated_at=NOW)
            else:
                row.update(state=args[2], safe_error_code=args[3], updated_at=NOW)
            return {"action_id": row["action_id"]}
        if query == drain._FAIL_ARMED_SQL:
            row = self._owned(args[0], args[1])
            if row is not None and row["state"] == "prepared" and row["sending_at"] is None:
                row.update(state="failed", safe_error_code=args[2], updated_at=NOW)
            return None
        if query == drain._READ_STATE_SQL:
            row = self._owned(args[0], args[1])
            return None if row is None else {k: row[k] for k in ("state", "safe_error_code")}
        if query == drain._CLAIM_NOTIFICATION_SQL:
            row = self._owned(args[0], args[1])
            if row is None or row["state"] != args[2] or row["notified_at"] is not None:
                return None
            row["notified_at"] = NOW
            return {"recipient_display": row["recipient_display"]}
        # The unchanged GmailDeliveryService.execute() statements.
        if "SET state = 'expired'" in query:
            row = self._owned(args[0], args[1])
            if row is not None and row["state"] == "prepared" and row["expires_at"] <= NOW:
                row.update(state="expired", updated_at=NOW)
            return None
        if "SELECT action_id, state, expires_at, sent_at, envelope_hmac" in query:
            row = self._owned(args[0], args[1])
            if row is None:
                return None
            return {
                key: row[key]
                for key in ("action_id", "state", "expires_at", "sent_at", "envelope_hmac")
            }
        if "SET state = 'sending'" in query:
            row = self._owned(args[0], args[1])
            if (
                row is None
                or row["state"] != "prepared"
                or row["expires_at"] <= NOW
                or row["envelope_hmac"] != args[2]
            ):
                return None
            row.update(state="sending", sending_at=NOW, updated_at=NOW)
            return {key: row[key] for key in ("action_id", "state", "expires_at", "sent_at")}
        if "gmail_message_id = COALESCE" in query:
            row = rows.get(args[0])
            if row is not None and row["state"] == "sending":
                row.update(state=args[1], safe_error_code=args[2], updated_at=NOW)
                if args[1] == "sent":
                    row["sent_at"] = NOW
            return None
        raise AssertionError(f"unexpected SQL: {query.strip()[:80]}")


class _GmailServer:
    def __init__(self) -> None:
        self.posts: list[dict[str, Any]] = []
        self.status = 200

    def client_class(self) -> type:
        server = self

        class _Client:
            def __init__(self, *args: Any, **kwargs: Any) -> None:
                pass

            async def __aenter__(self) -> _Client:
                return self

            async def __aexit__(self, *exc: object) -> bool:
                return False

            async def post(self, url: str, *, headers: dict, json: dict) -> httpx.Response:
                server.posts.append(json)
                return httpx.Response(
                    server.status,
                    json={"id": f"gmail-{len(server.posts)}", "threadId": "thread"},
                    request=httpx.Request("POST", url),
                )

        return _Client

    def recipients(self) -> list[str]:
        return [
            str(
                message_from_bytes(base64.urlsafe_b64decode(post["raw"]), policy=default_policy)[
                    "To"
                ]
            )
            for post in self.posts
        ]


@pytest.fixture
def harness(monkeypatch):
    from hushh_mcp.services import gmail_delivery_service as delivery_module

    monkeypatch.setattr(
        delivery_module,
        "get_core_security_settings",
        lambda: SimpleNamespace(app_signing_key="test-signing-key"),
    )
    ledger = _Ledger()
    gmail = _GmailServer()
    monkeypatch.setattr(delivery_module, "get_pool", lambda: asyncio.sleep(0, result=ledger.pool()))
    monkeypatch.setattr(delivery_module.httpx, "AsyncClient", gmail.client_class())
    service = _Delivery(
        gmail_service=SimpleNamespace(get_send_access_token=AsyncMock(return_value="send-token"))
    )
    executed: list[str] = []
    real_execute = service.execute

    async def counting_execute(**kwargs: Any) -> dict[str, Any]:
        executed.append(kwargs["action_id"])
        return await real_execute(**kwargs)

    service.execute = counting_execute  # type: ignore[method-assign]
    return SimpleNamespace(
        ledger=ledger,
        gmail=gmail,
        service=service,
        executed=executed,
        pushes=[],
        connections=[{"userId": RECIPIENT, "email": "Priya@Example.com"}],
    )


def _schedule(
    h: SimpleNamespace,
    action_id: str,
    *,
    send_at: datetime = NOW - timedelta(minutes=1),
    payload: dict[str, str] | None = None,
    **fields: Any,
) -> dict[str, Any]:
    payload = payload or _payload()
    row = {
        "action_id": action_id,
        "user_id": OWNER,
        "state": "scheduled",
        # D3: exactly the envelope an immediate send of this draft would carry.
        "envelope_hmac": h.service._envelope_hmac(
            normalize_draft(h.service.scheduled_draft_payload(payload))
        ),
        "send_at": send_at,
        "expires_at": send_at + timedelta(hours=24),
        "sending_at": None,
        "sent_at": None,
        "updated_at": send_at - timedelta(hours=1),
        "attempt_count": 0,
        "payload_sealed": f"sealed:{OWNER}:{action_id}:{json.dumps(payload)}",
        "recipient_display": NAME,
        "safe_error_code": None,
        "notified_at": None,
        **fields,
    }
    h.ledger.rows[action_id] = row
    return row


async def _drain(h: SimpleNamespace, **kwargs: Any) -> dict[str, Any]:
    def push(user_id: str, **payload: Any) -> int:
        h.pushes.append((user_id, payload))
        return 1

    return await drain_scheduled_mail(
        limit=kwargs.pop("limit", 50),
        delivery=h.service,
        directory=SimpleNamespace(list_connections=lambda user_id: list(h.connections)),
        push=push,
        pool_provider=lambda: asyncio.sleep(0, result=h.ledger.pool()),
        **kwargs,
    )


def _push_bodies(h: SimpleNamespace) -> list[str]:
    return [payload["body"] for _user, payload in h.pushes]


@pytest.mark.asyncio
async def test_due_rows_fire_in_send_at_order_through_unchanged_execute(harness):
    h = harness
    _schedule(h, "later", send_at=NOW - timedelta(minutes=1))
    _schedule(h, "earlier", send_at=NOW - timedelta(minutes=5))
    _schedule(h, "not-due", send_at=NOW + timedelta(minutes=5))

    result = await _drain(h)

    assert h.executed == ["earlier", "later"]
    assert h.gmail.recipients() == [ADDRESS, ADDRESS]
    assert result == {
        "success": True,
        "fired": 2,
        "sent": ["earlier", "later"],
        "failed": [],
        "outcome_unknown": [],
        "cancelled": [],
        "expired": [],
        "limit": 50,
    }
    assert h.ledger.row("earlier")["state"] == "sent"
    assert h.ledger.row("earlier")["attempt_count"] == 1
    assert h.ledger.row("not-due")["state"] == "scheduled"
    assert _push_bodies(h) == [f"Your scheduled email to {NAME} was sent."] * 2
    # The owner learns who; nothing else of the email leaves the ledger.
    rendered = json.dumps([result, [payload for _user, payload in h.pushes]])
    for private in (ADDRESS, SUBJECT, BODY, RECIPIENT, OWNER):
        assert private not in rendered
    assert all(payload["include_user_id"] is False for _user, payload in h.pushes)

    # A second run finds nothing due and never re-sends or re-notifies.
    again = await _drain(h)
    assert again["fired"] == 0 and len(h.gmail.posts) == 2 and len(h.pushes) == 2


@pytest.mark.asyncio
async def test_tampered_envelope_fails_closed_before_any_provider_call(harness):
    h = harness
    _schedule(h, "tampered", envelope_hmac="f" * 64)

    result = await _drain(h)

    assert h.executed == ["tampered"]
    assert h.gmail.posts == []
    assert result["failed"] == ["tampered"] and result["sent"] == []
    row = h.ledger.row("tampered")
    assert (row["state"], row["safe_error_code"]) == ("failed", "draft_changed")
    assert "couldn't be sent (it changed after it was scheduled)" in _push_bodies(h)[0]


@pytest.mark.asyncio
async def test_unopenable_payload_fails_closed_without_reaching_execute(harness):
    h = harness
    _schedule(h, "garbled", payload_sealed="sealed:someone-else:garbled:{}")

    result = await _drain(h)

    assert h.executed == [] and h.gmail.posts == []
    assert result["failed"] == ["garbled"]
    assert h.ledger.row("garbled")["safe_error_code"] == "payload_unseal_failed"
    assert len(h.pushes) == 1


@pytest.mark.asyncio
async def test_outcome_unknown_is_final_and_never_resent(harness):
    h = harness
    _schedule(h, "ambiguous")
    h.gmail.status = 503

    first = await _drain(h)
    h.gmail.status = 200
    second = await _drain(h)

    assert first["outcome_unknown"] == ["ambiguous"]
    assert second["fired"] == 0 and second["outcome_unknown"] == []
    assert len(h.gmail.posts) == 1
    assert h.ledger.row("ambiguous")["state"] == "outcome_unknown"
    assert _push_bodies(h) == [
        f"We couldn't confirm whether your scheduled email to {NAME} was sent. "
        "Please check your Gmail Sent folder before resending."
    ]


@pytest.mark.asyncio
async def test_disconnected_recipient_is_cancelled_and_never_reaches_execute(harness):
    h = harness
    _schedule(h, "disconnected")
    h.connections = []

    result = await _drain(h)

    assert h.executed == [] and h.gmail.posts == []
    assert result["cancelled"] == ["disconnected"] and result["fired"] == 0
    row = h.ledger.row("disconnected")
    assert (row["state"], row["safe_error_code"]) == ("cancelled", "recipient_disconnected")
    assert _push_bodies(h) == [
        f"Your scheduled email to {NAME} wasn't sent because you're no longer connected "
        "with them. Nothing was delivered."
    ]


@pytest.mark.asyncio
async def test_changed_recipient_address_fails_closed(harness):
    h = harness
    _schedule(h, "moved")
    h.connections = [{"userId": RECIPIENT, "email": "priya@new-employer.example"}]

    result = await _drain(h)

    assert h.executed == [] and h.gmail.posts == []
    assert result["failed"] == ["moved"]
    assert h.ledger.row("moved")["safe_error_code"] == "recipient_changed"


@pytest.mark.asyncio
async def test_cancelled_row_is_never_sent_or_notified(harness):
    h = harness
    _schedule(h, "cancelled-by-voice", state="cancelled")

    result = await _drain(h)

    assert result["fired"] == 0 and h.gmail.posts == [] and h.pushes == []
    assert h.ledger.row("cancelled-by-voice")["notified_at"] is None


@pytest.mark.asyncio
async def test_row_past_its_send_window_expires_instead_of_sending_late(harness):
    h = harness
    _schedule(h, "overdue", send_at=NOW - timedelta(hours=25))
    _schedule(h, "catch-up", send_at=NOW - timedelta(hours=23))

    result = await _drain(h)

    assert result["expired"] == ["overdue"] and result["sent"] == ["catch-up"]
    assert h.executed == ["catch-up"]
    assert h.ledger.row("overdue")["safe_error_code"] == "schedule_window_passed"
    assert (
        f"Your scheduled email to {NAME} wasn't sent because the send window passed. "
        "Nothing was delivered."
    ) in _push_bodies(h)


@pytest.mark.asyncio
async def test_orphaned_armed_row_is_rearmed_once_and_recent_arms_are_left_alone(harness):
    h = harness
    _schedule(
        h,
        "orphan",
        state="prepared",
        attempt_count=1,
        updated_at=NOW - timedelta(minutes=15),
    )
    _schedule(
        h,
        "in-flight",
        state="prepared",
        attempt_count=1,
        updated_at=NOW - timedelta(minutes=2),
    )
    _schedule(
        h,
        "exhausted",
        state="prepared",
        attempt_count=drain.MAX_ATTEMPTS,
        updated_at=NOW - timedelta(minutes=15),
    )

    result = await _drain(h)

    assert h.executed == ["orphan"]
    assert result["sent"] == ["orphan"] and result["failed"] == ["exhausted"]
    assert h.ledger.row("orphan")["attempt_count"] == 2
    assert h.ledger.row("in-flight")["state"] == "prepared"
    assert h.ledger.row("exhausted")["safe_error_code"] == "retry_exhausted"


@pytest.mark.asyncio
async def test_row_stuck_sending_becomes_outcome_unknown_and_is_never_resent(harness):
    h = harness
    _schedule(
        h,
        "crashed-mid-post",
        state="sending",
        sending_at=NOW - timedelta(minutes=15),
        attempt_count=1,
    )

    result = await _drain(h)

    assert result["outcome_unknown"] == ["crashed-mid-post"]
    assert h.executed == [] and h.gmail.posts == []
    assert h.ledger.row("crashed-mid-post")["safe_error_code"] == "drain_interrupted"
    assert len(h.pushes) == 1


@pytest.mark.asyncio
async def test_a_failing_row_is_rolled_back_and_does_not_stop_the_batch(harness):
    h = harness
    _schedule(h, "first", send_at=NOW - timedelta(minutes=5))
    _schedule(h, "second", send_at=NOW - timedelta(minutes=1))
    calls = {"n": 0}

    def flaky(user_id: str) -> list[dict[str, Any]]:
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("directory unavailable")
        return list(h.connections)

    result = await drain_scheduled_mail(
        limit=50,
        delivery=h.service,
        directory=SimpleNamespace(list_connections=flaky),
        push=lambda user_id, **payload: 1,
        pool_provider=lambda: asyncio.sleep(0, result=h.ledger.pool()),
    )

    assert result["sent"] == ["second"] and result["fired"] == 1
    assert h.ledger.row("first")["state"] == "scheduled"
    assert h.ledger.row("first")["attempt_count"] == 0


@pytest.mark.asyncio
async def test_limit_and_deadline_bound_a_run(harness):
    h = harness
    _schedule(h, "a", send_at=NOW - timedelta(minutes=3))
    _schedule(h, "b", send_at=NOW - timedelta(minutes=2))

    limited = await _drain(h, limit=1)
    assert limited["sent"] == ["a"] and limited["limit"] == 1

    ticks = iter([0.0, 241.0])
    timed_out = await _drain(h, deadline_seconds=240, clock=lambda: next(ticks))
    assert timed_out["fired"] == 0 and h.ledger.row("b")["state"] == "scheduled"

    with pytest.raises(ValueError):
        await _drain(h, limit=101)
