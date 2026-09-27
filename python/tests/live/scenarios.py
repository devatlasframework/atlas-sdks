"""The live scenarios, one runner per id in ../../../scenarios/live.json.

Each runner does what its scenario's `expect` says, against a deployed API, and asserts it. The
registry at the bottom is checked against live.json by the unit suite, in both directions, so a
scenario added there turns this SDK's CI red until it is implemented here.

Nothing here reads configuration at import: `test_live.py` builds the `Live` context.
"""

from __future__ import annotations

import http.server
import json
import threading
import time
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit

from devatlasframework.sdk import (
    AtlasApiError,
    DelegatedPass,
    EndUser,
    KeyClient,
    LearnerProfile,
    PassClient,
    RefreshRefusedError,
    ResponseEvent,
    RetryEvent,
    RetryPolicy,
    WebhookVerificationError,
    authorization_url,
    create_pkce_pair,
    exchange_code,
    verify_webhook,
)

RESULTS = Path(__file__).resolve().parents[2] / "live-results"

# What ATLAS_API_KEY must carry, as live.json's `requires` describes it.
KEY_SCOPES = ("content:read", "end-users:manage", "ai:use", "usage:read")


@dataclass
class Live:
    """One live run: its configuration, what each scenario called, and what it found."""

    env: Mapping[str, str]
    profile: LearnerProfile
    options: dict[str, Any] = field(default_factory=dict)
    current: str = ""
    exercised: dict[str, set[str]] = field(default_factory=dict)
    transcript: list[dict[str, object]] = field(default_factory=list)
    results: dict[str, object] = field(default_factory=dict)
    org_id: str = ""
    app_id: str = ""
    end_user: EndUser | None = None

    def observe(self, event: ResponseEvent) -> None:
        """Records every response: which operation, which attempt, its status and request id."""
        self.exercised.setdefault(self.current, set()).add(event.operation_id)
        self.transcript.append(
            {
                "scenario": self.current,
                "operationId": event.operation_id,
                "attempt": event.attempt,
                "status": event.status,
                "requestId": event.request_id,
            }
        )

    def key_client(self, **extra: Any) -> KeyClient:
        return KeyClient(
            base_url=self.env["ATLAS_BASE_URL"],
            api_key=self.env["ATLAS_API_KEY"],
            user_agent="atlas-sdks-live-suite",
            on_response=self.observe,
            **{**self.options, **extra},
        )


def describe_key(live: Live) -> None:
    """The key's organisation, application and permissions."""
    key = live.key_client().describe_key()
    assert key["orgId"], "the key names its organisation"
    assert key["appId"], "and its application"
    missing = [scope for scope in KEY_SCOPES if scope not in key["scopes"]]
    assert not missing, f"the key lacks {missing}, which live.json requires"
    live.org_id, live.app_id = key["orgId"], key["appId"]
    live.results["describe-key"] = {
        "orgId": key["orgId"],
        "appId": key["appId"],
        "scopes": key["scopes"],
        "expiresAt": key.get("expiresAt"),
    }


def read_named_content(live: Live) -> None:
    """A READY resource by title, not an empty list; the same one by id; and its download."""
    atlas = live.key_client()
    page = atlas.list_resources(status=["READY"], size=10)
    named = next((r for r in page["items"] if r["status"] == "READY" and r["title"]), None)
    assert named is not None, "listResources returns at least one READY resource with a title"
    one = atlas.get_resource(named["id"])
    assert (one["id"], one["title"]) == (named["id"], named["title"]), "the same resource by id"
    download = atlas.get_resource_download(named["id"])
    assert download["downloadUrl"].startswith(("https://", "http://")), "a download address"
    assert download["filename"], "and a file name"
    # The download address is itself a credential for the file, so it is never written down.
    live.results["read-named-content"] = {
        "totalReady": page["totalItems"],
        "resource": {
            "id": one["id"],
            "title": one["title"],
            "status": one["status"],
            "versionNumber": one["versionNumber"],
        },
        "download": {"filename": download["filename"], "expiresAt": download["expiresAt"]},
    }


