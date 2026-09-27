"""What every request carries, and how each operation is retried, measured on a real socket."""

from __future__ import annotations

import json
import platform
import re
import time
import urllib.request
from typing import Any, cast

import pytest

from devatlasframework.sdk import (
    CONTRACT_VERSION,
    SDK_VERSION,
    AtlasApiError,
    AtlasConfigurationError,
    AtlasConnectionError,
    AtlasError,
    KeyClient,
    PresentEndUserRequest,
    RetryEvent,
    RetryPolicy,
)

from .loopback import (
    DRIP,
    DROP,
    END_USER,
    KEY,
    ORG,
    SLOW_HEAD,
    STALL,
    Instant,
    Reply,
    Start,
    problem,
)

KEY_IDENTITY = {
    "keyId": "k",
    "appId": "a",
    "orgId": ORG,
    "keyPrefix": "atl_sk_live_",
    "last4": "0000",
    "scopes": [],
}
END_USER_BODY = {"id": END_USER, "appId": "a", "active": True, "linkedAt": "2026-09-26T00:00:00Z"}
NO_PROFILE = cast(PresentEndUserRequest, {"profile": {}})


def client(base_url: str, **extra: Any) -> tuple[KeyClient, Instant]:
    clock = Instant()
    options: dict[str, Any] = {"org_id": ORG, **extra}
    return KeyClient(base_url=base_url, api_key=KEY, _internals=clock.internals, **options), clock


def everything_on(error: BaseException) -> str:
    """The error's message, its attributes, and every error it was raised from, as text."""
    parts = [str(error), repr(error), repr(vars(error))]
    cause = error.__cause__ or error.__context__
    while cause is not None:
        parts += [str(cause), repr(cause)]
        cause = cause.__cause__ or cause.__context__
    return "\n".join(parts)


class TestTheAddress:
    def test_is_required_because_the_contract_names_no_host(self) -> None:
        with pytest.raises(AtlasConfigurationError, match="required"):
            KeyClient(base_url="", api_key=KEY)
        with pytest.raises(AtlasConfigurationError):
            KeyClient(api_key=KEY)  # type: ignore[call-arg]

    def test_refuses_plain_http_anywhere_but_a_loopback_address(self) -> None:
        with pytest.raises(AtlasConfigurationError, match="https"):
            KeyClient(base_url="http://api.example.test", api_key=KEY)
        for fine in (
            "http://127.0.0.1:8080",
            "http://localhost:8080",
            "http://[::1]:8080",
            "https://api.example.test",
        ):
            KeyClient(base_url=fine, api_key=KEY)

    def test_refuses_the_server_path_a_query_a_fragment_or_a_user_name(self) -> None:
        with pytest.raises(AtlasConfigurationError, match="/v1"):
            KeyClient(base_url="https://api.example.test/v1", api_key=KEY)
        with pytest.raises(AtlasConfigurationError, match="query"):
            KeyClient(base_url="https://api.example.test/?a=1", api_key=KEY)
        with pytest.raises(AtlasConfigurationError, match="query"):
            KeyClient(base_url="https://api.example.test/#top", api_key=KEY)
        with pytest.raises(AtlasConfigurationError, match="user name"):
            KeyClient(base_url="https://me:pw@api.example.test", api_key=KEY)
        with pytest.raises(AtlasConfigurationError, match="absolute"):
            KeyClient(base_url="api.example.test", api_key=KEY)

    def test_requires_a_key(self) -> None:
        with pytest.raises(AtlasConfigurationError, match="api_key"):
            KeyClient(base_url="https://api.example.test", api_key="")


