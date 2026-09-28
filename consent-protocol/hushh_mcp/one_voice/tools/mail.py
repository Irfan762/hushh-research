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
  counts, which are metadata the server already holds. Reading a message aloud
  would mean handing its text to the model to speak, which is the boundary
  above. Until a narration path exists that speaks a validated answer without
  the operational model holding it, the answer is shown, not spoken.
"""

from __future__ import annotations

import logging
from typing import Any

from pydantic import Field

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

# Reader statuses that mean "the read did not happen", as opposed to "it
# happened and found nothing". Conflating them would let a disconnected
# mailbox read as an empty one.
_UNAVAILABLE = {
    "connect_required",
    "reconnect_required",
    "connection_changed",
    "permission_denied",
    "source_changed",
    "response_too_large",
    "input_required",
}


class ReadMailInput(ToolInput):
    """The person's own question, forwarded to the planner unchanged.

    Not a command phrase and not parsed here: the planner owns turning it into
    exactly one bounded operation.
    """

    request: str = Field(min_length=1, max_length=MAX_REQUEST_BYTES)


class MailReadResult(ToolResult):
    """A mail answer for the screen, and a receipt for the model."""

    answer: str = ""
    sources: list[dict[str, Any]] = Field(default_factory=list)
    truncated: bool = False
    metadata_only: bool = True

    def model_public(self) -> dict[str, Any]:
        """A receipt. No sender, subject, snippet, body or derived summary.

        ``spoken_facts`` is rebuilt here from counts alone so the model has a
        truthful sentence to say without holding anything a sender wrote.
        """
        return {
            "status": self.status,
            "source_count": len(self.sources),
            "truncated": self.truncated,
            "spoken_facts": list(self.spoken_facts),
        }


def _spoken(count: int, truncated: bool) -> list[str]:
    """A line One can say that contains no mail content."""
    if count == 0:
        return ["I did not find any matching mail."]
    noun = "message" if count == 1 else "messages"
    more = " There may be more than I checked." if truncated else ""
    return [f"I found {count} {noun}. They are on your screen.{more}"]


async def _read_mail(ctx: ToolContext, args: ReadMailInput) -> ToolResult:
    if not connector_feature_enabled("gmail_chat_reads", ctx.user_id):
        return Rejected(reason_code="mail_reads_unavailable")

    gmail = ctx.services.get("gmail") or get_gmail_receipts_service()

    async def require_access() -> None:
        """Re-checked around every provider hop by the delegated read.

        Cheap and idempotent on purpose: it runs several times per read, and a
        mid-flight disconnect must stop the read rather than release what was
        already fetched.
        """
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
        )
    except PermissionError:
        return Rejected(reason_code="mail_reads_unavailable")

    structured = outcome.get("structured") or {}
    status = str(structured.get("status") or "")
    sources = list(structured.get("sources") or [])

    if status in _UNAVAILABLE:
        # The read did not happen. Say why, and never as an empty inbox.
        return Rejected(reason_code=status or "mail_read_failed")

    truncated = bool(structured.get("truncated"))
    return MailReadResult(
        status="ok" if sources else "empty",
        answer=str(outcome.get("response") or ""),
        sources=sources,
        truncated=truncated,
        metadata_only=bool(structured.get("metadata_only", True)),
        spoken_facts=_spoken(len(sources), truncated),
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
