"""Keep the scheduled-mail scheduler UAT-only, OIDC-only and pinned to its drain."""

from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "deploy" / "gmail" / "setup_scheduled_mail_scheduler.sh"
UAT_WORKFLOW = ROOT / ".github" / "workflows" / "deploy-uat.yml"
PRODUCTION_WORKFLOW = ROOT / ".github" / "workflows" / "deploy-production.yml"
URI = "https://api.uat.hushh.ai/api/one/email/scheduled/drain?limit=50"
SERVICE_ACCOUNT = "mail-scheduled-send@hushh-pda-uat.iam.gserviceaccount.com"


def _run_scheduler_with(tmp_path: Path, **overrides: str) -> subprocess.CompletedProcess[str]:
    """Run the real script with a gcloud stand-in that records any call."""
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir(exist_ok=True)
    calls = tmp_path / "gcloud-calls"
    fake_gcloud = fake_bin / "gcloud"
    fake_gcloud.write_text(f'#!/usr/bin/env bash\necho "$@" >> "{calls}"\nexit 97\n')
    fake_gcloud.chmod(0o755)
    environment = os.environ.copy()
    environment.update(
        {
            "PATH": f"{fake_bin}:{environment['PATH']}",
            "PROJECT_ID": "hushh-pda-uat",
            "BACKEND_URL": "https://api.uat.hushh.ai",
            "OIDC_AUDIENCE": "https://api.uat.hushh.ai",
            **overrides,
        }
    )
    result = subprocess.run(  # noqa: S603 - fixed repository-owned shell helper
        ["bash", str(SCRIPT)],
        env=environment,
        capture_output=True,
        check=False,
        text=True,
    )
    result.gcloud_calls = calls.read_text() if calls.exists() else ""  # type: ignore[attr-defined]
    return result


def test_script_is_executable_and_never_mutates_runtime_iam():
    source = SCRIPT.read_text(encoding="utf-8")

    assert SCRIPT.stat().st_mode & stat.S_IXUSR
    assert 'readonly UAT_PROJECT_ID="hushh-pda-uat"' in source
    assert 'readonly UAT_BACKEND_ORIGIN="https://api.uat.hushh.ai"' in source
    assert 'URI="${BACKEND_URL}/api/one/email/scheduled/drain?limit=${BATCH_LIMIT}"' in source
    assert "--oidc-service-account-email" in source and "--oidc-token-audience" in source
    assert "roles/iam.serviceAccountTokenCreator" not in source
    assert "add-iam-policy-binding" not in source
    assert "run services update" not in source


def test_dry_run_prints_the_exact_oidc_job_without_calling_gcloud(tmp_path: Path):
    result = _run_scheduler_with(tmp_path, DRY_RUN="1")

    assert result.returncode == 0, result.stderr
    assert result.gcloud_calls == ""  # type: ignore[attr-defined]
    lines = [line for line in result.stdout.splitlines() if line.startswith("+ ")]
    assert [line.split()[1:5] for line in lines] == [
        ["gcloud", "iam", "service-accounts", "create"],
        ["gcloud", "scheduler", "jobs", "update"],
        ["gcloud", "scheduler", "jobs", "create"],
    ]
    for job in lines[1:]:
        assert " mail-scheduled-send-uat " in job
        assert "'--schedule=* * * * *'" in job
        assert f"'--uri={URI}'" in job
        assert "--http-method=POST" in job
        assert f"--oidc-service-account-email={SERVICE_ACCOUNT}" in job
        assert "--oidc-token-audience=https://api.uat.hushh.ai" in job
        assert "--time-zone=Etc/UTC" in job
        assert "--attempt-deadline=300s" in job


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"PROJECT_ID": "hushh-pda"}, "limited to hushh-pda-uat"),
        (
            {"BACKEND_URL": "http://api.uat.hushh.ai", "OIDC_AUDIENCE": "http://api.uat.hushh.ai"},
            "must use HTTPS",
        ),
        (
            {"BACKEND_URL": "https://example.invalid", "OIDC_AUDIENCE": "https://example.invalid"},
            "reviewed UAT backend origin",
        ),
        (
            {"OIDC_AUDIENCE": "https://consent-protocol-f2gsa4kfsq-uc.a.run.app"},
            "must exactly match BACKEND_URL",
        ),
        ({"JOB_NAME": "attacker-job"}, "only configures the reviewed UAT scheduled-mail job"),
        ({"CRON": "*/5 * * * *"}, "only configures the reviewed UAT scheduled-mail job"),
        (
            {"SCHEDULER_SERVICE_ACCOUNT_NAME": "drive-work-drain-sched"},
            "only configures the reviewed UAT scheduled-mail job",
        ),
        ({"BATCH_LIMIT": "101"}, "BATCH_LIMIT must be an integer from 1 through 100"),
        ({"DRY_RUN": "yes"}, "DRY_RUN must be 0 or 1"),
    ],
)
def test_script_refuses_unreviewed_targets_before_any_gcloud_call(
    tmp_path: Path, overrides: dict[str, str], message: str
):
    result = _run_scheduler_with(tmp_path, **overrides)

    assert result.returncode != 0
    assert message in result.stderr
    assert result.gcloud_calls == ""  # type: ignore[attr-defined]


def _steps(workflow: Path) -> list[dict]:
    jobs = yaml.safe_load(workflow.read_text(encoding="utf-8"))["jobs"]
    return [step for job in jobs.values() for step in job.get("steps", [])]


def test_uat_activates_the_job_only_after_release_classification():
    steps = _steps(UAT_WORKFLOW)
    ids = [step.get("id") for step in steps]
    step = next(step for step in steps if step.get("id") == "activate-scheduled-mail-drain")

    assert ids.index("classify-uat-release") < ids.index("activate-scheduled-mail-drain")
    assert ids.index("activate-account-deletion") < ids.index("activate-scheduled-mail-drain")
    assert step["if"] == (
        "steps.classify-uat-release.outputs.release_failed == 'false' "
        "&& steps.scope.outputs.deploy_backend == 'true'"
    )
    assert step["env"]["SCHEDULER_SERVICE_ACCOUNT_NAME"] == "mail-scheduled-send"
    assert step["env"]["JOB_NAME"] == "mail-scheduled-send-uat"
    assert step["env"]["BATCH_LIMIT"] == "50"
    assert step["env"]["OIDC_AUDIENCE"] == "${{ env.CONSENT_API_PUBLIC_ORIGIN }}"
    assert "bash deploy/gmail/setup_scheduled_mail_scheduler.sh" in step["run"]
    assert f"'{URI}'" in step["run"]
    assert "Scheduled mail drain scheduler configuration drifted" in step["run"]


def test_production_has_no_scheduled_mail_job():
    production = PRODUCTION_WORKFLOW.read_text(encoding="utf-8")

    assert "setup_scheduled_mail_scheduler" not in production
    assert "mail-scheduled-send" not in production
    assert '--mail-scheduled-drain-enabled "false"' in production
