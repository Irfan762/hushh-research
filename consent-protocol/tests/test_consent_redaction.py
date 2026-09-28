"""After a grant ends, One's model context no longer holds what was shared (CONTRACT C3).

The regression, measured on UAT 2026-09-28: the owner revoked, the requester
asked the same chat again, and One answered "Nopa" with no tool call, because
its earlier answer was still replayed from the sealed session history.

These run the real One text agent through a real ADK Runner with a model that
records every request, so they prove what the provider would actually receive,
not what a helper returns. The negative control removes only the redaction
step and shows the answer comes back.
"""

from __future__ import annotations

from typing import Any

import pytest
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types
from pydantic import PrivateAttr

from hushh_mcp.one_adk import agent_tree
from hushh_mcp.one_adk.consent_continuation import (
    STATE_CONSENT_CONTINUATION,
    consent_outcome_state_key,
    consent_shared_state_key,
)
from hushh_mcp.one_adk.consent_redaction import (
    consent_access_ended_state_key,
    consent_invocations_state_key,
    redaction_for_history,
)
from hushh_mcp.one_adk.request_secrets import store_request_secret

BUNDLE = "0f0e0d0c-0b0a-4908-8706-050403020100"
OWNER = "requester-uid"


class _RecordingModel(BaseLlm):
    _answers: list = PrivateAttr()
    _requests: list = PrivateAttr(default_factory=list)

    def __init__(self, answers: list[str]) -> None:
        super().__init__(model="gemini-3.6-flash")
        self._answers = answers

    async def generate_content_async(self, llm_request, stream=False):
        self._requests.append(llm_request.model_copy(deep=True))
        yield LlmResponse(
            content=types.Content(role="model", parts=[types.Part(text=self._answers.pop(0))])
        )


def _request_text(llm_request: Any) -> str:
    return "\n".join(
        str(part.text or "")
        for content in llm_request.contents or []
        for part in content.parts or []
    )


class _Ledger:
    """The requester-bound bundle view, switchable from granted to revoked."""

    def __init__(self) -> None:
        self.outcome = "granted"
        self.reads: list[tuple[str, str]] = []

    async def __call__(self, owner_id: str, bundle_id: str) -> dict[str, Any]:
        self.reads.append((owner_id, bundle_id))
        ended = self.outcome in {"revoked", "expired"}
        return {
            "bundleId": bundle_id,
            "progress": {
                "outcome": self.outcome,
                "ended_at": "2026-09-28T20:00:00+00:00" if ended else None,
            },
        }


async def _turn(runner: Runner, text: str, state_delta: dict | None = None) -> None:
    async for _event in runner.run_async(
        user_id=OWNER,
        session_id="chat",
        new_message=types.Content(role="user", parts=[types.Part(text=text)]),
        state_delta=state_delta,
    ):
        pass


async def _conversation(
    monkeypatch, *, redact: bool
) -> tuple[_RecordingModel, InMemorySessionService]:
    ledger = _Ledger()
    monkeypatch.setattr(agent_tree, "_requester_bundle", ledger)
    if not redact:
        # Negative control: everything else (tagging, the ledger read, the
        # latch) still runs; only the request rewrite is removed.
        monkeypatch.setattr(agent_tree, "redact_ended_consent_context", lambda *_: 0)
    model = _RecordingModel(
        [
            "Her favorite restaurant is Nopa.",
            "Nopa is on Divisadero.",
            "I no longer have that; I can ask her again.",
        ]
    )
    agent = agent_tree.build_one_text_agent(model=model)
    agent.instruction = "Fixture root."
    agent.tools = []
    sessions = InMemorySessionService()
    await sessions.create_session(app_name="one", user_id=OWNER, session_id="chat")
    runner = Runner(agent=agent, app_name="one", session_service=sessions)

    # 1. The answer turn: what the admission in agent_chat.py hands the agent.
    await _turn(
        runner,
        "Consent approved",
        {
            consent_outcome_state_key(BUNDLE): "granted",
            consent_shared_state_key(BUNDLE): {
                "personName": "Kushal",
                "labels": ["Food preferences"],
            },
            STATE_CONSENT_CONTINUATION: {
                "bundleId": BUNDLE,
                "outcome": "granted",
                "personName": "Kushal",
                "shared": store_request_secret("Favorite restaurant: Nopa"),
                "sharedLabels": ["Food preferences"],
                "declinedLabels": [],
            },
        },
    )
    # 2. A follow-up while access is live: its answer is derived from the share.
    await _turn(runner, "Where is it?")
    # 3. The owner revokes; the requester asks again in the same chat.
    ledger.outcome = "revoked"
    await _turn(runner, "Remind me where she likes to eat?")
    return model, sessions


@pytest.mark.asyncio
async def test_revoked_share_and_every_answer_derived_from_it_leave_the_model_context(
    monkeypatch,
) -> None:
    model, sessions = await _conversation(monkeypatch, redact=True)

    live_followup, after_revoke = model._requests[1], model._requests[2]
    # While access is live the earlier answer is context, as it should be.
    assert "Nopa" in _request_text(live_followup)
    # After revoke, neither the answer turn nor the follow-up survives.
    text = _request_text(after_revoke)
    assert "Nopa" not in text
    assert "Access to Food preferences from Kushal ended; do not use or repeat it." in text
    # The person's own words stay.
    assert "Where is it?" in text

    # The sealed events themselves are untouched; only the request changed.
    session = await sessions.get_session(app_name="one", user_id=OWNER, session_id="chat")
    stored = "\n".join(
        part.text or ""
        for event in session.events
        if event.content
        for part in event.content.parts or []
    )
    assert "Nopa is on Divisadero." in stored
    # Both tagged turns are projected as ended for the history the client renders.
    by_invocation, ended = redaction_for_history(session.state)
    assert ended == {BUNDLE: "revoked"}
    assert len(session.state[consent_invocations_state_key(BUNDLE)]) == 2
    assert set(by_invocation.values()) == {BUNDLE}
    assert session.state[consent_access_ended_state_key(BUNDLE)] == "revoked"


@pytest.mark.asyncio
async def test_negative_control_without_redaction_the_answer_is_replayed(monkeypatch) -> None:
    model, _sessions = await _conversation(monkeypatch, redact=False)
    assert "Nopa" in _request_text(model._requests[2])


@pytest.mark.asyncio
async def test_the_answer_turn_calls_no_tools_at_the_lowest_thinking_level(monkeypatch) -> None:
    model, _sessions = await _conversation(monkeypatch, redact=True)

    answer_turn, ordinary_turn = model._requests[0].config, model._requests[1].config
    assert answer_turn.tool_config.function_calling_config.mode == (
        types.FunctionCallingConfigMode.NONE
    )
    assert answer_turn.thinking_config.include_thoughts is False
    # MINIMAL is coerced to LOW for a supported release: the lowest it accepts.
    assert str(answer_turn.thinking_config.thinking_level).upper().endswith("LOW")
    # The fast path never leaks into the next turn through the shared agent config.
    assert ordinary_turn.tool_config is None
