"""The reserved-branch registry and its shadow-mode server hook.

``contracts/pkm/reserved-branches.v1.json`` decides which PKM branches belong to
an app feature and which writers may change them. Phase 0 only LOGS what it would
refuse, so these tests hold the contract and the log line to account before
anything enforces them: the copies agree, the rules match the TypeScript loader,
the server's own writer labels are catalogued, and the log line carries labels,
never a person's values. The webapp side, including the writer inventory, is
``hushh-webapp/__tests__/lib/pkm/reserved-branches.test.ts``.
"""

from __future__ import annotations

import logging
from types import SimpleNamespace

import pytest

from api.routes import pkm_routes_shared
from api.routes.pkm_routes_shared import StructureDecisionPayload
from hushh_mcp.consent import reserved_branches
from hushh_mcp.consent.reserved_branches import (
    evaluate_reserved_write,
    is_reserved_path,
    reserved_entry_for,
    writer,
)
from hushh_mcp.services.generated_contracts import BACKEND_ROOT, REPO_ROOT
from hushh_mcp.services.pkm_mutation_contracts import PkmMutationPlanV2

_RELATIVE = ("contracts", "pkm", "reserved-branches.v1.json")


def test_all_three_copies_are_byte_identical() -> None:
    canonical = REPO_ROOT.joinpath(*_RELATIVE).read_bytes()
    for mirror in (
        BACKEND_ROOT.joinpath(*_RELATIVE),
        REPO_ROOT.joinpath("hushh-webapp", *_RELATIVE),
    ):
        assert mirror.read_bytes() == canonical, (
            f"{mirror} drifted; copy the canonical file over it"
        )


def test_wildcard_domain_is_reserved_apart_from_its_except_branch() -> None:
    assert reserved_entry_for("financial", "portfolio.holdings").owner_feature == "finance"
    assert reserved_entry_for("financial", "") is not None
    assert reserved_entry_for("financial", "agent_memory") is None
    assert reserved_entry_for("financial", "agent_memory.entities.mem_1") is None


def test_prefix_matches_on_a_segment_boundary_never_a_substring() -> None:
    assert is_reserved_path("location", "Saved_Places.home.label")
    assert not is_reserved_path("location", "saved_places_archive")
    assert not is_reserved_path("location", "agent_memory")
    assert not is_reserved_path("food", "preferences")


def test_writer_rules_match_the_typescript_loader() -> None:
    paths = ["saved_places.home"]
    assert writer("not_a_registered_writer") is None
    assert [
        r.reason
        for r in evaluate_reserved_write(
            domain="location", paths=paths, writer_id="not_a_registered_writer"
        )
    ] == ["writer_unknown"]
    assert [
        r.reason
        for r in evaluate_reserved_write(
            domain="location", paths=paths, writer_id="agent_chat_owner_request"
        )
    ] == ["memory_agent"]
    assert [
        r.reason
        for r in evaluate_reserved_write(
            domain="location", paths=paths, writer_id="kai_dashboard_portfolio_save"
        )
    ] == ["writer_not_listed"]
    assert (
        evaluate_reserved_write(
            domain="location", paths=paths, writer_id="one_location_saved_place_confirm"
        )
        == []
    )
    assert (
        evaluate_reserved_write(
            domain="wallet", paths=["summary"], writer_id="pkm_upgrade_orchestrator"
        )
        == []
    )


def test_server_writer_labels_are_catalogued() -> None:
    """The labels the SERVER assigns when a client names no writer of its own."""
    assert writer(PkmMutationPlanV2.model_fields["writer_id"].default).feature == "unattributed"
    assert (
        writer(StructureDecisionPayload.model_fields["source_agent"].default).writer_class
        == "memory_agent"
    )
    assert writer("pkm_upgrade_orchestrator").writer_class == "migration"


def _request(*, writer_id: str, scope: str, json_paths: tuple[str, ...] = ()) -> SimpleNamespace:
    return SimpleNamespace(
        mutation_plan=SimpleNamespace(writer_id=writer_id, proposed_scope=scope),
        upgrade_claim=None,
        structure_decision=SimpleNamespace(
            source_agent="pkm_structure_agent",
            top_level_scope_paths=[scope],
            json_paths=list(json_paths),
        ),
    )


def _shadow_lines(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [r.getMessage() for r in caplog.records if "pkm.reserved_would_refuse" in r.getMessage()]


def test_shadow_logs_a_memory_agent_write_to_saved_places(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO, logger=pkm_routes_shared.logger.name)
    pkm_routes_shared._shadow_reserved_branch_write(
        _request(writer_id="agent_chat_owner_request", scope="saved_places"), "location"
    )
    assert _shadow_lines(caplog) == [
        "pkm.reserved_would_refuse domain=location branch=saved_places "
        "writer=agent_chat_owner_request reason=memory_agent"
    ]


def test_shadow_is_silent_for_the_location_writer(caplog: pytest.LogCaptureFixture) -> None:
    """Negative control: the writer the registry lists produces no line."""
    caplog.set_level(logging.INFO, logger=pkm_routes_shared.logger.name)
    pkm_routes_shared._shadow_reserved_branch_write(
        _request(writer_id="one_location_saved_place_confirm", scope="saved_places"), "location"
    )
    assert _shadow_lines(caplog) == []


def test_shadow_sees_a_reserved_structure_path_behind_an_agent_memory_scope(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO, logger=pkm_routes_shared.logger.name)
    pkm_routes_shared._shadow_reserved_branch_write(
        _request(
            writer_id="agent_chat_owner_request",
            scope="agent_memory",
            json_paths=("agent_memory.entities.mem_1", "identity_documents.passport_number"),
        ),
        "identity",
    )
    assert [line.split(" branch=")[1].split(" ")[0] for line in _shadow_lines(caplog)] == [
        "identity_documents"
    ]


def test_shadow_never_logs_an_unrecognized_client_label(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO, logger=pkm_routes_shared.logger.name)
    request = _request(writer_id="x", scope="saved_places")
    request.mutation_plan = None
    request.structure_decision.source_agent = "Mallory\npkm.reserved_would_refuse forged=1"
    pkm_routes_shared._shadow_reserved_branch_write(request, "location")
    lines = _shadow_lines(caplog)
    assert lines and all("Mallory" not in line and "\n" not in line for line in lines)
    assert "writer=unrecognized reason=writer_unknown" in lines[0]


def test_shadow_can_never_block_a_write(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    def broken(**_kwargs):
        raise RuntimeError("registry unreadable")

    monkeypatch.setattr(pkm_routes_shared, "evaluate_reserved_write", broken)
    caplog.set_level(logging.INFO, logger=pkm_routes_shared.logger.name)
    pkm_routes_shared._shadow_reserved_branch_write(
        _request(writer_id="agent_chat_owner_request", scope="saved_places"), "location"
    )
    assert any("pkm.reserved_shadow_unavailable" in r.getMessage() for r in caplog.records)


def test_loader_reads_lazily_so_the_packaged_runtime_can_import_it() -> None:
    """``stage-runtime.mjs`` ships ``hushh_mcp`` without ``contracts/``."""
    reserved_branches._contract.cache_clear()
    reserved_branches._writers.cache_clear()
    reserved_branches._entries.cache_clear()
    assert reserved_branches._contract.cache_info().currsize == 0
    assert reserved_branches.registry_version() == 1
