"""Forget another person's information once their grant ends (CONTRACT C3).

Measured on UAT 2026-09-28: after the owner revoked, the requester asked the
same chat again and One answered "Nopa" with no tool call. The shared block is
only ever in the answer turn's instruction (``temp:`` state), but One's ANSWER
is an ordinary model event in the sealed session history, and every later turn
replays it to the model.

The fix has three parts, each small:

* **Tag.** Each invocation that ran while shared information was live in the
  conversation (the answer turn, and every later turn until access ends) is
  recorded against the bundle in sealed session state
  (``hussh:consent_invocations:<bundle>``). Anything the model said in those
  turns may carry the information, so all of it is "derived from it".
* **Check.** Once per turn, before the model runs, each tagged bundle's current
  outcome is read through the requester-bound bundle view (an injected lookup,
  so a pod can supply its own). When access has ended the bundle is latched as
  ended in sealed state, and later turns skip the read. A failed read redacts
  for that turn only: the safe direction.
* **Redact.** Before every model call, the tagged invocations' model-authored
  contents (text, thoughts, tool calls and their responses) are replaced in the
  REQUEST with one neutral note. Stored sealed events are never mutated; ADK
  hands the callback shallow copies, and only the copy's ``parts`` is replaced.

The same state drives the history projection (``redaction_for_history``), so
the client renders those messages as "Access ended" and never receives the
text again.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Awaitable, Callable, Iterable, Mapping
from typing import Any

from hushh_mcp.one_adk.consent_continuation import (
    ACCESS_ENDED_OUTCOMES,
    CONSENT_SHARED_STATE_PREFIX,
    SHARED_OUTCOMES,
    STATE_CONSENT_CONTINUATION,
    consent_shared_state_key,
)

logger = logging.getLogger(__name__)

# Persisted (sealed): invocation ids that ran while the bundle's information was live.
CONSENT_INVOCATIONS_PREFIX = "hussh:consent_invocations:"
# Persisted (sealed): the bundle's access ended ("revoked" or "expired"); terminal.
CONSENT_ACCESS_ENDED_PREFIX = "hussh:consent_access_ended:"
# Per-invocation: {bundle_id: neutral note} for bundles to redact this turn.
STATE_ENDED_CONSENT = "temp:hussh:ended_consent_access"
MAX_TAGGED_INVOCATIONS = 200

BundleLookup = Callable[[str, str], Awaitable[Mapping[str, Any] | None]]


def consent_invocations_state_key(bundle_id: str) -> str:
    return f"{CONSENT_INVOCATIONS_PREFIX}{bundle_id.lower()}"


def consent_access_ended_state_key(bundle_id: str) -> str:
    return f"{CONSENT_ACCESS_ENDED_PREFIX}{bundle_id.lower()}"


def neutral_note(labels: Iterable[str] | None, person_name: str | None) -> str:
    """The text a redacted answer becomes in the model's context."""
    what = ", ".join(str(label) for label in labels or [] if str(label).strip()) or "information"
    who = str(person_name or "").strip() or "the other person"
    return f"Access to {what} from {who} ended; do not use or repeat it."


def _state_get(state: Any, key: str) -> Any:
    getter = getattr(state, "get", None)
    return getter(key) if callable(getter) else None


def _state_keys(state: Any) -> list[str]:
    if isinstance(state, Mapping):
        return [key for key in state if isinstance(key, str)]
    to_dict = getattr(state, "to_dict", None)
    if callable(to_dict):
        return [key for key in to_dict() if isinstance(key, str)]
    return []


def tagged_bundles(state: Any) -> dict[str, list[str]]:
    """Bundles whose shared information entered this conversation, with their invocations."""
    tagged: dict[str, list[str]] = {}
    for key in _state_keys(state):
        if not key.startswith(CONSENT_INVOCATIONS_PREFIX):
            continue
        value = _state_get(state, key)
        if isinstance(value, list):
            tagged[key[len(CONSENT_INVOCATIONS_PREFIX) :]] = [str(item) for item in value]
    return tagged