class DiscardFirstLink(urllib.request.BaseHandler):
    """The fault: the first linkEndUser answer is read, then lost, as if the connection dropped.

    It also records the Idempotency-Key each linkEndUser attempt carried, as sent.
    """

    def __init__(self) -> None:
        self.keys: list[str] = []
        self.dropped = False

    @staticmethod
    def _is_link(request: urllib.request.Request) -> bool:
        return request.get_method() == "POST" and request.full_url.endswith("/end-users")

    def http_request(self, request: urllib.request.Request) -> urllib.request.Request:
        if self._is_link(request):
            sent = {name.lower(): value for name, value in request.header_items()}
            self.keys.append(sent.get("idempotency-key", ""))
        return request

    https_request = http_request

    def http_response(self, request: urllib.request.Request, response: Any) -> Any:
        if self._is_link(request) and not self.dropped:
            self.dropped = True
            response.read()
            response.close()
            raise ConnectionResetError("fault injected: the API answered, and the answer was lost")
        return response

    https_response = http_response


def link_retried_under_one_key(live: Live) -> None:
    """One retry under one Idempotency-Key, one more active link, and the key proven recorded."""
    fault = DiscardFirstLink()
    atlas = live.key_client(handlers=[fault])

    def active() -> int:
        page = atlas.list_end_users()
        assert page["nextCursor"] is None, "every link fits on one page, so the count is exact"
        return sum(1 for one in page["items"] if one["active"])

    before = active()
    ref = f"sdk-live-python-{int(time.time() * 1000)}"
    end_user = atlas.link_end_user({"ref": ref})
    assert len(fault.keys) == 2, "the SDK retried once"
    assert fault.keys[0], "the first attempt carried a key"
    assert fault.keys[1] == fault.keys[0], "and the retry carried the same one"
    after = active()
    assert after == before + 1, "exactly one more active link"

    try:
        atlas.link_end_user({"ref": f"{ref}-other"}, idempotency_key=fault.keys[0])
    except AtlasApiError as refused:
        conflict = refused
    else:
        raise AssertionError("the same key with a different body was accepted")
    assert (conflict.status, conflict.error_code) == (409, "ATLAS-DEV-010")

    live.end_user = end_user
    live.results["link-retried-under-one-key"] = {
        "attempts": len(fault.keys),
        "sameKey": fault.keys[0] == fault.keys[1],
        "activeLinks": {"before": before, "after": after},
        "endUserId": end_user["id"],
        "sameKeyDifferentBody": {"status": conflict.status, "errorCode": conflict.error_code},
    }


def present_both_shapes(live: Live) -> None:
    """200, with an endorsement from a bipolar sub-dimension and one from a multi-category one."""
    assert live.end_user is not None, "link-retried-under-one-key made the link this uses"
    plan = live.key_client().present_for_end_user(live.end_user["id"], {"profile": live.profile})
    scores = live.profile["subDimensionScores"]
    # An endorsement's key is `<sub-dimension>.<category or pole>`, such as `D2a.Quiet`.
    shapes = {
        e["key"]: scores[e["key"].split(".", 1)[0]]["structureType"]
        for e in plan["endorsements"]
        if e["key"].split(".", 1)[0] in scores
    }
    assert "bipolar" in shapes.values(), "an endorsement from a bipolar sub-dimension"
    assert "multi-category" in shapes.values(), "and one from a multi-category sub-dimension"
    live.results["present-both-shapes"] = {
        "endorsements": [f"{key} ({shape})" for key, shape in shapes.items()]
    }


def usage(live: Live) -> None:
    """This period's usage, listing the key's own application."""
    report = live.key_client().developer_usage()
    assert any(app["appId"] == live.app_id for app in report["apps"]), "the key's own application"
    live.results["usage"] = {
        "periodStart": report["periodStart"],
        "periodEnd": report["periodEnd"],
        "calls": report["calls"],
        "state": report["state"],
    }


def revoke_link(live: Live) -> None:
    """The link made above answers inactive, with a revocation time."""
    assert live.end_user is not None, "link-retried-under-one-key made the link this revokes"
    revoked = live.key_client().revoke_end_user(live.end_user["id"])
    assert revoked["id"] == live.end_user["id"]
    assert revoked["active"] is False, "inactive"
    assert revoked.get("revokedAt"), "with a revocation time"
    live.results["revoke-link"] = {"active": revoked["active"], "revokedAt": revoked["revokedAt"]}


