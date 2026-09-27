"""The test every generator must pass, judged on what it produces over the covered surface.

Never on a feature list (ADR-0078 section 4): the discriminator is honoured on write as well as on
read (test_wire.py sends a scorer-built profile and reads the bytes), the four maps are typed,
`Problem` carries `errorCode` and `errorId`, and the output is reproduced byte for byte from the
pinned generator. tests/typing/check_types.py proves the same properties to the type checker.
"""

from __future__ import annotations

import ast
import importlib.util
import json
from pathlib import Path
from types import ModuleType
from typing import Literal, NotRequired, get_type_hints

from devatlasframework.sdk._generated import contract

from .conftest import REPO

ROOT = Path(__file__).resolve().parents[2]
GENERATED = ROOT / "src" / "devatlasframework" / "sdk" / "_generated" / "contract.py"


def load_generate() -> ModuleType:
    spec = importlib.util.spec_from_file_location("generate", ROOT / "scripts" / "generate.py")
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestTheGeneratedTypes:
    def test_are_reproduced_byte_for_byte_from_the_pinned_generator(self) -> None:
        generate = load_generate()
        derived = json.loads((REPO / "contract" / "surface.json").read_text("utf-8"))[
            "x-atlas-derived"
        ]
        once = generate.contract_types(derived)
        twice = generate.contract_types(derived)
        assert once == twice
        assert GENERATED.read_text(encoding="utf-8").replace("\r\n", "\n") == once

    def test_type_wire_strings_as_str_and_import_nothing_but_typing(self) -> None:
        tree = ast.parse(GENERATED.read_text(encoding="utf-8"))
        imported = {node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)} | {
            alias.name
            for node in ast.walk(tree)
            if isinstance(node, ast.Import)
            for alias in node.names
        }
        # And no `from __future__ import annotations`: a TypedDict built from string annotations
        # cannot see NotRequired, and would report every key as required at run time.
        assert imported == {"typing"}

    def test_declare_the_discriminator_as_a_required_literal_on_every_variant(self) -> None:
        bipolar = get_type_hints(contract.BipolarScore, include_extras=True)
        multi = get_type_hints(contract.MultiCategoryScore, include_extras=True)
        assert bipolar["structureType"] == Literal["bipolar"]
        assert multi["structureType"] == Literal["multi-category"]
        assert "structureType" in contract.BipolarScore.__required_keys__
        assert "structureType" in contract.MultiCategoryScore.__required_keys__
        assert contract.SubDimensionScore.__value__ == (
            contract.MultiCategoryScore | contract.BipolarScore
        )

    def test_type_the_four_maps_by_their_values(self) -> None:
        profile = get_type_hints(contract.LearnerProfile)
        assert profile["categoryScores"] == dict[str, float]
        assert profile["percentScores"] == dict[str, float]
        assert profile["subDimensionScores"] == dict[str, contract.SubDimensionScore]
        assert get_type_hints(contract.MultiCategoryScore)["categories"] == dict[str, float]

    def test_give_a_refusal_its_error_code_and_error_id(self) -> None:
        problem = get_type_hints(contract.Problem, include_extras=True)
        assert problem["errorCode"] == NotRequired[str]
        assert problem["errorId"] == NotRequired[str]
        assert {"errorCode", "errorId"} <= contract.Problem.__optional_keys__
