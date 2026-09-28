"""The one human name for a requestable ``attr.*`` scope.

Measured on UAT 2026-09-28: a person asking about a connection's favorite
restaurant saw "Preferences Entities Entities Summary" and "Food Domain". Both
came from host fallbacks that title-cased a storage path
(``path.replace("_", " ").title()`` and ``f"{domain.title()} Domain"`` in
``scope_generator``). This module is where that fallback is done properly, once,
for every surface that names a scope to a person: the request catalog, the
proposal card, and request progress (``progress.fields[].label``).

It never overrides an authored label. A stored label is replaced only when it
is recognisably mechanical: every word it contains already appears in the
scope's own domain or path, it ends in "Domain", or it repeats a word. A label
the PKM agent or the owner wrote ("Go-to weeknight spots") is kept verbatim,
because a label a person reads at the moment they decide to share is a
semantic judgement (``docs/reference/backend-semantic-boundary.md``) and host
code does not get to re-derive it.

Pure: no database, no network, no model.
"""

from __future__ import annotations

import re
from itertools import pairwise

from hushh_mcp.consent.pkm_scope_policy import normalize_pkm_scope
from hushh_mcp.consent.segment_labels import humanize_segment, looks_like_opaque_id
from hushh_mcp.services.domain_contracts import get_canonical_domain_metadata

# Manifest grammar and container words: they describe how a record is stored,
# never what it is about.
_STRUCTURAL_SEGMENTS = frozenset(
    {
        "_entities",
        "_items",
        "collection",
        "data",
        "entities",
        "entries",
        "fields",
        "items",
        "list",
        "records",
        "root",
        "values",
    }
)
# Words that say nothing on their own. "Preferences" needs its domain to mean
# anything; "Fitness goals" does not.
_GENERIC_WORDS = frozenset(
    {
        "basics",
        "details",
        "favorites",
        "history",
        "info",
        "information",
        "notes",
        "overview",
        "preference",
        "preferences",
        "profile",
        "settings",
        "status",
        "summary",
    }
)
_WORD = re.compile(r"[a-z0-9]+")


def _words(text: str | None) -> list[str]:
    return _WORD.findall(str(text or "").lower())


def _sentence_case(text: str) -> str:
    words = str(text or "").split()
    if not words:
        return ""
    cased = []
    for index, word in enumerate(words):
        # Keep acronyms (RIA, SSN) as written; lower-case everything else.
        keep = len(word) > 1 and word.isupper()
        lowered = word if keep else word.lower()
        cased.append(lowered[:1].upper() + lowered[1:] if index == 0 else lowered)
    return " ".join(cased)


def human_domain_label(domain: str | None) -> str:
    """ "Food & dining" for ``food``; a humanized slug for a dynamic domain."""
    key = str(domain or "").strip().lower()
    if not key:
        return "Information"
    meta = get_canonical_domain_metadata(key)
    return _sentence_case(meta.display_name if meta else humanize_segment(key)) or "Information"


def _domain_noun(domain: str) -> str:
    """The short subject word: "Food" for "Food & Dining", "Health" for "Health & Wellness"."""
    return human_domain_label(domain).split("&", 1)[0].strip() or "Information"


def _meaningful_segments(path: str) -> list[str]:
    segments: list[str] = []
    for raw in str(path or "").split("."):
        segment = raw.strip()
        if not segment or segment == "*" or segment.lower() in _STRUCTURAL_SEGMENTS:
            continue
        if looks_like_opaque_id(segment):
            continue
        if segments and segments[-1].lower() == segment.lower():
            continue
        segments.append(segment)
    # A trailing "summary" names the storage shape of its parent, not a thing.
    if len(segments) > 1 and segments[-1].lower() == "summary":
        segments.pop()
    return segments


def _is_generic(segment: str) -> bool:
    words = _words(humanize_segment(segment))
    return bool(words) and all(word in _GENERIC_WORDS for word in words)


def _is_mechanical_label(label: str, domain: str, path: str) -> bool:
    words = _words(label)
    if not words:
        return True
    if words[-1] == "domain":
        return True
    if any(left == right for left, right in pairwise(words)):
        return True
    vocabulary = {
        *_words(domain.replace("_", " ")),
        *_words(path.replace("_", " ").replace(".", " ")),
        *_words(human_domain_label(domain)),
        "attr",
        "domain",
    }
    return set(words) <= vocabulary


def human_scope_label(scope: str | None, label: str | None = None) -> str:
    """The name a person reads for a scope: "Food preferences", never a storage path.

    ``label`` is the stored label, if any. It is returned unchanged (whitespace
    folded) unless it is mechanical; see the module docstring for that test.
    """
    stored = " ".join(str(label or "").split())
    domain, path = normalize_pkm_scope(scope)
    if not domain:
        return stored or "Information"
    if stored and not _is_mechanical_label(stored, domain, path):
        return stored

    segments = _meaningful_segments(path)
    if not segments:
        return f"{human_domain_label(domain)} information"
    leaf = segments[-1]
    if _is_generic(leaf):
        parent = next((s for s in reversed(segments[:-1]) if not _is_generic(s)), None)
        prefix = humanize_segment(parent) if parent else _domain_noun(domain)
        return _sentence_case(f"{prefix} {humanize_segment(leaf)}")
    parent = segments[-2] if len(segments) > 1 else None
    if parent and not _is_generic(parent):
        return _sentence_case(f"{humanize_segment(parent)} {humanize_segment(leaf)}")
    return _sentence_case(humanize_segment(leaf))


__all__ = ["human_domain_label", "human_scope_label"]
