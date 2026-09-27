"""The live suite: ../../../scenarios/live.json, executed against a deployed API.

Configuration comes from the environment, or from python/.env.live (never committed). Credentials
are only ever sent to ATLAS_BASE_URL, and none appears in the transcript this writes to
python/live-results/.

    uv run pytest tests/live -s

Set ATLAS_CA_FILE to a certificate authority's PEM file if the API's certificate is not signed by
one this machine already trusts.
"""

from __future__ import annotations

import json
import os
import ssl
from collections.abc import Iterator
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from devatlasframework.sdk import VERSIONS
from devatlasframework.sdk._generated.surface import OPERATIONS

from .scenarios import RESULTS, RUNNERS, Live

REPO = Path(__file__).resolve().parents[3]
SPEC: dict[str, Any] = json.loads((REPO / "scenarios" / "live.json").read_text(encoding="utf-8"))
PROFILE = json.loads(
    (REPO / "scenarios" / "fixtures" / "profile-scored.json").read_text(encoding="utf-8")
)["profile"]


def read_env_file(path: Path) -> dict[str, str]:
    """KEY=VALUE lines; blank lines and # comments skipped; surrounding quotes removed."""
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        text = line.strip()
        if not text or text.startswith("#") or "=" not in text:
            continue
        name, value = text.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[name.strip()] = value
    return values


@pytest.fixture(scope="module")
def live() -> Iterator[Live]:
    env = {**read_env_file(Path(__file__).resolve().parents[2] / ".env.live"), **os.environ}
    missing = [name for name in SPEC["requires"] if not env.get(name)]
    if missing:
        pytest.fail(
            f"the live suite needs {', '.join(missing)} - see scenarios/live.json. It fails rather "
            "than skips: a live run that never reached the API would prove nothing."
        )
    options: dict[str, Any] = {}
    if env.get("ATLAS_CA_FILE"):
        options["ssl_context"] = ssl.create_default_context(cafile=env["ATLAS_CA_FILE"])
    run = Live(env=env, profile=PROFILE, options=options)
    yield run

    ran_at = datetime.now(UTC)
    report = {
        "ranAt": ran_at.isoformat(),
        "versions": asdict(VERSIONS),
        "results": run.results,
        "responses": len(run.transcript),
        "transcript": run.transcript,
    }
    RESULTS.mkdir(exist_ok=True)
    name = f"run-{ran_at.strftime('%Y-%m-%dT%H-%M-%S')}.json"
    (RESULTS / name).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    summary = {
        "versions": asdict(VERSIONS),
        "responses": len(run.transcript),
        "results": run.results,
    }
    print(f"\n  live results: {json.dumps(summary, indent=2)}\n")


@pytest.mark.parametrize("scenario", SPEC["scenarios"], ids=[s["id"] for s in SPEC["scenarios"]])
def test_scenario(live: Live, scenario: dict[str, Any]) -> None:
    runner = RUNNERS.get(scenario["id"])
    assert runner is not None, f'this runner does not implement the scenario "{scenario["id"]}"'
    live.current = scenario["id"]
    live.exercised[scenario["id"]] = set()
    runner(live)
    seen = live.exercised[scenario["id"]]
    for operation in scenario["operations"]:
        assert operation in seen, f"{scenario['id']} calls {operation}"


def test_called_every_operation_this_sdk_covers(live: Live) -> None:
    called = set().union(*live.exercised.values()) if live.exercised else set()
    assert sorted(called) == sorted(OPERATIONS), "every covered operation, on the deployed API"
    assert live.transcript, "responses received"