class TestWhatEveryRequestCarries:
    def test_sends_the_key_as_a_bearer_token_and_names_the_sdk_and_contract(
        self, loopback: Start
    ) -> None:
        server = loopback(Reply(200, body=KEY_IDENTITY))
        atlas, _ = client(server.base_url, user_agent="acme-lms/2.1")
        atlas.describe_key()

        [request] = server.received
        assert request.method == "GET"
        assert request.target == "/v1/key"
        assert request.headers["authorization"] == f"Bearer {KEY}"
        assert request.headers["user-agent"] == (
            f"atlas-sdk-python/{SDK_VERSION} (contract {CONTRACT_VERSION}; "
            f"python {platform.python_version()}) acme-lms/2.1"
        )
        assert "Python-urllib" not in str(request.headers)

    def test_encodes_path_values_and_repeats_an_array_query_parameter(
        self, loopback: Start
    ) -> None:
        server = loopback(
            Reply(200, body={"items": [], "page": 0, "size": 5, "totalItems": 0, "totalPages": 0})
        )
        atlas, _ = client(server.base_url)
        atlas.list_resources(status=["READY", "FAILED"], q="a b", size=5)
        assert server.received[0].target == (
            f"/v1/o/{ORG}/resources?status=READY&status=FAILED&q=a%20b&size=5"
        )
        atlas.get_resource("x/y")
        assert server.received[1].target == f"/v1/o/{ORG}/resources/x%2Fy"

    def test_resolves_the_organisation_from_describe_key_once(self, loopback: Start) -> None:
        server = loopback(
            Reply(200, body=KEY_IDENTITY), Reply(200, body={"items": [], "nextCursor": None})
        )
        atlas = KeyClient(base_url=server.base_url, api_key=KEY)
        atlas.list_end_users()
        atlas.list_end_users()
        assert [r.target for r in server.received] == [
            "/v1/key",
            f"/v1/o/{ORG}/end-users",
            f"/v1/o/{ORG}/end-users",
        ]


class TestA429:
    def test_is_waited_out_for_as_long_as_retry_after_says_then_sent_again(
        self, loopback: Start
    ) -> None:
        server = loopback(
            Reply(429, {"retry-after": "7"}, problem(429, "ATLAS-SYS-004")),
            Reply(200, body=KEY_IDENTITY),
        )
        events: list[RetryEvent] = []
        atlas, clock = client(server.base_url, on_retry=events.append)
        assert atlas.describe_key()["orgId"] == ORG
        assert clock.sleeps == [7.0]
        assert [(e.reason, e.retry_after, e.status) for e in events] == [("throttled", 7, 429)]
        assert len(server.received) == 2

    def test_is_retried_even_on_an_operation_never_retried_after_a_failure(
        self, loopback: Start
    ) -> None:
        server = loopback(
            Reply(429, {"retry-after": "1"}, problem(429, "ATLAS-SYS-004")),
            Reply(200, body={"endorsements": []}),
        )
        atlas, _ = client(server.base_url)
        atlas.present_for_end_user(END_USER, NO_PROFILE)
        assert len(server.received) == 2

    def test_is_raised_at_once_when_it_names_no_wait(self, loopback: Start) -> None:
        server = loopback(Reply(429, body=problem(429, "ATLAS-BIL-001")))
        atlas, clock = client(server.base_url)
        with pytest.raises(AtlasApiError) as refused:
            atlas.describe_key()
        assert refused.value.retry_after is None
        assert clock.sleeps == []
        assert len(server.received) == 1

    def test_is_raised_when_the_wait_it_asks_for_is_longer_than_the_bound(
        self, loopback: Start
    ) -> None:
        server = loopback(Reply(429, {"retry-after": "3600"}, problem(429, "ATLAS-SYS-004")))
        atlas, clock = client(server.base_url)
        with pytest.raises(AtlasApiError) as refused:
            atlas.describe_key()
        assert (refused.value.status, refused.value.retry_after, refused.value.attempts) == (
            429,
            3600,
            1,
        )
        assert clock.sleeps == []

    def test_reads_an_http_date(self, loopback: Start) -> None:
        server = loopback(
            Reply(429, {"retry-after": "Wed, 21 Oct 2099 07:28:00 GMT"}, problem(429, "X")),
        )
        atlas, _ = client(server.base_url, retry=RetryPolicy(max_attempts=1))
        with pytest.raises(AtlasApiError) as refused:
            atlas.describe_key()
        assert refused.value.retry_after is not None
        assert refused.value.retry_after > 60


