from hushh_mcp.onboarding_contract import (
    SETUP_CAPABILITY_ORDER,
    SETUP_PREREQUISITE_ORDER,
    normalize_one_chat_onboarding,
    normalize_setup_capability_declined_ids,
    normalize_setup_capability_id,
    normalize_setup_capability_ids,
)


def test_setup_capability_contract_has_exact_product_order() -> None:
    assert SETUP_CAPABILITY_ORDER == (
        "gmail",
        "calendar",
        "location",
        "email",
        "finance",
        "ria",
        "connected-systems",
    )
    assert SETUP_PREREQUISITE_ORDER == ("connections",)


def test_setup_capability_normalization_drops_retired_and_malformed_ids() -> None:
    assert normalize_setup_capability_ids(
        [
            "finance",
            " gmail ",
            "calendar",
            "marketplace",
            "connections",
            "pkm",
            "gmail",
            None,
        ]
    ) == ["connections", "gmail", "calendar", "finance"]
    assert normalize_setup_capability_id(" connected-systems ") == "connected-systems"
    assert normalize_setup_capability_id(" calendar ") == "calendar"
    assert normalize_setup_capability_id("consent") is None


def test_declined_capability_normalization_excludes_the_mandatory_prerequisite() -> None:
    # "connections" is mandatory and can never be declined, even if a caller
    # somehow supplies it -- unlike normalize_setup_capability_ids, which
    # legitimately carries it as the AI-access-choice marker.
    assert normalize_setup_capability_declined_ids(
        [
            "gmail",
            " calendar ",
            "connections",
            "marketplace",
            "gmail",
            None,
        ]
    ) == ["gmail", "calendar"]
    assert normalize_setup_capability_declined_ids([]) == []
    assert normalize_setup_capability_declined_ids(None) == []
    assert normalize_setup_capability_declined_ids("not-a-list") == []


def test_chat_onboarding_record_keeps_only_bounded_progress_never_answers() -> None:
    record = normalize_one_chat_onboarding(
        {
            "version": 1,
            "status": "in_progress",
            "answered": ["tone", "name", "name", "email", None],
            "skipped": ["focus", "name"],
            "completedOn": "2026-09-27",
            "tipDismissedOn": "not-a-date",
            # Negative control: answer values must never survive into the
            # plaintext row, whatever key a caller puts them under.
            "name": "Kushal",
            "tone": "casual",
            "answers": {"name": "Kushal"},
        }
    )
    assert record == {
        "version": 1,
        "status": "in_progress",
        "answered": ["name", "tone"],
        # Answered wins over skipped for the same question.
        "skipped": ["focus"],
        "completedOn": "2026-09-27",
        "tipDismissedOn": None,
    }
    assert "Kushal" not in repr(record)


def test_chat_onboarding_record_rejects_unknown_versions_and_statuses() -> None:
    assert normalize_one_chat_onboarding(None) is None
    assert normalize_one_chat_onboarding("{}") is None
    assert normalize_one_chat_onboarding({"version": 2, "status": "completed"}) is None
    assert normalize_one_chat_onboarding({"version": 1, "status": "done"}) is None
    assert normalize_one_chat_onboarding(
        {"version": 1, "status": "completed", "completedOn": "2026-02-31"}
    ) == {
        "version": 1,
        "status": "completed",
        "answered": [],
        "skipped": [],
        "completedOn": None,
        "tipDismissedOn": None,
    }
