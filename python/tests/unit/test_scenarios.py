"""Every SDK runs scenarios/live.json as written, and this is the check that runs in CI.

The live suite itself runs where the API does. What CI can hold, without a network, is that this
SDK's runner implements exactly the scenarios the file lists - no fewer, so a scenario added for
every SDK turns this one red until it exists here, and no more, so this suite cannot drift into
testing something the others do not.
"""

from __future__ import annotations

import json
from typing import Any

from devatlasframework.sdk._generated.surface import OPERATIONS
from tests.live.scenarios import RUNNERS

from .conftest import REPO

SPEC: dict[str, Any] = json.loads((REPO / "scenarios" / "live.json").read_text(encoding="utf-8"))


def test_the_live_runner_implements_exactly_the_listed_scenarios() -> None:
    listed = [scenario["id"] for scenario in SPEC["scenarios"]]
    assert len(set(listed)) == len(listed), "scenario ids are unique"
    assert sorted(RUNNERS) == sorted(listed)


def test_every_scenario_names_operations_this_sdk_covers() -> None:
    named = {op for scenario in SPEC["scenarios"] for op in scenario["operations"]}
    assert named <= set(OPERATIONS)
    assert named == set(OPERATIONS), "together, the scenarios call every covered operation"