class TestA5xxOrALostConnection:
    def test_is_retried_for_a_repeatable_read(self, loopback: Start) -> None:
        server = loopback(
            Reply(503, body=problem(503, "ATLAS-SYS-001")), Reply(200, body=KEY_IDENTITY)
        )
        atlas, clock = client(server.base_url)
        atlas.describe_key()
        assert len(server.received) == 2
        assert len(clock.sleeps) == 1

    def test_is_never_retried_for_present_which_counts_every_call(self, loopback: Start) -> None:
        server = loopback(Reply(503, body=problem(503, "ATLAS-SYS-001")), Reply(200, body={}))
        atlas, _ = client(server.base_url)
        with pytest.raises(AtlasApiError) as refused:
            atlas.present_for_end_user(END_USER, NO_PROFILE)
        assert (refused.value.status, refused.value.attempts) == (503, 1)
        assert len(server.received) == 1

    def test_is_never_retried_for_present_when_the_connection_drops(self, loopback: Start) -> None:
        server = loopback(DROP, Reply(200, body={}))
        atlas, _ = client(server.base_url)
        with pytest.raises(AtlasConnectionError) as failed:
            atlas.present_for_end_user(END_USER, NO_PROFILE)
        assert (failed.value.attempts, failed.value.may_have_reached_server) == (1, True)
        assert len(server.received) == 1

    def test_stops_at_max_attempts(self, loopback: Start) -> None:
        server = loopback(Reply(502, body=problem(502, "ATLAS-SYS-001")))
        atlas, _ = client(server.base_url, retry=RetryPolicy(max_attempts=2))
        with pytest.raises(AtlasApiError) as refused:
            atlas.describe_key()
        assert (refused.value.status, refused.value.attempts) == (502, 2)
        assert len(server.received) == 2

    def test_backs_off_exponentially_within_the_bound(self, loopback: Start) -> None:
        server = loopback(Reply(503, body=problem(503, "ATLAS-SYS-001")))
        atlas, clock = client(
            server.base_url, retry=RetryPolicy(max_attempts=4, base_delay=1.0, max_delay=3.0)
        )
        with pytest.raises(AtlasApiError):
            atlas.describe_key()
        # Jitter fixed at zero: half of each ceiling, the ceilings 1, 2 and then the bound, 3.
        assert clock.sleeps == [0.5, 1.0, 1.5]

    def test_refuses_a_retry_policy_with_no_attempts(self) -> None:
        with pytest.raises(AtlasConfigurationError, match="max_attempts"):
            KeyClient(base_url="https://a.example.test", api_key=KEY, retry=RetryPolicy(0))


class TestLinkEndUserTheOneActionWithARepeatGuard:
    def test_replays_a_lost_response_under_the_same_idempotency_key(self, loopback: Start) -> None:
        server = loopback(DROP, Reply(201, body=END_USER_BODY))
        atlas, _ = client(server.base_url)
        assert atlas.link_end_user({"ref": "learner-1"})["id"] == END_USER

        first, second = server.received
        assert re.fullmatch(r"[0-9a-f-]{36}", first.headers["idempotency-key"])
        assert second.headers["idempotency-key"] == first.headers["idempotency-key"]
        assert second.body == first.body

    def test_sends_a_key_of_your_own_when_you_give_one(self, loopback: Start) -> None:
        server = loopback(Reply(201, body=END_USER_BODY))
        atlas, _ = client(server.base_url)
        atlas.link_end_user({"ref": "learner-1"}, idempotency_key="order-4821-link")
        assert server.received[0].headers["idempotency-key"] == "order-4821-link"

    def test_waits_when_its_own_retry_finds_the_first_call_in_flight(self, loopback: Start) -> None:
        server = loopback(
            Reply(503, body=problem(503, "ATLAS-SYS-001")),
            Reply(409, body=problem(409, "ATLAS-DEV-010")),
            Reply(201, body=END_USER_BODY),
        )
        reasons: list[str] = []
        atlas, _ = client(server.base_url, on_retry=lambda event: reasons.append(event.reason))
        atlas.link_end_user({"ref": "learner-1"})
        assert reasons == ["server-error", "in-flight"]
        assert len({r.headers["idempotency-key"] for r in server.received}) == 1

    def test_does_not_retry_atlas_dev_010_on_a_first_attempt(self, loopback: Start) -> None:
        server = loopback(Reply(409, body=problem(409, "ATLAS-DEV-010")))
        atlas, _ = client(server.base_url)
        with pytest.raises(AtlasApiError) as refused:
            atlas.link_end_user({"ref": "learner-1"}, idempotency_key="reused-key-1")
        assert (refused.value.error_code, refused.value.attempts) == ("ATLAS-DEV-010", 1)

    def test_raises_atlas_dev_010_after_a_key_you_supplied(self, loopback: Start) -> None:
        server = loopback(
            Reply(503, body=problem(503, "ATLAS-SYS-001")),
            Reply(409, body=problem(409, "ATLAS-DEV-010")),
            Reply(201, body=END_USER_BODY),
        )
        atlas, _ = client(server.base_url)
        with pytest.raises(AtlasApiError) as refused:
            atlas.link_end_user({"ref": "learner-1"}, idempotency_key="supplied-key-1")
        assert (refused.value.status, refused.value.error_code, refused.value.attempts) == (
            409,
            "ATLAS-DEV-010",
            2,
        )
        assert len(server.received) == 2


