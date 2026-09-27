"""Acting as a person: PKCE, the consent address, the token leg, and renewal."""

from __future__ import annotations

import base64
import json
import re
import threading
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import parse_qsl, urlsplit

import pytest

from devatlasframework.sdk import (
    AtlasApiError,
    AtlasConfigurationError,
    AtlasConnectionError,
    AtlasError,
    DelegatedPass,
    DelegatedPassResponse,
    DelegatedPassSnapshot,
    PassClient,
    RefreshRefusedError,
    authorization_url,
    create_pkce_pair,
    exchange_code,
    pkce_challenge,
)
from devatlasframework.sdk._transport import _Internals

from .loopback import DROP, ORG, Reply, Start, problem

CLIENT_ID = "app_client_1234"
T0 = datetime(2026, 9, 26, 10, 0, tzinfo=UTC)

# RFC 7636 appendix B, as octets: the 32 random bytes of the verifier, and the SHA-256 of the
# verifier's ASCII. The strings are derived from these, not remembered.
RFC7636_VERIFIER_OCTETS = bytes(
    [116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186,
     22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121]
)  # fmt: skip
RFC7636_CHALLENGE_OCTETS = bytes(
    [19, 211, 30, 150, 26, 26, 216, 236, 47, 22, 177, 12, 76, 152, 46, 8,
     118, 168, 120, 173, 109, 241, 68, 86, 110, 225, 137, 74, 203, 112, 249, 195]
)  # fmt: skip


def b64url(octets: bytes) -> str:
    return base64.urlsafe_b64encode(octets).rstrip(b"=").decode("ascii")


def issued(n: int, expires_in: int = 600) -> DelegatedPassResponse:
    return {
        "access_token": f"pass-{n}",
        "token_type": "Bearer",
        "expires_in": expires_in,
        "refresh_token": f"refresh-{n}",
        "scope": "content:read",
    }


class Clock:
    def __init__(self, at: datetime = T0) -> None:
        self.at = at

    def __call__(self) -> datetime:
        return self.at

    def advance(self, seconds: float) -> None:
        self.at = T0 + timedelta(seconds=seconds)


def held(
    base_url: str,
    response: DelegatedPassResponse | None = None,
    clock: Callable[[], datetime] = lambda: T0,
    **extra: Any,
) -> DelegatedPass:
    return DelegatedPass.from_response(
        response or issued(1),
        base_url=base_url,
        client_id=CLIENT_ID,
        _internals=_Internals(sleep=lambda _: None, now=clock),
        **extra,
    )


class TestPkce:
    def test_derives_the_rfc_7636_appendix_b_challenge_from_its_verifier(self) -> None:
        verifier = b64url(RFC7636_VERIFIER_OCTETS)
        assert verifier == "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        assert pkce_challenge(verifier) == b64url(RFC7636_CHALLENGE_OCTETS)

    def test_makes_a_43_character_verifier_and_its_s256_challenge(self) -> None:
        pair = create_pkce_pair()
        assert re.fullmatch(r"[A-Za-z0-9_-]{43}", pair.verifier)
        assert pair.challenge == pkce_challenge(pair.verifier)
        assert pair.method == "S256"
        assert create_pkce_pair().verifier != pair.verifier

    def test_refuses_a_verifier_outside_rfc_7636_section_4_1(self) -> None:
        with pytest.raises(AtlasConfigurationError):
            pkce_challenge("too-short")
        with pytest.raises(AtlasConfigurationError):
            pkce_challenge("a" * 43 + " ")


