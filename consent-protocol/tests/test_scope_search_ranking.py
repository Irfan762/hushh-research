# tests/test_scope_search_ranking.py
"""
Unit tests for the deterministic scope-search ranking used by the
``search_user_scopes`` MCP tool.

Guardrails under test:
- Ranking is deterministic and pure (no LLM/DB/network).
- Least-privilege first: within a tier the narrowest (longest) scope wins.
- Exact domain match beats substring which beats fuzzy.
- Graceful lookups never raise: unknown query/domain returns an empty list.
- ``limit`` is clamped to [1, 500].
- The public ``request_consent`` tool requires an explicit scope (no bundle
  expansion) and returns a SCOPE_REQUIRED error instead of a 500.
"""

import json

import pytest

from hushh_mcp.consent.scope_generator import rank_scope_matches


def _entries() -> list[dict]:
    return [
        {"scope": "attr.financial.portfolio.*", "domain": "financial", "label": "Portfolio"},
        {"scope": "attr.financial.*", "domain": "financial", "label": "Financial"},
        {"scope": "attr.health.metrics.*", "domain": "health", "label": "Health Metrics"},
        {"scope": "attr.location.recent.*", "domain": "location", "label": "Recent Location"},
    ]


def test_exact_domain_match_ranks_least_privilege_first():
    result = rank_scope_matches(_entries(), query="financial")
    scopes = [e["scope"] for e in result]
    # Both financial scopes match the domain exactly; the narrowest comes first.
    assert scopes == ["attr.financial.portfolio.*", "attr.financial.*"]
    assert all(e["match_reason"] == "exact_domain_match" for e in result)


def test_substring_match_on_leaf_intent():
    result = rank_scope_matches(_entries(), query="portfolio")
    assert [e["scope"] for e in result] == ["attr.financial.portfolio.*"]
    assert result[0]["match_reason"] == "substring_match"


def test_domain_filter_scopes_results():
    result = rank_scope_matches(_entries(), domain="health")
    assert [e["scope"] for e in result] == ["attr.health.metrics.*"]


def test_empty_query_lists_all_least_privilege_first():
    result = rank_scope_matches(_entries())
    scopes = [e["scope"] for e in result]
    # All entries listed; ordering is deterministic (least privilege, then alpha).
    assert set(scopes) == {
        "attr.financial.portfolio.*",
        "attr.financial.*",
        "attr.health.metrics.*",
        "attr.location.recent.*",
    }
    assert all(e["match_reason"] == "listed" for e in result)


def test_ranking_is_deterministic():
    first = [e["scope"] for e in rank_scope_matches(_entries(), query="financial")]
    second = [e["scope"] for e in rank_scope_matches(_entries(), query="financial")]
    assert first == second


def test_no_match_returns_empty_without_raising():
    assert rank_scope_matches(_entries(), query="zzz-nope", domain="nope") == []


def test_unknown_domain_returns_empty():
    assert rank_scope_matches(_entries(), domain="does-not-exist") == []


def test_limit_is_clamped_to_upper_bound():
    many = [
        {
            "scope": f"attr.financial.field_{index}",
            "domain": "financial",
            "label": f"Field {index}",
        }
        for index in range(600)
    ]
    assert len(rank_scope_matches(many, limit=999)) == 500


def test_limit_is_clamped_to_lower_bound():
    assert len(rank_scope_matches(_entries(), limit=0)) == 1


def test_invalid_limit_falls_back_to_default():
    # Non-numeric limit must not raise; falls back to the default of 20.
    result = rank_scope_matches(_entries() * 40, limit="not-a-number")  # type: ignore[arg-type]
    assert len(result) == 20


def test_malformed_entries_are_skipped():
    entries = [
        "not-a-dict",
        {"label": "no scope key"},
        {"scope": "   "},
        {"scope": "attr.financial.*", "domain": "financial"},
    ]
    result = rank_scope_matches(entries, query="financial")  # type: ignore[arg-type]
    assert [e["scope"] for e in result] == ["attr.financial.*"]