class TestARefusal:
    def test_carries_the_code_the_request_id_and_the_rate_limit_figures(
        self, loopback: Start
    ) -> None:
        server = loopback(
            Reply(
                403,
                {
                    "x-request-id": "req-abc123",
                    "ratelimit-limit": "600",
                    "ratelimit-remaining": "598",
                    "ratelimit-reset": "41",
                },
                problem(403, "ATLAS-SYS-007", detail="This key lacks usage:read"),
            )
        )
        atlas, _ = client(server.base_url)
        with pytest.raises(AtlasApiError) as refused:
            atlas.developer_usage()
        error = refused.value
        assert error.operation_id == "developerUsage"
        assert (error.status, error.error_code, error.detail, error.request_id) == (
            403,
            "ATLAS-SYS-007",
            "This key lacks usage:read",
            "req-abc123",
        )
        assert error.rate_limit is not None
        assert (error.rate_limit.limit, error.rate_limit.remaining) == (600, 598)
        assert error.rate_limit.reset_seconds == 41
        assert "ATLAS-SYS-007" in str(error)

    def test_carries_the_error_id_of_an_unexpected_500(self, loopback: Start) -> None:
        server = loopback(Reply(500, body=problem(500, "ATLAS-SYS-001", errorId="err-77")))
        atlas, _ = client(server.base_url, retry=RetryPolicy(max_attempts=1))
        with pytest.raises(AtlasApiError) as refused:
            atlas.describe_key()
        assert (refused.value.error_id, refused.value.error_code) == ("err-77", "ATLAS-SYS-001")

    def test_survives_a_body_that_is_not_a_problem_document_and_never_echoes_it(
        self, loopback: Start
    ) -> None:
        html = b"<html><body>HTTP Status 400 - Bad Request <script>x</script></body></html>"
        server = loopback(Reply(400, {"content-type": "text/html"}, raw=html))
        atlas, _ = client(server.base_url)
        with pytest.raises(AtlasApiError) as refused:
            atlas.describe_key()
        assert refused.value.error_code is None
        assert refused.value.problem is None
        assert "text/html" in str(refused.value)
        assert "<" not in str(refused.value)

    def test_never_carries_the_credential(self, loopback: Start) -> None:
        server = loopback(Reply(401, body=problem(401, "ATLAS-SYS-002")))
        atlas, _ = client(server.base_url)
        with pytest.raises(AtlasApiError) as refused:
            atlas.describe_key()
        assert KEY not in everything_on(refused.value)


class TestARedirect:
    def test_is_never_followed_so_the_key_never_reaches_another_address(
        self, loopback: Start
    ) -> None:
        elsewhere = loopback(Reply(200, body=KEY_IDENTITY))
        server = loopback(Reply(307, {"location": f"{elsewhere.base_url}/v1/key"}))
        atlas, _ = client(server.base_url)
        with pytest.raises(AtlasApiError, match="redirect") as refused:
            atlas.describe_key()
        assert refused.value.status == 307
        assert elsewhere.received == []

    def test_handler_that_follows_redirects_is_refused(self) -> None:
        with pytest.raises(AtlasConfigurationError, match="redirect"):
            KeyClient(
                base_url="https://a.example.test",
                api_key=KEY,
                handlers=[urllib.request.HTTPRedirectHandler()],
            )
        with pytest.raises(AtlasConfigurationError, match="ssl_context"):
            KeyClient(
                base_url="https://a.example.test",
                api_key=KEY,
                handlers=[urllib.request.HTTPSHandler()],
            )


