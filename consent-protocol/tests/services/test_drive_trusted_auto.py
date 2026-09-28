"""Trusted Drive requests need current authority at every automatic step."""

# ruff: noqa: F401, F811 -- isolated PostgreSQL fixtures imported from their owners

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from sqlalchemy import text

from hushh_mcp.services.drive_live_preferences import DriveLivePreferences
from hushh_mcp.services.drive_sharing_contract import (
    DriveSharingError,
    ShareRequestPurpose,
    VerifiedGoogleRecipient,
)
from hushh_mcp.services.drive_trusted_auto_service import DriveTrustedAutoService
from tests.services.test_drive_request_bulk_postgres import request_bulk
from tests.services.test_drive_sharing_store import (
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
    rows,
    sharing,
)


async def _request(sharing, *, owner_initiated=False):
    return await sharing.create_request(
        recipient=VerifiedGoogleRecipient(
            "recipient", "1234567", "b@example.invalid", datetime.now(UTC)
        ),
        owner_user_id="owner",
        client_request_id=str(uuid4()),
        purpose=ShareRequestPurpose(purpose="Standup notes from last 3 months"),
        owner_initiated=owner_initiated,
    )


def _membership(sharing, status):
    with sharing.db.engine.begin() as connection:
        circle = connection.execute(
            text("""SELECT id FROM one_location_circles
            WHERE owner_user_id='owner' AND system_kind='trusted'""")
        ).scalar_one()
        connection.execute(
            text("""DELETE FROM one_location_circle_memberships
            WHERE circle_id=:circle AND user_id='recipient'"""),
            {"circle": circle},
        )
        connection.execute(
            text("""INSERT INTO one_location_circle_memberships
            (circle_id,user_id,status) VALUES (:circle,'recipient',:status)"""),
            {"circle": circle, "status": status},
        )


@pytest.mark.asyncio
async def test_only_new_accepted_trusted_request_gets_auto_marker(request_bulk, sharing):
    with sharing.db.engine.begin() as connection:
        connection.execute(text("UPDATE connection_origins SET status='removed'"))
    unaccepted = await _request(sharing)
    assert (await sharing.owner_review(user_id="owner", request_id=unaccepted["requestId"]))[
        "trustedAuto"
    ] is False
    with sharing.db.engine.begin() as connection:
        connection.execute(text("UPDATE connection_origins SET status='active'"))
    _membership(sharing, "active")
    accepted = await _request(sharing)
    assert (await sharing.owner_review(user_id="owner", request_id=accepted["requestId"]))[
        "trustedAuto"
    ] is True
    owner_selected = await _request(sharing, owner_initiated=True)
    assert (await sharing.owner_review(user_id="owner", request_id=owner_selected["requestId"]))[
        "trustedAuto"
    ] is False
    _membership(sharing, "removed")
    removed = await _request(sharing)
    assert (await sharing.owner_review(user_id="owner", request_id=removed["requestId"]))[
        "trustedAuto"
    ] is False
    # A pre-deploy or ordinary request does not become automatic on replay.
    with sharing.db.engine.begin() as connection:
        connection.execute(text("UPDATE connection_origins SET status='active'"))
    _membership(sharing, "active")
    assert (await sharing.owner_review(user_id="owner", request_id=unaccepted["requestId"]))[
        "trustedAuto"
    ] is False


@pytest.mark.asyncio
async def test_background_off_requires_one_setup_event_and_resumes_on_enable(request_bulk, sharing):
    _membership(sharing, "active")
    item = await _request(sharing)
    request_id = item["requestId"]
    auto = DriveTrustedAutoService(sharing=sharing, bulk=request_bulk, wake=AsyncMock())
    outcome = await auto.start_pending()
    assert outcome == {"started": 0, "deferred": 1}
    review = await sharing.owner_review(user_id="owner", request_id=request_id)
    assert review["trustedAuto"] is True
    assert review["preparationError"] == "background_preparation_required"
    assert rows(sharing, "drive_share_permission_operations") == []
    assert [event["event_type"] for event in rows(sharing, "drive_share_events")] == [
        "document_share_request"
    ]
    # The setup event is unique, and no automatic work retries in a tight loop.
    assert (await auto.start_pending())["deferred"] == 0
    preference = DriveLivePreferences(db=sharing.db)
    await preference.set_background(user_id="owner", enabled=True, confirmed=True)
    review = await sharing.owner_review(user_id="owner", request_id=request_id)
    assert review["preparationError"] is None
    assert (await sharing.trusted_request_authority(user_id="owner", request_id=request_id))[
        "recipientUserId"
    ] == "recipient"
    assert {item["request_id"] for item in await sharing.due_trusted_searches()} == {request_id}