@pytest.mark.asyncio
async def test_request_consent_without_scope_returns_scope_required():
    from mcp_modules.tools import consent_tools as ct

    result = await ct.handle_request_consent({"user_id": "u_test"})
    assert isinstance(result, list) and result
    payload = json.loads(result[0].text)
    assert payload["status"] == "error"
    assert payload["error_code"] == "SCOPE_REQUIRED"
    # The hint must steer callers to discovery/search, never to a bundle.
    assert "search_user_scopes" in payload["hint"]
    assert "scope_bundle" not in payload["hint"]


# --- One picks, the person confirms (consent lifecycle Contract C4) ----------
# UAT 2026-09-28: "What is Kushal Trivedi's favorite restaurant?" took three
# model calls and showed 100 of 251 raw rows; "restaurant" matched nothing.


def _catalog() -> list[dict]:
    return [
        {"scopeRef": "psr_food", "label": "Food preferences", "domain": "food"},
        {"scopeRef": "psr_goals", "label": "Fitness goals", "domain": "health"},
        {"scopeRef": "psr_sleep", "label": "Sleep", "domain": "health"},
        {"scopeRef": "psr_movies", "label": "Favorite movies", "domain": "entertainment"},
        {
            "scopeRef": "psr_food_all",
            "label": "Food & dining information",
            "domain": "food",
            "wildcard": True,
        },
    ]


def test_favorite_restaurant_proposes_food_preferences():
    from hushh_mcp.consent.scope_matcher import match_scopes

    best = match_scopes(
        _catalog(),
        "What is Kushal Trivedi's favorite restaurant?",
        ignore_words=["Kushal Trivedi"],
    )
    # Narrowest food row first (least privilege), never the movies row that
    # only shares the word "favorite".
    assert [match.entry["scopeRef"] for match in best] == ["psr_food", "psr_food_all"]
    assert best[0].why == '"restaurant" relates to food & dining'


def test_training_proposes_a_fitness_goal():
    from hushh_mcp.consent.scope_matcher import match_scopes

    best = match_scopes(_catalog(), "what is he training for", limit=1)
    assert best[0].entry["scopeRef"] == "psr_goals"
    assert best[0].why == '"training" relates to health & wellness'


def test_unknown_question_matches_nothing_and_falls_back_to_top_domains():
    from hushh_mcp.consent.scope_matcher import fallback_scopes, match_scopes

    assert match_scopes(_catalog(), "blood type") == []
    fallback = fallback_scopes(_catalog(), limit=3)
    # Largest domains first; the whole-domain row represents food.
    assert [match.entry["scopeRef"] for match in fallback] == [
        "psr_food_all",
        "psr_sleep",
        "psr_movies",
    ]
    assert {match.via for match in fallback} == {"fallback"}


def test_negative_control_without_synonyms_restaurant_finds_nothing():
    from hushh_mcp.consent.scope_matcher import match_scopes

    assert match_scopes(_catalog(), "favorite restaurant", use_synonyms=False) == []


@pytest.mark.parametrize(
    ("scope", "stored", "expected"),
    [
        (
            "attr.food.preferences.entities.entities.summary",
            "Preferences Entities Entities Summary",
            "Food preferences",
        ),
        ("attr.food.*", "Food Domain", "Food & dining information"),
        ("attr.health.fitness_goals.*", "Fitness Goals", "Fitness goals"),
        ("attr.professional.employment.entities.entities.title", None, "Employment title"),
        ("attr.ria.*", None, "RIA information"),
        # An authored label is a semantic judgement and is never rewritten.
        ("attr.food.weeknight", "Go-to weeknight spots", "Go-to weeknight spots"),
    ],
)
def test_human_scope_labels(scope, stored, expected):
    from hushh_mcp.consent.scope_labels import human_scope_label

    assert human_scope_label(scope, stored) == expected
