"""Checked by mypy, never run: each line here is a property of the generated types.

`assert_type` fails the type check if a type changes. Each `# type: ignore[code]` marks something
that must stay an error: mypy's strict mode reports an ignore that is no longer needed, so the day
the forbidden thing becomes allowed, the type check fails.
"""

from typing import assert_type

from devatlasframework.sdk import (
    BipolarScore,
    DelegatedPassResponse,
    KeyClient,
    LearnerProfile,
    MultiCategoryScore,
    PassClient,
    Problem,
    SubDimensionScore,
    TokenExchangeRequest,
)


def the_union_narrows_on_structure_type(score: SubDimensionScore) -> None:
    if score["structureType"] == "bipolar":
        assert_type(score, BipolarScore)
        assert_type(score["score"], float)
    else:
        assert_type(score, MultiCategoryScore)
        assert_type(score["categories"], dict[str, float])


def the_union_cannot_be_built_without_its_discriminator() -> None:
    missing: SubDimensionScore = {  # type: ignore[assignment]
        "score": 4.0,
        "scorePercent": 75.0,
        "poleALabel": "Quiet",
        "poleBLabel": "Noise",
    }
    crossed: BipolarScore = {
        "structureType": "bipolar",
        "score": 4.0,
        "scorePercent": 75.0,
        "poleALabel": "Quiet",
        "poleBLabel": "Noise",
        "categories": {},  # type: ignore[typeddict-unknown-key]
    }
    wrong: BipolarScore = {
        "structureType": "multi-category",  # type: ignore[typeddict-item]
        "score": 4.0,
        "scorePercent": 75.0,
        "poleALabel": "Quiet",
        "poleBLabel": "Noise",
    }
    del missing, crossed, wrong


def the_four_maps_are_typed_by_their_values(profile: LearnerProfile) -> None:
    assert_type(profile["categoryScores"], dict[str, float])
    assert_type(profile["percentScores"], dict[str, float])
    assert_type(profile["subDimensionScores"], dict[str, SubDimensionScore])


def a_refusal_carries_error_code_and_error_id(problem: Problem) -> None:
    assert_type(problem.get("errorCode"), str | None)
    assert_type(problem.get("errorId"), str | None)


def the_token_leg_keeps_each_side_of_the_wire_in_its_own_convention(
    answer: DelegatedPassResponse,
) -> None:
    assert_type(answer["access_token"], str)
    assert_type(answer["expires_in"], int)
    request: TokenExchangeRequest = {"grantType": "refresh_token", "clientId": "c"}
    renamed: TokenExchangeRequest = {"grant_type": "refresh_token", "clientId": "c"}  # type: ignore[typeddict-unknown-key,typeddict-item]
    del request, renamed


def a_pass_can_call_the_three_content_reads_and_nothing_else(as_learner: PassClient) -> None:
    as_learner.list_resources()
    as_learner.get_resource("r")
    as_learner.get_resource_download("r")
    as_learner.link_end_user  # type: ignore[attr-defined]  # noqa: B018
    as_learner.present_for_end_user  # type: ignore[attr-defined]  # noqa: B018
    as_learner.describe_key  # type: ignore[attr-defined]  # noqa: B018


def a_key_names_its_body_in_the_wire_convention(atlas: KeyClient) -> None:
    atlas.link_end_user({"ref": "learner-4821"})
    atlas.link_end_user({"reference": "x"})  # type: ignore[typeddict-unknown-key,typeddict-item]