@pytest.mark.asyncio
async def test_removed_trust_stops_search_and_grant_authority(request_bulk, sharing):
    _membership(sharing, "active")
    await DriveLivePreferences(db=sharing.db).set_background(
        user_id="owner", enabled=True, confirmed=True
    )
    item = await _request(sharing)
    request_id = item["requestId"]
    authority = await sharing.trusted_request_authority(user_id="owner", request_id=request_id)
    synthetic_share = {
        "origin_request_id": request_id,
        "origin_request_revision": item["revision"],
        "progressive_batch": True,
        "approved_at": datetime.now(UTC),
        "connection_generation": authority["generation"],
    }
    with sharing.db.engine.begin() as connection:
        assert request_bulk._share_recipient_current(
            connection, synthetic_share, "owner", "recipient"
        )
    preferences = DriveLivePreferences(db=sharing.db)
    await preferences.set_background(user_id="owner", enabled=False, confirmed=True)
    with sharing.db.engine.begin() as connection:
        assert not request_bulk._share_recipient_current(
            connection, synthetic_share, "owner", "recipient"
        )
    await preferences.set_background(user_id="owner", enabled=True, confirmed=True)
    _membership(sharing, "removed")
    with pytest.raises(DriveSharingError, match="trusted_request_unavailable"):
        await sharing.trusted_request_authority(user_id="owner", request_id=request_id)
    with sharing.db.engine.begin() as connection:
        assert not request_bulk._share_recipient_current(
            connection, synthetic_share, "owner", "recipient"
        )
    auto = DriveTrustedAutoService(sharing=sharing, bulk=request_bulk, wake=AsyncMock())
    assert (await auto.start_pending())["deferred"] == 1
    review = await sharing.owner_review(user_id="owner", request_id=request_id)
    assert review["preparationError"] == "trusted_relationship_changed"
    assert rows(sharing, "drive_share_permission_operations") == []


@pytest.mark.asyncio
async def test_bounded_auto_batches_continue_past_first_twenty_five(monkeypatch):
    from hushh_mcp.services import drive_trusted_auto_service as module

    remaining = list(range(1, 76))
    prepared = []
    approved = []
    wakes = []

    class FakeRequestBulk:
        def __init__(self, **kwargs):
            self.require_owner = kwargs["require_owner"]

        async def prepare(self, *, positions, **kwargs):
            await self.require_owner()
            assert 1 <= len(positions) <= 25
            prepared.append(positions)
            for position in positions:
                remaining.remove(position)
            return {"shareId": str(uuid4()), "revision": 0, "reviewDigest": "digest"}

    class FakeBulkService:
        def __init__(self, **kwargs):
            self.require_owner = kwargs["require_owner"]

        async def approve(self, **kwargs):
            await self.require_owner()
            approved.append(kwargs["share_id"])
            await wake("sharing")

    async def unclaimed_positions(*, limit, **kwargs):
        return remaining[:limit]

    async def wake(stage):
        wakes.append(stage)

    bulk = SimpleNamespace(
        unclaimed_positions=unclaimed_positions,
        pending_request_reviews=AsyncMock(return_value=[]),
        refresh_request=AsyncMock(),
    )
    sharing = SimpleNamespace(db=object(), trusted_request_authority=AsyncMock(return_value={}))
    monkeypatch.setattr(module, "DriveRequestBulkService", FakeRequestBulk)
    monkeypatch.setattr(module, "DriveBulkShareService", FakeBulkService)
    service = DriveTrustedAutoService(sharing=sharing, bulk=bulk, wake=wake)
    assert (
        await service.share_available(user_id="owner", request_id=str(uuid4()), max_batches=2) == 2
    )
    assert [len(batch) for batch in prepared] == [25, 25]
    assert wakes == ["sharing", "sharing", "suggestions"]
    assert (
        await service.share_available(user_id="owner", request_id=str(uuid4()), max_batches=2) == 1
    )
    assert [len(batch) for batch in prepared] == [25, 25, 25]
    assert len(approved) == 3 and remaining == []
    assert bulk.refresh_request.await_count == 2


@pytest.mark.asyncio
async def test_old_progressive_bulk_notice_cannot_duplicate_request_event():
    from hushh_mcp.services.drive_bulk_share_worker import DriveBulkShareWorker

    send = AsyncMock()
    store = SimpleNamespace(
        claim_notification=AsyncMock(
            return_value={
                "share_id": str(uuid4()),
                "recipient_user_id": "recipient",
                "origin_request_id": str(uuid4()),
                "lease_id": str(uuid4()),
            }
        ),
        settle_notification=AsyncMock(return_value="settled"),
    )
    worker = DriveBulkShareWorker(
        store=store,
        send_push=send,
        adapter=SimpleNamespace(),
        oauth=SimpleNamespace(),
        verify_recipient=AsyncMock(),
        wake=AsyncMock(),
    )
    assert (
        await worker._notification({"share_id": str(uuid4()), "recipient_user_id": "recipient"})
        == "settled"
    )
    send.assert_not_awaited()
    store.settle_notification.assert_awaited_once()
    assert store.settle_notification.await_args.kwargs["delivered"] is True