def _shared_record(state: Any, bundle_id: str) -> Mapping[str, Any]:
    record = _state_get(state, consent_shared_state_key(bundle_id))
    return record if isinstance(record, Mapping) else {}


def _note_for(state: Any, bundle_id: str) -> str:
    record = _shared_record(state, bundle_id)
    return neutral_note(record.get("labels"), record.get("personName"))


def _append_invocation(state: Any, bundle_id: str, invocation_id: str) -> None:
    key = consent_invocations_state_key(bundle_id)
    current = _state_get(state, key)
    invocations = [str(item) for item in current] if isinstance(current, list) else []
    if invocation_id and invocation_id not in invocations:
        # Assign a new list: ADK records a state delta only on assignment.
        state[key] = [*invocations, invocation_id][-MAX_TAGGED_INVOCATIONS:]


def access_ended_outcome(bundle: Mapping[str, Any] | None) -> str | None:
    """The ended outcome to latch, or None while shared access is still live."""
    if not isinstance(bundle, Mapping):
        return None
    progress = bundle.get("progress")
    if not isinstance(progress, Mapping):
        return None
    outcome = str(progress.get("outcome") or "")
    if outcome in ACCESS_ENDED_OUTCOMES:
        return outcome
    # A partial end (one field revoked while another stays granted) still ends
    # what the earlier answer may contain.
    if progress.get("ended_at"):
        return "revoked" if outcome != "expired" else outcome
    return None


async def track_consent_access(callback_context: Any, *, lookup: BundleLookup) -> None:
    """Before-agent: tag this invocation while shared access is live, latch its end.

    Pure over its inputs apart from the injected ``lookup(owner_id, bundle_id)``,
    which must be requester-bound (a bundle the owner did not send is absent).
    """
    state = getattr(callback_context, "state", None)
    if state is None:
        return
    invocation_id = str(getattr(callback_context, "invocation_id", "") or "")
    owner_id = str(getattr(callback_context, "user_id", "") or "")
    continuation = _state_get(state, STATE_CONSENT_CONTINUATION)
    current_bundle = ""
    if isinstance(continuation, Mapping):
        current_bundle = str(continuation.get("bundleId") or "").lower()
        current_outcome = str(continuation.get("outcome") or "")
        if current_outcome in SHARED_OUTCOMES:
            _append_invocation(state, current_bundle, invocation_id)
        elif current_outcome in ACCESS_ENDED_OUTCOMES:
            state[consent_access_ended_state_key(current_bundle)] = current_outcome

    ended: dict[str, str] = {}
    for bundle_id in tagged_bundles(state):
        if _state_get(state, consent_access_ended_state_key(bundle_id)):
            ended[bundle_id] = _note_for(state, bundle_id)
            continue
        if bundle_id == current_bundle:
            continue  # the answer turn itself: access was just confirmed live
        try:
            outcome = access_ended_outcome(await lookup(owner_id, bundle_id))
        except Exception as exc:  # noqa: BLE001 - unknown means redact, this turn only
            logger.warning("one.consent_access_check_failed error=%s", type(exc).__name__)
            ended[bundle_id] = _note_for(state, bundle_id)
            continue
        if outcome:
            state[consent_access_ended_state_key(bundle_id)] = outcome
            ended[bundle_id] = _note_for(state, bundle_id)
        else:
            _append_invocation(state, bundle_id, invocation_id)
    if ended:
        state[STATE_ENDED_CONSENT] = ended


def _part_key(part: Any) -> list[Any]:
    function_call = getattr(part, "function_call", None)
    function_response = getattr(part, "function_response", None)
    return [
        getattr(part, "text", None),
        bool(getattr(part, "thought", None)),
        getattr(function_call, "name", None),
        getattr(function_call, "args", None),
        getattr(function_response, "name", None),
        getattr(function_response, "response", None),
    ]


def _content_key(content: Any) -> str | None:
    parts = getattr(content, "parts", None)
    if not parts:
        return None
    keys = [_part_key(part) for part in parts]
    if not any(any(value not in (None, False) for value in key) for key in keys):
        return None
    return json.dumps(keys, default=str, sort_keys=True)


