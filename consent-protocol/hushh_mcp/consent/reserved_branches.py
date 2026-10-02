"""Which PKM branches an app feature owns, and which writers may change them.

The Python half of ``contracts/pkm/reserved-branches.v1.json``. The TypeScript
half is ``hushh-webapp/lib/pkm/reserved-branches.ts``; the contract exists so
the two read one list instead of drifting, the same reason
``internal-path-keys.v1.json`` exists.

Phase 0 is shadow mode. :func:`evaluate_reserved_write` answers "would this
write be refused", and the store route only LOGS the answer. Nothing here
refuses a write yet.

Loading is lazy and cached. The packaged MCP runtime
(``packages/hushh-mcp/scripts/stage-runtime.mjs``) copies ``hushh_mcp`` but no
``contracts/`` directory, so reading the file at import time would break any
module that merely imports this one there.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass
from functools import lru_cache
from typing import Literal

from hushh_mcp.services.generated_contracts import generated_contract_path

_CONTRACT_PATH = generated_contract_path("pkm", "reserved-branches.v1.json")

WILDCARD_BRANCH = "*"

WriterClass = Literal["feature", "memory_agent", "migration"]
RefusalReason = Literal["writer_unknown", "memory_agent", "writer_not_listed"]

_WRITER_CLASSES: frozenset[str] = frozenset({"feature", "memory_agent", "migration"})


@dataclass(frozen=True)
class ReservedWriter:
    writer_id: str
    feature: str
    writer_class: WriterClass
    surfaces: tuple[str, ...]
    authorization_modes: tuple[str, ...]
    requires_capability: str | None


@dataclass(frozen=True)
class ReservedEntry:
    domain: str
    branch_prefix: str
    except_prefixes: tuple[str, ...]
    owner_feature: str
    writer_ids: frozenset[str]
    agent_memory_sibling: str | None
    shareable: str
    send_to_model: str


@dataclass(frozen=True)
class ReservedRefusal:
    """One would-be refusal. Carries labels only, never a stored value."""

    domain: str
    branch: str
    writer_id: str
    reason: RefusalReason


def _normalize_path(path: str | None) -> str:
    segments = [segment.strip().lower() for segment in str(path or "").split(".")]
    return ".".join(segment for segment in segments if segment)


def _is_at_or_below(path: str, prefix: str) -> bool:
    return path == prefix or path.startswith(prefix + ".")


@lru_cache(maxsize=1)
def _contract() -> dict:
    with _CONTRACT_PATH.open("r", encoding="utf-8") as handle:
        return json.load(handle)


@lru_cache(maxsize=1)
def _writers() -> dict[str, ReservedWriter]:
    writers: dict[str, ReservedWriter] = {}
    for writer_id, raw in _contract()["writers"].items():
        if writer_id.startswith("$"):
            continue
        writer_class = str(raw["class"])
        if writer_class not in _WRITER_CLASSES:
            raise ValueError(f"reserved_branches_writer_class_invalid:{writer_id}")
        writers[writer_id] = ReservedWriter(
            writer_id=writer_id,
            feature=str(raw["feature"]),
            writer_class=writer_class,  # type: ignore[arg-type]
            surfaces=tuple(raw["surfaces"]),
            authorization_modes=tuple(raw["authorization_modes"]),
            requires_capability=raw.get("requires_capability"),
        )
    return writers


@lru_cache(maxsize=1)
def _entries() -> tuple[ReservedEntry, ...]:
    return tuple(
        ReservedEntry(
            domain=str(raw["domain"]).strip().lower(),
            branch_prefix=str(raw["branch_prefix"]).strip().lower(),
            except_prefixes=tuple(_normalize_path(item) for item in raw["except"]),
            owner_feature=str(raw["owner_feature"]),
            writer_ids=frozenset(raw["writer_ids"]),
            agent_memory_sibling=raw.get("agent_memory_sibling"),
            shareable=str(raw["shareable"]),
            send_to_model=str(raw["send_to_model"]),
        )
        for raw in _contract()["entries"]
    )


def registry_version() -> int:
    return int(_contract()["version"])


def writer(writer_id: str | None) -> ReservedWriter | None:
    """The catalogued writer for ``writer_id``, or None when it is unknown."""
    return _writers().get(str(writer_id or "").strip().lower())


def reserved_entry_for(domain: str | None, path: str | None) -> ReservedEntry | None:
    """The entry that reserves ``path`` (dotted, relative to ``domain``), if any.

    A ``*`` entry reserves the whole domain, including the domain root, apart
    from its ``except`` branches. Any other entry reserves its prefix and
    everything beneath it.
    """
    canonical_domain = str(domain or "").strip().lower()
    normalized = _normalize_path(path)
    for entry in _entries():
        if entry.domain != canonical_domain:
            continue
        if any(_is_at_or_below(normalized, item) for item in entry.except_prefixes):
            continue
        if entry.branch_prefix == WILDCARD_BRANCH:
            return entry
        if normalized and _is_at_or_below(normalized, entry.branch_prefix):
            return entry
    return None


def is_reserved_path(domain: str | None, path: str | None) -> bool:
    return reserved_entry_for(domain, path) is not None


def _branch_label(entry: ReservedEntry, path: str) -> str:
    if entry.branch_prefix != WILDCARD_BRANCH:
        return entry.branch_prefix
    head = path.split(".", 1)[0]
    return head or WILDCARD_BRANCH


def evaluate_reserved_write(
    *, domain: str | None, paths: Iterable[str | None], writer_id: str | None
) -> list[ReservedRefusal]:
    """Every reserved branch this write touches that its writer may not change.

    Rules, identical on the device: an unknown writer is refused; a
    ``migration`` writer is never refused here (its authority is the
    server-verified upgrade claim); a ``memory_agent`` writer is refused on
    every reserved branch; any other writer is refused unless the entry lists it.
    """
    canonical_domain = str(domain or "").strip().lower()
    normalized_writer = str(writer_id or "").strip().lower()
    catalogued = writer(normalized_writer)
    if catalogued is not None and catalogued.writer_class == "migration":
        return []
    refusals: dict[tuple[str, str], ReservedRefusal] = {}
    for raw_path in paths:
        normalized = _normalize_path(raw_path)
        entry = reserved_entry_for(canonical_domain, normalized)
        if entry is None:
            continue
        if catalogued is None:
            reason: RefusalReason = "writer_unknown"
        elif catalogued.writer_class == "memory_agent":
            reason = "memory_agent"
        elif normalized_writer not in entry.writer_ids:
            reason = "writer_not_listed"
        else:
            continue
        branch = _branch_label(entry, normalized)
        refusals.setdefault(
            (branch, reason),
            ReservedRefusal(
                domain=canonical_domain,
                branch=branch,
                writer_id=normalized_writer,
                reason=reason,
            ),
        )
    return list(refusals.values())