class TestTheConsentUrl:
    def test_carries_every_parameter_the_contract_documents_and_s256(self) -> None:
        url = urlsplit(
            authorization_url(
                web_base_url="https://learn.example.test/",
                client_id=CLIENT_ID,
                org_id=ORG,
                redirect_uri="http://127.0.0.1:53682/callback",
                scopes=["content:read"],
                state="st-1",
                code_challenge="E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            )
        )
        assert (
            f"{url.scheme}://{url.netloc}{url.path}" == "https://learn.example.test/oauth/authorize"
        )
        assert dict(parse_qsl(url.query)) == {
            "client_id": CLIENT_ID,
            "org_id": ORG,
            "redirect_uri": "http://127.0.0.1:53682/callback",
            "scope": "content:read",
            "state": "st-1",
            "code_challenge": "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            "code_challenge_method": "S256",
        }

    def test_separates_scopes_with_an_encoded_space(self) -> None:
        url = authorization_url(
            web_base_url="https://learn.example.test",
            client_id=CLIENT_ID,
            org_id=ORG,
            redirect_uri="https://app.example.test/cb",
            scopes=["content:read", "usage:read"],
            state="s",
            code_challenge="c",
        )
        assert "scope=content%3Aread%20usage%3Aread" in url

    def test_refuses_plain_http_off_loopback_a_missing_parameter_and_one_string(self) -> None:
        base: dict[str, Any] = {
            "client_id": CLIENT_ID,
            "org_id": ORG,
            "redirect_uri": "https://a.test/cb",
            "scopes": ["content:read"],
            "state": "s",
            "code_challenge": "c",
        }
        with pytest.raises(AtlasConfigurationError, match="https"):
            authorization_url(web_base_url="http://learn.example.test", **base)
        with pytest.raises(AtlasConfigurationError, match="state"):
            authorization_url(web_base_url="https://learn.example.test", **{**base, "state": ""})
        with pytest.raises(AtlasConfigurationError, match="list"):
            authorization_url(
                web_base_url="https://learn.example.test", **{**base, "scopes": "content:read"}
            )


class TestTheTokenLeg:
    def test_is_never_retried_after_a_5xx_because_a_code_works_once(self, loopback: Start) -> None:
        server = loopback(
            Reply(503, body=problem(503, "ATLAS-SYS-001")), Reply(200, body=issued(1))
        )
        with pytest.raises(AtlasApiError):
            exchange_code(
                base_url=server.base_url,
                client_id=CLIENT_ID,
                code="c",
                redirect_uri="https://a.test/cb",
                code_verifier="v" * 43,
                _internals=_Internals(sleep=lambda _: None),
            )
        assert len(server.received) == 1

    def test_requires_each_part_of_the_exchange(self) -> None:
        with pytest.raises(AtlasConfigurationError, match="code_verifier"):
            exchange_code(
                base_url="https://api.example.test",
                client_id=CLIENT_ID,
                code="c",
                redirect_uri="https://a.test/cb",
                code_verifier="",
            )


class TestRenewingAPass:
    def test_sends_the_refresh_token_camel_case_and_rotates_both_tokens(
        self, loopback: Start
    ) -> None:
        server = loopback(Reply(200, body=issued(2)))
        delegated = held(server.base_url)
        delegated.refresh()
        assert json.loads(server.received[0].body) == {
            "grantType": "refresh_token",
            "refreshToken": "refresh-1",
            "clientId": CLIENT_ID,
        }
        assert "authorization" not in server.received[0].headers
        assert delegated.access_token == "pass-2"
        assert delegated.snapshot()["refresh_token"] == "refresh-2"

    def test_keeps_the_live_pass_when_refused_and_never_presents_that_token_again(
        self, loopback: Start
    ) -> None:
        server = loopback(Reply(400, body=problem(400, "ATLAS-DEV-014")))
        delegated = held(server.base_url)
        with pytest.raises(RefreshRefusedError) as refused:
            delegated.refresh()
        assert isinstance(refused.value.refusal, AtlasApiError)
        assert refused.value.refusal.error_code == "ATLAS-DEV-014"
        assert refused.value.still_valid_until == T0 + timedelta(seconds=600)
        assert delegated.access_token == "pass-1"
        assert delegated.renewable is False

        with pytest.raises(AtlasError, match="cannot be renewed"):
            delegated.refresh()
        assert len(server.received) == 1

    def test_is_never_retried_after_a_lost_connection_and_keeps_the_token(
        self, loopback: Start
    ) -> None:
        server = loopback(DROP, Reply(200, body=issued(2)))
        delegated = held(server.base_url)
        with pytest.raises(RefreshRefusedError) as refused:
            delegated.refresh()
        assert isinstance(refused.value.refusal, AtlasConnectionError)
        assert len(server.received) == 1
        assert delegated.renewable is True
        assert delegated.access_token == "pass-1"

    def test_runs_one_renewal_when_two_threads_ask_at_once(self, loopback: Start) -> None:
        server = loopback(Reply(200, body=issued(2)))
        delegated = held(server.base_url)
        start = threading.Barrier(4)
        errors: list[BaseException] = []

        def renew() -> None:
            start.wait()
            try:
                delegated.refresh()
            except BaseException as error:
                errors.append(error)

        threads = [threading.Thread(target=renew) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(10)
        assert errors == []
        assert len(server.received) == 1
        assert delegated.access_token == "pass-2"

    def test_renews_near_expiry_and_uses_the_live_pass_if_that_is_refused(
        self, loopback: Start
    ) -> None:
        server = loopback(Reply(400, body=problem(400, "ATLAS-DEV-014")))
        clock = Clock()
        delegated = held(server.base_url, issued(1, 60), clock)
        clock.advance(45)  # 15 s before expiry: inside the renewal margin
        assert delegated.current_access_token() == "pass-1"
        assert len(server.received) == 1

        clock.advance(61)  # expired, and nothing left to renew with
        assert delegated.is_expired() is True

    def test_round_trips_through_a_snapshot(self, loopback: Start) -> None:
        server = loopback(Reply(200, body=issued(2)))
        snapshot = held(server.base_url).snapshot()
        assert json.loads(json.dumps(snapshot)) == snapshot
        restored = DelegatedPass.restore(snapshot, base_url=server.base_url, client_id=CLIENT_ID)
        assert restored.access_token == "pass-1"
        assert restored.expires_at.isoformat() == snapshot["expires_at"]

    def test_refuses_a_snapshot_without_a_time_zone(self) -> None:
        naive: DelegatedPassSnapshot = {
            "access_token": "a",
            "refresh_token": None,
            "expires_at": "2026-09-26T10:00:00",
            "scope": "content:read",
        }
        with pytest.raises(AtlasConfigurationError, match="time zone"):
            DelegatedPass.restore(naive, base_url="https://api.example.test", client_id=CLIENT_ID)


class TestPassClient:
    def test_sends_the_pass_it_holds_and_reads_as_the_person(self, loopback: Start) -> None:
        server = loopback(
            Reply(200, body={"items": [], "page": 0, "size": 24, "totalItems": 0, "totalPages": 0})
        )
        delegated = held(server.base_url, issued(9))
        as_learner = PassClient(base_url=server.base_url, org_id=ORG, delegated_pass=delegated)
        as_learner.list_resources()
        assert server.received[0].headers["authorization"] == "Bearer pass-9"
        assert server.received[0].target == f"/v1/o/{ORG}/resources"

    def test_requires_the_organisation_the_person_consented_for(self) -> None:
        with pytest.raises(AtlasConfigurationError, match="org_id"):
            PassClient(base_url="https://api.example.test", org_id="", delegated_pass="p")
        with pytest.raises(AtlasConfigurationError, match="delegated_pass"):
            PassClient(
                base_url="https://api.example.test",
                org_id=ORG,
                delegated_pass=object(),  # type: ignore[arg-type]
            )


class TestARenewalThatFailsForAReasonOtherThanRefusal:
    def test_keeps_the_refresh_token_after_a_429_which_spent_nothing(self, loopback: Start) -> None:
        server = loopback(
            Reply(429, body=problem(429, "ATLAS-SYS-004")), Reply(200, body=issued(2))
        )
        clock = Clock()
        delegated = held(server.base_url, issued(1, 60), clock)
        with pytest.raises(RefreshRefusedError):
            delegated.refresh()
        assert delegated.renewable is True
        assert delegated.renewal_outcome_unknown is False

        clock.advance(45)  # inside the margin: renewal is tried again, and lands
        assert delegated.current_access_token() == "pass-2"

    def test_never_presents_the_token_again_on_its_own_after_a_5xx(self, loopback: Start) -> None:
        server = loopback(
            Reply(503, body=problem(503, "ATLAS-SYS-001")), Reply(200, body=issued(2))
        )
        clock = Clock()
        delegated = held(server.base_url, issued(1, 60), clock)
        with pytest.raises(RefreshRefusedError):
            delegated.refresh()
        assert delegated.renewable is True
        assert delegated.renewal_outcome_unknown is True

        clock.advance(45)
        assert delegated.current_access_token() == "pass-1"
        assert delegated.current_access_token() == "pass-1"
        assert len(server.received) == 1

        delegated.refresh()  # your decision to try the token again
        assert len(server.received) == 2
        assert delegated.access_token == "pass-2"
        assert delegated.renewal_outcome_unknown is False

    def test_never_presents_the_token_again_on_its_own_after_a_dropped_connection(
        self, loopback: Start
    ) -> None:
        server = loopback(DROP, Reply(200, body=issued(2)))
        clock = Clock()
        delegated = held(server.base_url, issued(1, 60), clock)
        with pytest.raises(RefreshRefusedError):
            delegated.refresh()
        assert delegated.renewal_outcome_unknown is True
        clock.advance(45)
        delegated.current_access_token()
        delegated.current_access_token()
        assert len(server.received) == 1

    def test_hands_the_renewed_pass_to_on_renewed_before_the_new_token_is_used(
        self, loopback: Start
    ) -> None:
        server = loopback(Reply(200, body=issued(2)))
        order: list[str] = []

        def stored(snapshot: DelegatedPassSnapshot) -> None:
            order.append(f"stored {snapshot['access_token']} {snapshot['refresh_token']}")

        delegated = held(server.base_url, on_renewed=stored)
        delegated.refresh()
        order.append(f"using {delegated.access_token}")
        assert order == ["stored pass-2 refresh-2", "using pass-2"]


class TestWhatTheSecurityReviewFound:
    @pytest.mark.parametrize(
        "answer",
        [Reply(200, {"content-type": "application/json"}, raw=b"<html>"), Reply(200, body={})],
        ids=["not-json", "missing-fields"],
    )
    def test_an_answer_that_cannot_be_read_leaves_the_outcome_unknown(
        self, loopback: Start, answer: Reply
    ) -> None:
        server = loopback(answer, Reply(200, body=issued(2)))
        clock = Clock()
        delegated = held(server.base_url, issued(1, 60), clock)
        with pytest.raises(RefreshRefusedError) as refused:
            delegated.refresh()
        assert isinstance(refused.value.refusal, AtlasConnectionError)
        assert "refresh-1" not in str(refused.value.refusal)
        assert delegated.renewal_outcome_unknown is True
        # ATLAS answered 2xx, so it may have rotated the token: never presented again on its own.
        clock.advance(45)
        assert delegated.current_access_token() == "pass-1"
        assert len(server.received) == 1

    def test_an_automatic_renewal_decided_on_a_stale_state_does_not_run(
        self, loopback: Start
    ) -> None:
        # Thread B decided to renew; before it took the lock, thread A's renewal failed in a way
        # that may have spent the token. B must not present it.
        server = loopback(
            Reply(503, body=problem(503, "ATLAS-SYS-001")), Reply(200, body=issued(2))
        )
        clock = Clock()
        delegated = held(server.base_url, issued(1, 60), clock)
        decided_on = delegated._held
        with pytest.raises(RefreshRefusedError):
            delegated.refresh()  # thread A
        delegated._refresh(seen=decided_on)  # thread B, late
        assert len(server.received) == 1

    def test_a_pkce_pair_never_prints_its_verifier(self) -> None:
        pair = create_pkce_pair()
        assert pair.verifier not in repr(pair)
        assert pair.challenge in repr(pair)

    def test_on_renewed_runs_before_any_thread_can_use_the_new_token(self, loopback: Start) -> None:
        server = loopback(Reply(200, body=issued(2)))
        seen_while_storing: list[str] = []
        delegated: DelegatedPass

        def stored(snapshot: DelegatedPassSnapshot) -> None:
            seen_while_storing.append(f"{snapshot['access_token']} {delegated.access_token}")

        delegated = held(server.base_url, on_renewed=stored)
        delegated.refresh()
        assert seen_while_storing == ["pass-2 pass-1"]
        assert delegated.access_token == "pass-2"

    def test_a_failing_on_renewed_reaches_you_and_the_pass_keeps_the_renewed_tokens(
        self, loopback: Start
    ) -> None:
        server = loopback(Reply(200, body=issued(2)))

        def broken(_: DelegatedPassSnapshot) -> None:
            raise OSError("the store is down")

        delegated = held(server.base_url, on_renewed=broken)
        with pytest.raises(OSError, match="store is down"):
            delegated.refresh()
        assert delegated.access_token == "pass-2"
        assert delegated.snapshot()["refresh_token"] == "refresh-2"