def redact_ended_consent_context(callback_context: Any, llm_request: Any) -> int:
    """Before-model: replace ended bundles' tagged contents in the request. Returns count."""
    state = getattr(callback_context, "state", None)
    ended = _state_get(state, STATE_ENDED_CONSENT) if state is not None else None
    if not isinstance(ended, Mapping) or not ended:
        return 0
    notes_by_invocation: dict[str, str] = {}
    for bundle_id, invocations in tagged_bundles(state).items():
        note = ended.get(bundle_id)
        if note:
            for invocation_id in invocations:
                notes_by_invocation[invocation_id] = str(note)
    session = getattr(callback_context, "session", None)
    notes_by_content: dict[str, str] = {}
    for event in getattr(session, "events", None) or []:
        note = notes_by_invocation.get(str(getattr(event, "invocation_id", "") or ""))
        # The person's own words stay; everything the agent side produced goes.
        if not note or getattr(event, "author", "") == "user":
            continue
        key = _content_key(getattr(event, "content", None))
        if key:
            notes_by_content[key] = note
    if not notes_by_content:
        return 0
    from google.genai import types as genai_types

    redacted = 0
    for content in getattr(llm_request, "contents", None) or []:
        note = notes_by_content.get(_content_key(content) or "")
        if note:
            # ``content`` is ADK's per-request shallow copy; the stored event keeps its parts.
            content.parts = [genai_types.Part(text=note)]
            content.role = "model"
            redacted += 1
    return redacted


def consent_answer_fast_path(callback_context: Any, llm_request: Any, *, model: str | None) -> bool:
    """Before-model: the answer turn runs at the lowest thinking level and calls no tools.

    Assigns fresh config objects: ADK's request config is a shallow copy, so
    mutating the agent's own ``thinking_config`` would leak into later turns.
    """
    state = getattr(callback_context, "state", None)
    if not isinstance(_state_get(state, STATE_CONSENT_CONTINUATION), Mapping):
        return False
    config = getattr(llm_request, "config", None)
    if config is None:
        return False
    from google.genai import types as genai_types

    from hushh_mcp.runtime_providers.gemini_config import thinking_config_for

    resolved = thinking_config_for(model, "minimal", genai_types)
    config.thinking_config = genai_types.ThinkingConfig(
        include_thoughts=False,
        thinking_level=getattr(resolved, "thinking_level", None),
    )
    config.tool_config = genai_types.ToolConfig(
        function_calling_config=genai_types.FunctionCallingConfig(
            mode=genai_types.FunctionCallingConfigMode.NONE
        )
    )
    return True


def redaction_for_history(state: Any) -> tuple[dict[str, str], dict[str, str]]:
    """For the history projection: ``(invocation_id -> bundle_id, bundle_id -> ended outcome)``."""
    bundle_by_invocation: dict[str, str] = {}
    for bundle_id, invocations in tagged_bundles(state).items():
        for invocation_id in invocations:
            bundle_by_invocation.setdefault(invocation_id, bundle_id)
    ended = {
        bundle_id: str(_state_get(state, consent_access_ended_state_key(bundle_id)))
        for bundle_id in tagged_bundles(state)
        if _state_get(state, consent_access_ended_state_key(bundle_id))
    }
    return bundle_by_invocation, ended


def shared_record_for_history(state: Any, bundle_id: str) -> dict[str, Any]:
    """Labels and name for the "Access ended" card; no values."""
    record = _shared_record(state, bundle_id)
    labels = record.get("labels")
    return {
        "personName": str(record.get("personName") or "") or None,
        "labels": [str(label) for label in labels] if isinstance(labels, list) else [],
    }


__all__ = [
    "CONSENT_ACCESS_ENDED_PREFIX",
    "CONSENT_INVOCATIONS_PREFIX",
    "CONSENT_SHARED_STATE_PREFIX",
    "STATE_ENDED_CONSENT",
    "consent_access_ended_state_key",
    "consent_answer_fast_path",
    "consent_invocations_state_key",
    "neutral_note",
    "redact_ended_consent_context",
    "redaction_for_history",
    "shared_record_for_history",
    "tagged_bundles",
    "track_consent_access",
]