class TestRateLimitState:
    def test_is_what_the_last_response_reported(self, loopback: Start) -> None:
        server = loopback(
            Reply(
                200,
                {"ratelimit-limit": "600", "ratelimit-remaining": "12", "ratelimit-reset": "9"},
                KEY_IDENTITY,
            )
        )
        atlas, _ = client(server.base_url)
        before = atlas.rate_limit
        assert before is None
        atlas.describe_key()
        after = atlas.rate_limit
        assert after is not None
        assert (after.limit, after.remaining, after.reset_seconds) == (600, 12, 9)

    def test_is_unknown_not_unlimited_when_the_headers_are_absent(self, loopback: Start) -> None:
        server = loopback(Reply(200, body=KEY_IDENTITY))
        atlas, _ = client(server.base_url)
        atlas.describe_key()
        assert atlas.rate_limit is None


class TestWhatIsRefusedBeforeAnythingIsSent:
    @pytest.mark.parametrize("suffix", ["\r\nx: y", "\nwrapped", "\x00", "é"])
    def test_a_credential_a_header_cannot_carry_without_repeating_it(
        self, loopback: Start, suffix: str
    ) -> None:
        server = loopback(Reply(200, body=KEY_IDENTITY))
        atlas = KeyClient(base_url=server.base_url, api_key=KEY + suffix, org_id=ORG)
        with pytest.raises(AtlasConfigurationError) as refused:
            atlas.describe_key()
        assert KEY not in everything_on(refused.value)
        assert server.received == []

    def test_a_user_agent_or_an_idempotency_key_a_header_cannot_carry(
        self, loopback: Start
    ) -> None:
        server = loopback(Reply(201, body=END_USER_BODY))
        with pytest.raises(AtlasConfigurationError):
            KeyClient(base_url=server.base_url, api_key=KEY, user_agent="app\r\nx: y")
        atlas, _ = client(server.base_url)
        with pytest.raises(AtlasConfigurationError):
            atlas.link_end_user({"ref": "r"}, idempotency_key="key\nwith-a-break")
        assert server.received == []

    @pytest.mark.parametrize("value", [".", ".."])
    def test_a_path_value_a_url_would_resolve_into_a_different_route(
        self, loopback: Start, value: str
    ) -> None:
        server = loopback(Reply(200, body={}))
        atlas, _ = client(server.base_url)
        with pytest.raises(AtlasConfigurationError):
            atlas.get_resource(value)
        with pytest.raises(AtlasConfigurationError):
            atlas.revoke_end_user(value)
        assert server.received == []

    def test_a_body_that_is_not_json(self, loopback: Start) -> None:
        server = loopback(Reply(200, body={}))
        atlas, _ = client(server.base_url)
        with pytest.raises(AtlasConfigurationError, match="JSON"):
            atlas.link_end_user(cast(Any, {"ref": float("nan")}))
        assert server.received == []


class TestABody:
    def test_that_stalls_part_way_is_an_atlas_connection_error(self, loopback: Start) -> None:
        server = loopback(STALL)
        atlas = KeyClient(base_url=server.base_url, api_key=KEY, org_id=ORG, timeout=0.3)
        with pytest.raises(AtlasConnectionError) as failed:
            atlas.describe_key()
        assert failed.value.may_have_reached_server is True

    def test_of_a_refusal_larger_than_an_api_ever_sends_is_not_echoed(
        self, loopback: Start
    ) -> None:
        big = b'"' + b"x" * 200_000 + b'"'
        server = loopback(Reply(400, {"content-type": "application/json"}, raw=big))
        atlas, _ = client(server.base_url)
        with pytest.raises(AtlasApiError) as refused:
            atlas.describe_key()
        assert refused.value.problem is None
        assert len(str(refused.value)) < 500

    def test_of_a_success_that_is_not_json_is_an_atlas_error(self, loopback: Start) -> None:
        server = loopback(Reply(200, {"content-type": "application/json"}, raw=b"<html>"))
        atlas, _ = client(server.base_url)
        with pytest.raises(AtlasError, match="not JSON"):
            atlas.describe_key()


