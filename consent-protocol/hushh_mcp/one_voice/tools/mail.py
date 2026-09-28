"""Mail tools: answer the owner's questions about their own inbox.

Read only. Nothing here archives, labels, marks read, trashes, drafts or
sends; those stay on the typed-chat surface behind their own confirmation.

The read itself is not implemented here. It belongs to
``email_delegated_read``, which runs a planner that sees the person's request
and no mailbox contents, then a tool-less interpreter that sees bounded
untrusted evidence and cannot call anything. This module is the adapter that
lets One Live Voice reach that path, and the place where its result stops.

Two boundaries are load-bearing:

* **The model never receives mail.** ``MailReadResult.model_public`` returns a
  receipt -- a status and a count -- while the client frame carries the whole
  answer. The Live session keeps provider-side compressed context and a
  resumption handle for hours, so a sender's text placed there would outlive
  the turn and steer later ones. See ``ToolResult.model_public``.

* **One says how many, not what they say.** The spoken line is built from
  counts the server computed itself. Reading a message aloud would mean handing
  its text to the model to speak, which is the boundary above. Until a narration
  path exists that speaks a validated answer without the operational model
  holding it, the answer is shown, not spoken.

The counts are the server's, not the interpreter's. ``sources`` is the list of
refs the interpreter chose to cite; ten messages can be projected and three
cited. Saying "I found three" then reports a fact about a model's citation habit
as a fact about the person's mailbox, so every number One says comes from
``coverage``, which the reader computes after it knows what survived.
"""

from __future__ import annotations

import logging
from typing import Any

from pydantic import Field

from hushh_mcp.one_voice.config import OneVoiceMailAdmission
from hushh_mcp.one_voice.tools.base import (
    Rejected,
    ToolContext,
    ToolInput,
    ToolPolicy,
    ToolResult,
    ToolSpec,
)
from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.email_delegated_read import run_delegated_mail_read
from hushh_mcp.services.gmail_receipts_service import get_gmail_receipts_service

logger = logging.getLogger(__name__)

# The delegated read rejects anything longer than this itself; bounding it here
# keeps an oversized transcript out of the planner call entirely.
MAX_REQUEST_BYTES = 8000

# Injected by tests; built from the environment otherwise.
MAIL_ADMISSION_SERVICE = "voice_mail_admission"

# What One says when a read did not happen. Connection state and nothing else:
# no sender, subject or body, so the model boundary is untouched.
#
# The default matters more than the entries. Classification is an allowlist of
# success, not a denylist of failure, because `unavailable` covers a gene
# timeout, a malformed answer, and `invalid_mail_sources` -- the interpreter
# citing a source it was never given, which is how prompt injection shows up.
# Under a denylist that signal reported as an empty mailbox and counted as a
# successful turn.
_REJECT_SPOKEN = {
    "connect_required": "Mail isn't connected, so I couldn't look.",
    "reconnect_required": "Mail needs reconnecting before I can look.",
    "connection_changed": "Your Mail connection changed while I was looking. Nothing was read.",
    "permission_denied": "Mail didn't allow that read.",
    "source_changed": "The inbox changed while I was looking. Please ask again.",
    "response_too_large": "That search was too broad for me to read. Try narrowing it.",
    "invalid_argument": "I couldn't turn that into a search of your mail.",
}
_REJECT_DEFAULT = "I couldn't look at your mail just now."


class ReadMailInput(ToolInput):
    """The person's own question, forwarded to the planner unchanged.

    Not a command phrase and not parsed here: the planner owns turning it into
    exactly one bounded operation.
    """

    request: str = Field(min_length=1, max_length=MAX_REQUEST_BYTES)


# Every key the model may see. An allowlist, so a field added to coverage
# later cannot reach the model's context by being added to a dict.
_MODEL_COVERAGE_KEYS = (
    "operation",
    "unit",
    "assessed",
    "returned",
    "cited",
    "matches_beyond_page",
    "items_omitted",
    "content_shortened",
    "content_depth",
)

# Product words for what a row counts. A needs-reply row is a conversation.
_UNIT_NOUN = {
    "threads": ("conversation", "conversations"),
    "messages": ("message", "messages"),
}


class MailReadResult(ToolResult):
    """A mail answer for the screen, and a receipt for the model.

    ``items`` are the rows the person can be shown and can select; they carry
    what a sender wrote and so never reach ``model_public``. ``sources`` are the
    refs the interpreter cited, which mark rows the answer leaned on. ``coverage``
    is the server's own account of the work, and the only place a number spoken
    aloud may come from.
    """

    answer: str = ""
    sources: list[dict[str, Any]] = Field(default_factory=list)
    items: list[dict[str, Any]] = Field(default_factory=list)
    coverage: dict[str, Any] = Field(default_factory=dict)
    truncated: bool = False
    metadata_only: bool = True

    def model_public(self) -> dict[str, Any]:
        """A receipt. No sender, subject, snippet, body or derived summary.

        ``spoken_facts`` is recomputed from ``coverage`` rather than copied from
        the field, so the model's sentence cannot carry mail content even if
        something upstream later puts content in ``spoken_facts``.
        """
        return {
            "status": self.status,
            "coverage": {
                key: self.coverage[key] for key in _MODEL_COVERAGE_KEYS if key in self.coverage
            },
            "spoken_facts": _spoken(self.coverage),
        }


