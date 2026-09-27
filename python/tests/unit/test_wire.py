"""The wire mixes two naming conventions, and map keys that are data. Measured on the bytes sent.

Request bodies and most responses are camelCase. The token exchange's answer and every webhook body
are snake_case. Some map keys are data - sub-dimension codes such as `D2a`, category names such as
`Read/Write` - and must arrive exactly as they were given. So every assertion here reads what
crossed a real socket, never a model built and read back without being serialised.
"""

from __future__ import annotations

import json
import re
from typing import Any

from devatlasframework.sdk import KeyClient, LearnerProfile, exchange_code, verify_webhook
from devatlasframework.sdk._transport import _Internals

from .conftest import REPO
from .loopback import END_USER, KEY, ORG, Reply, Start

CAMEL_KEYS_IN_A_PROFILE = (
    "taxonomyVersion",
    "completedDimensions",
    "categoryScores",
    "percentScores",
    "subDimensionScores",
    "attentionChecks",
    "structureType",
    "dominantCategory",
    "scorePercent",
    "poleALabel",
    "poleBLabel",
)


def snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def keys_everywhere(value: object) -> set[str]:
    """Every object key at every depth, map keys included."""
    found: set[str] = set()
    if isinstance(value, dict):
        for key, inner in value.items():
            found.add(key)
            found |= keys_everywhere(inner)
    elif isinstance(value, list):
        for inner in value:
            found |= keys_everywhere(inner)
    return found


class TestTheDiscriminatorOnWrite:
    def test_reaches_the_wire_for_every_entry_of_both_shapes_with_every_map_key_untouched(
        self, loopback: Start, scored_profile: dict[str, Any]
    ) -> None:
        server = loopback(Reply(200, body={"endorsements": []}))
        atlas = KeyClient(base_url=server.base_url, api_key=KEY, org_id=ORG)
        profile: LearnerProfile = scored_profile  # type: ignore[assignment]
        atlas.present_for_end_user(END_USER, {"profile": profile})

        sent = server.received[0].body
        # Byte for byte: compact JSON of exactly what was given, in the order it was given.
        assert sent == json.dumps(
            {"profile": scored_profile}, ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")

        on_the_wire = json.loads(sent)["profile"]
        assert keys_everywhere(on_the_wire) == keys_everywhere(scored_profile)
        shapes = [score["structureType"] for score in on_the_wire["subDimensionScores"].values()]
        assert "bipolar" in shapes
        assert "multi-category" in shapes
        assert set(shapes) == {"bipolar", "multi-category"}
        assert list(on_the_wire["subDimensionScores"]) == list(scored_profile["subDimensionScores"])

        # Map keys are data - sub-dimension codes and category names - and stay as they are.
        assert {"D1", "D2a"} <= set(on_the_wire["subDimensionScores"])
        assert "D3a.Small Group" in on_the_wire["categoryScores"]
        d1 = on_the_wire["subDimensionScores"]["D1"]
        assert d1["structureType"] == "multi-category"
        assert "Read/Write" in d1["categories"]

        # And the property names are the contract's, camelCase, with no snake_case twin.
        text = sent.decode("utf-8")
        for name in CAMEL_KEYS_IN_A_PROFILE:
            assert f'"{name}":' in text, name
            assert f'"{snake(name)}":' not in text, snake(name)


class TestTheDiscriminatorOnRead:
    def test_returns_what_the_api_sent_including_fields_this_sdk_does_not_know(
        self, loopback: Start, scored_profile: dict[str, Any]
    ) -> None:
        answer = {
            "endorsements": [{"key": "D2a.Quiet", "dimension": "OD2"}],
            "addedInALaterMinor": {"kept": True},
        }
        server = loopback(Reply(200, body=answer))
        atlas = KeyClient(base_url=server.base_url, api_key=KEY, org_id=ORG)
        profile: LearnerProfile = scored_profile  # type: ignore[assignment]
        assert atlas.present_for_end_user(END_USER, {"profile": profile}) == answer


class TestLinkEndUser:
    def test_sends_the_body_it_was_given_and_nothing_else(self, loopback: Start) -> None:
        server = loopback(Reply(201, body={"id": END_USER}))
        atlas = KeyClient(base_url=server.base_url, api_key=KEY, org_id=ORG)
        atlas.link_end_user({"ref": "learner-4821"})
        assert server.received[0].body == b'{"ref":"learner-4821"}'
        assert server.received[0].headers["content-type"] == "application/json"


class TestTheTokenLeg:
    def test_sends_camel_case_reads_snake_case_and_renames_nothing(self, loopback: Start) -> None:
        issued = {
            "access_token": "pass-1",
            "token_type": "Bearer",
            "expires_in": 600,
            "refresh_token": "refresh-1",
            "scope": "content:read",
        }
        server = loopback(Reply(200, body=issued))
        delegated = exchange_code(
            base_url=server.base_url,
            client_id="app_client_1234",
            code="code-1",
            redirect_uri="http://127.0.0.1:53682/callback",
            code_verifier="v" * 43,
            _internals=_Internals(),
        )

        [request] = server.received
        assert (request.method, request.target) == ("POST", "/v1/oauth/token")
        assert "authorization" not in request.headers
        assert request.body == (
            b'{"grantType":"authorization_code","code":"code-1",'
            b'"redirectUri":"http://127.0.0.1:53682/callback",'
            b'"codeVerifier":"' + b"v" * 43 + b'","clientId":"app_client_1234"}'
        )
        for renamed in (b"grant_type", b"redirect_uri", b"code_verifier", b"client_id"):
            assert renamed not in request.body
        # The answer is RFC 6749's snake_case, read as it came.
        assert delegated.access_token == "pass-1"
        assert delegated.scope == "content:read"
        assert delegated.snapshot()["refresh_token"] == "refresh-1"


class TestAWebhookBody:
    def test_is_read_snake_case_exactly_as_the_real_sender_wrote_it(self) -> None:
        captured = json.loads(
            (REPO / "scenarios" / "fixtures" / "webhook-delivery-dev.json").read_text("utf-8")
        )
        header = captured["headers"]["atlas-signature"]
        signed_at = int(re.search(r"t=(\d+)", header).group(1))  # type: ignore[union-attr]
        from datetime import UTC, datetime  # noqa: PLC0415

        event = verify_webhook(
            captured["body"],
            header,
            captured["secret"],
            now=datetime.fromtimestamp(signed_at, UTC),
        )
        assert event == json.loads(captured["body"])
        assert {"delivery_id", "event_id", "occurred_at", "type", "data"} <= set(event)
        assert {"resource_id", "version_id"} <= set(event["data"])