class TestWhatTheSecurityReviewFound:
    def test_a_redirect_handler_class_is_refused_as_well_as_an_instance(self) -> None:
        class FollowsRedirects(urllib.request.BaseHandler):
            def http_error_302(self, *args: object) -> None:
                return None

        for handlers in (
            [urllib.request.HTTPRedirectHandler],
            [FollowsRedirects()],
            [urllib.request.ProxyHandler],
        ):
            with pytest.raises(AtlasConfigurationError):
                KeyClient(base_url="https://a.example.test", api_key=KEY, handlers=handlers)  # type: ignore[arg-type]

    def test_a_loopback_http_address_is_never_proxied_whatever_the_environment_says(
        self, loopback: Start, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        proxy = loopback(Reply(200, body=KEY_IDENTITY))
        api = loopback(Reply(200, body=KEY_IDENTITY))
        for name in ("HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"):
            monkeypatch.setenv(name, proxy.base_url)
        for name in ("NO_PROXY", "no_proxy"):
            monkeypatch.delenv(name, raising=False)
        atlas, _ = client(api.base_url)
        atlas.describe_key()
        assert len(api.received) == 1
        assert proxy.received == []
        with pytest.raises(AtlasConfigurationError, match="proxy"):
            KeyClient(
                base_url=api.base_url,
                api_key=KEY,
                handlers=[urllib.request.ProxyHandler({"http": proxy.base_url})],
            )

    def test_a_body_that_trickles_in_is_cut_off_at_the_timeout(self, loopback: Start) -> None:
        server = loopback(DRIP)
        atlas = KeyClient(base_url=server.base_url, api_key=KEY, org_id=ORG, timeout=0.5)
        started = time.monotonic()
        with pytest.raises(AtlasConnectionError):
            atlas.describe_key()
        # 200 bytes at one per 0.1 s would take 20 s, and every byte resets an idle timeout.
        assert time.monotonic() - started < 3

    @pytest.mark.parametrize("status", [200, 400])
    def test_a_body_nested_too_deep_to_parse_is_an_atlas_error(
        self, loopback: Start, monkeypatch: pytest.MonkeyPatch, status: int
    ) -> None:
        # Whether a given depth overflows depends on the platform's stack (Python 3.14 guards by
        # real stack depth, and Linux's is far deeper than Windows'), so the parser is made to
        # overflow here rather than trusted to.
        def overflowing(*_: object, **__: object) -> object:
            raise RecursionError("maximum recursion depth exceeded while decoding a JSON array")

        server = loopback(Reply(status, {"content-type": "application/json"}, raw=b"[[[]]]"))
        atlas, _ = client(server.base_url)
        monkeypatch.setattr(json, "loads", overflowing)
        with pytest.raises(AtlasError):
            atlas.describe_key()

    def test_a_rate_limit_figure_too_long_to_be_real_is_unknown_not_an_error(
        self, loopback: Start
    ) -> None:
        server = loopback(
            Reply(
                200,
                {"ratelimit-limit": "9" * 5000, "ratelimit-remaining": "1", "ratelimit-reset": "1"},
                KEY_IDENTITY,
            )
        )
        atlas, _ = client(server.base_url)
        atlas.describe_key()
        assert atlas.rate_limit is None

    def test_a_response_whose_head_was_slow_is_kept_once_it_has_arrived(
        self, loopback: Start
    ) -> None:
        # Each wait for the head is inside the timeout, and the whole head takes longer than it.
        # A complete answer is still an answer: throwing it away would report a counted present
        # as a failure.
        server = loopback(SLOW_HEAD)
        atlas = KeyClient(base_url=server.base_url, api_key=KEY, org_id=ORG, timeout=0.4)
        assert atlas.describe_key()["keyId"] == "k"
