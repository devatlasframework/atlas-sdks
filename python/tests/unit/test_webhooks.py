"""Verifying webhooks against deliveries no SDK signed.

Two sources of signed deliveries, and neither is this SDK: it ships no signer, so no test here can
pass by agreeing with itself.

1. A delivery captured from ATLAS's real sender on a development environment. Its endpoint was
   deleted after the capture, so its secret signs nothing any more; it is here because it is the
   real thing.
2. A vector signed by OpenSSL, for the cases a single capture cannot show: a rotation carrying two
   signatures, and a header built to defeat a verifier that checks the wrong timestamp.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

import pytest

from devatlasframework.sdk import (
    SIGNATURE_HEADER,
    AtlasConfigurationError,
    WebhookVerificationError,
    verify_webhook,
)

from .conftest import REPO

CAPTURED: dict[str, Any] = json.loads(
    (REPO / "scenarios" / "fixtures" / "webhook-delivery-dev.json").read_text(encoding="utf-8")
)
VECTOR: dict[str, Any] = json.loads(
    (REPO / "scenarios" / "fixtures" / "webhook-openssl-vectors.json").read_text(encoding="utf-8")
)
T: int = VECTOR["timestamp"]
BODY: str = VECTOR["body"]
CURRENT: str = VECTOR["secrets"]["current"]
PREVIOUS: str = VECTOR["secrets"]["previous"]


def at(seconds: float) -> datetime:
    return datetime.fromtimestamp(seconds, UTC)


def refusal(run: Callable[[], object]) -> str:
    with pytest.raises(WebhookVerificationError) as refused:
        run()
    return refused.value.reason


class TestADeliveryCapturedFromAtlasRealSender:
    HEADER: str = CAPTURED["headers"][SIGNATURE_HEADER]
    SIGNED_AT = int(re.search(r"(?:^|,)t=(\d+)", HEADER).group(1))  # type: ignore[union-attr]

    def test_verifies_and_returns_the_event_it_carries(self) -> None:
        event = verify_webhook(
            CAPTURED["body"], self.HEADER, CAPTURED["secret"], now=at(self.SIGNED_AT)
        )
        assert event["type"] == "resource.ready"
        assert re.fullmatch(r"[0-9a-f-]{36}", event["delivery_id"])
        assert re.fullmatch(r"[0-9a-f-]{36}", event["data"]["resource_id"])

    def test_verifies_from_bytes_as_well_as_from_a_string(self) -> None:
        raw = CAPTURED["body"].encode("utf-8")
        for body in (raw, bytearray(raw), memoryview(raw)):
            verify_webhook(body, self.HEADER, CAPTURED["secret"], now=at(self.SIGNED_AT))

    def test_is_refused_with_one_byte_of_the_body_changed(self) -> None:
        tampered = bytearray(CAPTURED["body"].encode("utf-8"))
        tampered[-2] ^= 0x01
        reason = refusal(
            lambda: verify_webhook(
                bytes(tampered), self.HEADER, CAPTURED["secret"], now=at(self.SIGNED_AT)
            )
        )
        assert reason == "no-match"

    def test_is_refused_once_it_is_older_than_the_window(self) -> None:
        reason = refusal(
            lambda: verify_webhook(
                CAPTURED["body"], self.HEADER, CAPTURED["secret"], now=at(self.SIGNED_AT + 301)
            )
        )
        assert reason == "stale"

    def test_is_refused_under_a_secret_it_was_not_signed_with(self) -> None:
        reason = refusal(
            lambda: verify_webhook(
                CAPTURED["body"], self.HEADER, "whsec_not-the-secret", now=at(self.SIGNED_AT)
            )
        )
        assert reason == "no-match"


class TestADeliverySignedByOpenssl:
    def test_verifies_against_a_single_signature(self) -> None:
        event = verify_webhook(BODY, VECTOR["headers"]["current"], CURRENT, now=at(T))
        assert event["type"] == "resource.ready"

    def test_verifies_during_a_rotation_under_either_secret_in_either_order(self) -> None:
        signatures = VECTOR["signatures"]
        swapped = f"t={T},v1={signatures['previous']},v1={signatures['current']}"
        for header in (VECTOR["headers"]["rotation"], swapped):
            for secret in (CURRENT, PREVIOUS):
                verify_webhook(BODY, header, secret, now=at(T))
        verify_webhook(BODY, VECTOR["headers"]["current"], [PREVIOUS, CURRENT], now=at(T))

    def test_is_refused_when_one_character_of_the_signature_is_changed(self) -> None:
        signature: str = VECTOR["signatures"]["current"]
        flipped = signature[:-1] + ("1" if signature.endswith("0") else "0")
        reason = refusal(lambda: verify_webhook(BODY, f"t={T},v1={flipped}", CURRENT, now=at(T)))
        assert reason == "no-match"

    def test_checks_freshness_on_the_timestamp_that_produced_the_match(self) -> None:
        # An old delivery with a fresh `t=` appended: its signature matches the OLD timestamp only.
        # A verifier that checks the window against the last `t` it parsed would accept it.
        later = T + 86_400
        header = f"{VECTOR['headers']['current']},t={later}"
        assert refusal(lambda: verify_webhook(BODY, header, CURRENT, now=at(later))) == "stale"

    def test_accepts_clock_skew_inside_the_window_in_both_directions(self) -> None:
        for skew in (-300, 300):
            verify_webhook(BODY, VECTOR["headers"]["current"], CURRENT, now=at(T + skew))


class TestWhatTheVerifierRefusesBeforeItComputesAnything:
    def test_a_parsed_object_because_re_serialising_changes_the_bytes(self) -> None:
        parsed: Any = json.loads(BODY)
        reason = refusal(lambda: verify_webhook(parsed, VECTOR["headers"]["current"], CURRENT))
        assert reason == "not-raw"

    def test_a_missing_header_one_with_nothing_usable_and_one_too_long(self) -> None:
        assert refusal(lambda: verify_webhook(BODY, None, CURRENT)) == "missing-header"
        assert refusal(lambda: verify_webhook(BODY, "  ", CURRENT)) == "missing-header"
        assert refusal(lambda: verify_webhook(BODY, "v0=abc", CURRENT)) == "malformed-header"
        upper = f"t=1,v1={'A' * 64}"
        assert refusal(lambda: verify_webhook(BODY, upper, CURRENT)) == "malformed-header"
        long = "t=1," + "v1=x," * 300
        assert refusal(lambda: verify_webhook(BODY, long, CURRENT)) == "malformed-header"

    def test_digits_from_another_script_in_the_header(self) -> None:
        # U+0663, ARABIC-INDIC DIGIT THREE: `\\d` matches it, and it cannot be encoded as ASCII.
        header = f"t={chr(0x663) * 3},v1={VECTOR['signatures']['current']}"
        assert refusal(lambda: verify_webhook(BODY, header, CURRENT, now=at(T))) == (
            "malformed-header"
        )

    def test_no_secret_at_all(self) -> None:
        header = VECTOR["headers"]["current"]
        assert refusal(lambda: verify_webhook(BODY, header, [])) == "no-secret"
        assert refusal(lambda: verify_webhook(BODY, header, "")) == "no-secret"

    def test_a_clock_with_no_time_zone(self) -> None:
        with pytest.raises(AtlasConfigurationError, match="time zone"):
            verify_webhook(
                BODY, VECTOR["headers"]["current"], CURRENT, now=datetime(2025, 9, 22, 0, 0)
            )


class TestWhatTheVerifierRefusesToSpendCpuOn:
    def test_more_timestamps_than_atlas_ever_sends(self) -> None:
        header = f"t=1,t=2,t={T},v1={VECTOR['signatures']['current']}"
        assert refusal(lambda: verify_webhook(BODY, header, CURRENT, now=at(T))) == (
            "malformed-header"
        )

    def test_more_signatures_than_atlas_ever_sends(self) -> None:
        header = f"t={T}," + f"v1={'0' * 64}," * 4 + f"v1={VECTOR['signatures']['current']}"
        assert refusal(lambda: verify_webhook(BODY, header, CURRENT, now=at(T))) == (
            "malformed-header"
        )

    @pytest.mark.parametrize("tolerance", [math.inf, math.nan, -1])
    def test_a_tolerance_that_is_not_a_finite_non_negative_number(self, tolerance: float) -> None:
        with pytest.raises(AtlasConfigurationError):
            verify_webhook(
                BODY, VECTOR["headers"]["current"], CURRENT, tolerance_seconds=tolerance, now=at(T)
            )