def wait_for_consent(live: Live, consent_url: str, state: str) -> str:
    """Serves ATLAS_REDIRECT_URI until the consent page sends the person back; returns the code."""
    redirect = urlsplit(live.env["ATLAS_REDIRECT_URI"])
    outcome: dict[str, str] = {}
    answered = threading.Event()

    class Callback(http.server.BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:
            pass

        def do_GET(self) -> None:
            url = urlsplit(self.path)
            if url.path != redirect.path:
                self.send_response(404)
                self.end_headers()
                return
            query = {name: values[0] for name, values in parse_qs(url.query).items()}
            if query.get("state") != state:
                outcome["error"] = "the consent page answered with a state this run did not send"
                message = "The state did not match, so this answer was ignored."
            elif "error" in query:
                outcome["error"] = f"the consent page answered {query['error']}"
                message = "Consent was not given."
            else:
                outcome["code"] = query.get("code", "")
                message = "Consent received."
            self.send_response(200)
            self.send_header("content-type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(f"{message} You can close this tab.".encode())
            answered.set()

    server = http.server.HTTPServer(
        (redirect.hostname or "127.0.0.1", redirect.port or 80), Callback
    )
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.2})
    thread.start()
    try:
        RESULTS.mkdir(exist_ok=True)
        (RESULTS / "consent-url.txt").write_text(consent_url + "\n", encoding="utf-8")
        print(f"\n  CONSENT NEEDED - sign in and choose Allow at:\n  {consent_url}\n", flush=True)
        assert answered.wait(10 * 60), "nobody answered the consent page within 10 minutes"
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    assert "error" not in outcome, outcome.get("error")
    return outcome["code"]


def delegated_grant(live: Live) -> None:
    """Exchange, read all three, refresh; the replaced token refused; the old pass still reads."""
    base_url, org_id = live.env["ATLAS_BASE_URL"], live.env["ATLAS_PASS_ORG_ID"]
    client_id = live.env["ATLAS_CLIENT_ID"]
    options = {"base_url": base_url, "on_response": live.observe, **live.options}
    pkce = create_pkce_pair()
    state = f"live-{int(time.time() * 1000)}"
    consent_url = authorization_url(
        web_base_url=live.env["ATLAS_WEB_URL"],
        client_id=client_id,
        org_id=org_id,
        redirect_uri=live.env["ATLAS_REDIRECT_URI"],
        scopes=["content:read"],
        state=state,
        code_challenge=pkce.challenge,
    )
    # The code expires about a minute after consent, so it is exchanged the moment it arrives.
    code = wait_for_consent(live, consent_url, state)
    delegated = exchange_code(
        client_id=client_id,
        code=code,
        redirect_uri=live.env["ATLAS_REDIRECT_URI"],
        code_verifier=pkce.verifier,
        **options,
    )

    as_person = PassClient(org_id=org_id, delegated_pass=delegated, **options)
    page = as_person.list_resources(size=5)
    assert page["items"], "the person can read at least one resource"
    first = page["items"][0]
    as_person.get_resource(first["id"])
    as_person.get_resource_download(first["id"])

    before = delegated.snapshot()
    delegated.refresh()
    assert delegated.access_token != before["access_token"], "a refresh rotates the pass"

    spent = DelegatedPass.restore(before, client_id=client_id, **options)
    try:
        spent.refresh()
    except RefreshRefusedError as error:
        refusal = error.refusal
    else:
        raise AssertionError("the refresh token a refresh replaced was accepted")
    assert isinstance(refusal, AtlasApiError), "refused by the API, not lost on the way"
    assert (refusal.status, refusal.error_code) == (400, "ATLAS-DEV-014")

    # A refused renewal leaves a live pass live: the one issued before the refresh still reads.
    still = PassClient(org_id=org_id, delegated_pass=spent, **options).list_resources(size=1)
    assert still["items"], "the pass issued before the refresh still reads"

    live.results["delegated-grant"] = {
        "scope": delegated.scope,
        "passReads": {"resources": page["totalItems"], "resourceId": first["id"]},
        "refreshed": True,
        "spentRefreshToken": {"status": refusal.status, "errorCode": refusal.error_code},
        "passIssuedBeforeRefreshStillReads": True,
    }