def _spoken(coverage: dict[str, Any]) -> list[str]:
    """A line One can say, built only from counts the server computed.

    An absent or non-integer ``returned`` stays unknown. Reporting it as zero
    would turn "I could not count" into "your mailbox is empty".
    """
    returned = coverage.get("returned")
    if not isinstance(returned, int):
        return ["I looked at your mail, but I can't tell you how much I found."]
    if returned == 0:
        return ["I did not find any matching mail."]
    singular, plural = _UNIT_NOUN.get(str(coverage.get("unit")), _UNIT_NOUN["messages"])
    noun = singular if returned == 1 else plural
    if coverage.get("content_depth") == "message":
        # The person asked to read something, so the count is of what was read.
        line = f"I have that {singular}." if returned == 1 else f"I have those {returned} {noun}."
    else:
        line = f"I found {returned} {noun}."
    if coverage.get("matches_beyond_page"):
        line += " There may be more I haven't checked."
    if coverage.get("items_omitted"):
        line += " Some results were left out to fit."
    if coverage.get("content_shortened"):
        line += " Some of the text was shortened."
    return [line]


def _unavailable(reason_code: str) -> Rejected:
    return Rejected(
        reason_code=reason_code,
        spoken_facts=["I can't look at your mail right now."],
    )


async def _read_mail(ctx: ToolContext, args: ReadMailInput) -> ToolResult:
    admission = ctx.service(MAIL_ADMISSION_SERVICE, OneVoiceMailAdmission)
    if not admission.mail_reads_enabled():
        return _unavailable("voice_mail_reads_disabled")
    if not connector_feature_enabled("gmail_chat_reads", ctx.user_id):
        return _unavailable("mail_reads_unavailable")

    gmail = ctx.services.get("gmail") or get_gmail_receipts_service()

    async def require_access() -> None:
        """Re-checked around every provider hop by the delegated read.

        Cheap and idempotent on purpose: it runs several times per read, and a
        mid-flight withdrawal must stop the read rather than release what was
        already fetched. The delegated read calls this at its entry, after the
        planner, either side of the Gmail fetch, and once more after
        interpretation, so one closure covers every hop.
        """
        if not admission.mail_reads_enabled():
            raise PermissionError("Voice mail reads are disabled")
        if not connector_feature_enabled("gmail_chat_reads", ctx.user_id):
            raise PermissionError("Mail read authority is unavailable")

    try:
        outcome = await run_delegated_mail_read(
            gmail=gmail,
            user_id=ctx.user_id,
            consent_token=ctx.vault_owner_token,
            conversation_id=ctx.conversation_id,
            message=args.request,
            require_access=require_access,
            # "Today" and "this week" are the owner's, not the server's.
            timezone=ctx.timezone,
        )
    except PermissionError:
        # Admission was withdrawn mid-read. Nothing fetched is released.
        return _unavailable(
            "mail_reads_unavailable"
            if admission.mail_reads_enabled()
            else "voice_mail_reads_disabled"
        )

    # The handler's return is the release point: a read needs no confirmation,
    # so nothing downstream checks authority again. Today the delegated read's
    # last check sits close enough to its return that this is redundant, but
    # that is an accident of its control flow rather than a promise.
    if not admission.mail_reads_enabled():
        return _unavailable("voice_mail_reads_disabled")

    structured = outcome.get("structured") or {}
    status = str(structured.get("status") or "")
    sources = list(structured.get("sources") or [])

    if status == "input_required":
        # The planner asked a question, or the request was unusable. Its text is
        # authored from the request alone and has seen no mailbox, so passing it
        # through is safe -- and dropping it would discard the only thing One
        # has to say.
        return Rejected(
            reason_code="mail_read_needs_input",
            spoken_facts=[
                str(outcome.get("response") or "What would you like to find in your inbox?")
            ],
        )
    if status != "ok":
        # Anything that is not a successful read did not happen. Never an empty
        # inbox: "I found nothing" and "I could not look" are different answers
        # and the person acts differently on each.
        return Rejected(
            reason_code=status or "mail_read_failed",
            spoken_facts=[_REJECT_SPOKEN.get(status, _REJECT_DEFAULT)],
        )

    coverage = dict(outcome.get("coverage") or {})
    items = list(outcome.get("items") or [])
    returned = coverage.get("returned")
    # A successful read with nothing in it is "empty". Anything else is "ok",
    # including a read whose count the server could not establish, because a
    # read did happen and calling it empty would be a claim about the mailbox.
    return MailReadResult(
        status="empty" if returned == 0 else "ok",
        answer=str(outcome.get("response") or ""),
        sources=sources,
        items=items,
        coverage=coverage,
        truncated=bool(structured.get("truncated")),
        metadata_only=bool(structured.get("metadata_only", True)),
        spoken_facts=_spoken(coverage),
        ui_refresh=["mail"],
    )


TOOLS: tuple[ToolSpec, ...] = (
    ToolSpec(
        name="read_mail",
        gateway_action_id="email.chat.turn",
        policy=ToolPolicy.read,
        input_model=ReadMailInput,
        output_model=MailReadResult,
        description=(
            "Answer a question about the person's own mailbox: recent or unread mail, "
            "mail from someone, what needs a reply, or what a specific message says. "
            "Shows the matching messages and says how many were found. "
            "Reading never marks mail read and never archives, sends or deletes anything."
        ),
        handler=_read_mail,
        ui_refresh=("mail",),
    ),
)
