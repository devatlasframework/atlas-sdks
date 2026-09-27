"""Shared fixtures: loopback servers that are always closed, and the fixtures every SDK reads."""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from .loopback import Loopback, Script, Start

REPO = Path(__file__).resolve().parents[3]
"""The atlas-sdks checkout: the contract and the scenarios live beside the SDKs."""


@pytest.fixture
def loopback() -> Iterator[Start]:
    """Starts loopback servers for one test, and closes every one of them after it."""
    started: list[Loopback] = []

    def start(*replies: Script) -> Loopback:
        server = Loopback(*replies)
        started.append(server)
        return server

    yield start
    for server in started:
        server.close()


@pytest.fixture(scope="session")
def scored_profile() -> dict[str, Any]:
    """A learner profile built by the ATLAS scorer, carrying both sub-dimension shapes."""
    text = (REPO / "scenarios" / "fixtures" / "profile-scored.json").read_text(encoding="utf-8")
    profile: dict[str, Any] = json.loads(text)["profile"]
    return profile