def webhook_from_the_real_sender(live: Live) -> None:
    """The newest captured delivery verifies as of its arrival; one changed byte is refused."""
    capture = urlsplit(live.env["ATLAS_WEBHOOK_CAPTURE_URL"])
    query = urlencode(
        {**{k: v[0] for k, v in parse_qs(capture.query).items()}, "sorting": "newest"}
    )
    request = urllib.request.Request(
        urlunsplit((capture.scheme, capture.netloc, capture.path, query, "")),
        headers={"Accept": "application/json", "User-Agent": "atlas-sdks-live-suite"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        log: dict[str, Any] = json.loads(response.read())

    def header(entry: Mapping[str, Any], name: str) -> str | None:
        values = (entry.get("headers") or {}).get(name) or []
        return values[0] if values else None

    delivery = next((e for e in log.get("data") or [] if header(e, "atlas-signature")), None)
    assert delivery is not None, "a delivery from ATLAS in the receiver's log"
    signature = header(delivery, "atlas-signature") or ""
    arrived = datetime.fromisoformat(delivery["created_at"].replace(" ", "T")).replace(tzinfo=UTC)
    secret = live.env["ATLAS_WEBHOOK_SECRET"]
    body: str = delivery.get("content") or ""
    event = verify_webhook(body, signature, secret, now=arrived)

    tampered = bytearray(body.encode("utf-8"))
    tampered[-2] ^= 0x01
    try:
        verify_webhook(bytes(tampered), signature, secret, now=arrived)
    except WebhookVerificationError:
        pass
    else:
        raise AssertionError("the body with one byte changed verified")

    # A signature proves who signed, not which environment sent it: the delivery must be recent,
    # and about a resource the environment under test holds.
    age_hours = (datetime.now(UTC) - arrived).total_seconds() / 3600
    assert age_hours < 24, f"the delivery arrived within the last 24 hours, not {age_hours:.1f}"
    about = live.key_client().get_resource(event["data"]["resource_id"])
    assert about["id"] == event["data"]["resource_id"], "a resource this environment holds"

    signed_at = next(p.split("=", 1)[1] for p in signature.split(",") if p.startswith("t="))
    live.results["webhook-from-the-real-sender"] = {
        "deliveryId": event["delivery_id"],
        "type": event["type"],
        "resource": {"id": about["id"], "title": about["title"]},
        "ageHours": round(age_hours, 1),
        "arrived": arrived.isoformat(),
        "signedAt": datetime.fromtimestamp(int(signed_at), UTC).isoformat(),
        "attempt": header(delivery, "atlas-delivery-attempt"),
        "oneByteChanged": "refused",
    }


def throttled_and_honoured(live: Live) -> None:
    """A 429 with Retry-After; the SDK waits at least that long, and the same call then succeeds."""
    retries: list[RetryEvent] = []
    atlas = live.key_client(on_retry=retries.append, retry=RetryPolicy(max_retry_after_seconds=90))
    calls = 0
    started = time.monotonic()
    waited = 0.0
    while calls < 1500 and not any(r.reason == "throttled" for r in retries):
        call_started = time.monotonic()
        atlas.describe_key()  # raises unless the call, retried after any 429, succeeded
        waited = time.monotonic() - call_started
        calls += 1
    throttled = next((r for r in retries if r.reason == "throttled"), None)
    assert throttled is not None, "a 429 within 1500 calls"
    assert throttled.status == 429
    assert throttled.retry_after is not None, "carrying Retry-After"
    assert throttled.retry_after > 0
    assert waited >= throttled.retry_after, "the SDK waited at least that long, measured"
    live.results["throttled-and-honoured"] = {
        "callsUntilThrottled": calls,
        "retryAfter": throttled.retry_after,
        "waitedSeconds": round(waited, 1),
        "requestId": throttled.request_id,
        "thenSucceeded": True,
        "seconds": round(time.monotonic() - started),
    }


RUNNERS: dict[str, Callable[[Live], None]] = {
    "describe-key": describe_key,
    "read-named-content": read_named_content,
    "link-retried-under-one-key": link_retried_under_one_key,
    "present-both-shapes": present_both_shapes,
    "usage": usage,
    "revoke-link": revoke_link,
    "delegated-grant": delegated_grant,
    "webhook-from-the-real-sender": webhook_from_the_real_sender,
    "throttled-and-honoured": throttled_and_honoured,
}
"""Every scenario this SDK implements, by its id in live.json."""
