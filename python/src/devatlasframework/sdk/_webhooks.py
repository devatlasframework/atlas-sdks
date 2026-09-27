"""Verifying that a message to your webhook endpoint came from ATLAS."""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import re
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Final, cast

from ._errors import AtlasConfigurationError, WebhookVerificationError
from ._generated.contract import ResourceWebhookEvent

SIGNATURE_HEADER: Final = "atlas-signature"
"""The header carrying the signature, lower-cased; header lookups are case-insensitive."""

DEFAULT_TOLERANCE_SECONDS: Final = 300
"""How far the signed timestamp may be from your clock, in seconds, as ATLAS publishes it."""

# A signature header longer than this is refused unread. ATLAS sends one timestamp and at most two
# signatures.
_MAX_HEADER_LENGTH = 1024

# The most timestamps and signatures a header may carry. Every timestamp costs a keyed hash of the
# whole body per secret, and an unauthenticated caller writes the header, so an unbounded count is a
# way to spend your CPU for free. ATLAS sends one timestamp, and two signatures during a rotation.
_MAX_TIMESTAMPS = 2
_MAX_SIGNATURES = 4

# ASCII digits: `\d` matches any script's digits, which a forged header could use to raise
# something other than WebhookVerificationError.
_TIMESTAMP = re.compile(r"[0-9]{1,12}")
_SIGNATURE = re.compile(r"[0-9a-f]{64}")


def verify_webhook(
    raw_body: bytes | bytearray | memoryview | str,
    signature_header: str | None,
    secrets: str | Sequence[str],
    *,
    tolerance_seconds: float = DEFAULT_TOLERANCE_SECONDS,
    now: datetime | None = None,
) -> ResourceWebhookEvent:
    """Verifies a webhook delivery and returns its event.

    Pass the RAW request body - the exact bytes received, before any JSON parsing. Parsing and
    re-serialising changes the bytes, and the signature covers the bytes.

    Pass every secret you may be signing under. While you rotate an endpoint's secret, ATLAS signs
    with the new one and the old one, and either verifies. Every signature in the header is tried
    against every secret, so a delivery verifies throughout the overlap.

    Then deduplicate on the event's `delivery_id`: delivery is at least once, and a retried delivery
    carries the same `delivery_id` with a fresh signature.

    Args:
        raw_body: The request body exactly as received.
        signature_header: The `ATLAS-Signature` header's value.
        secrets: The endpoint's signing secret, or every secret during a rotation.
        tolerance_seconds: How far the signed timestamp may be from `now`. Default `300`.
        now: The time to check against. Default: this machine's clock.

    Returns:
        The event the delivery carries.

    Raises:
        WebhookVerificationError: The delivery is not authentic or not fresh. Answer it with a
            `4xx` and do nothing else with it.
        AtlasConfigurationError: `tolerance_seconds` is not a finite, non-negative number.

    Example:
        ```python
        from flask import Flask, request
        from devatlasframework.sdk import SIGNATURE_HEADER, WebhookVerificationError, verify_webhook

        @app.post("/atlas/webhooks")
        def atlas_webhook():
            try:
                event = verify_webhook(
                    request.get_data(),  # the raw bytes, not request.json
                    request.headers.get(SIGNATURE_HEADER),
                    os.environ["ATLAS_WEBHOOK_SECRET"],
                )
            except WebhookVerificationError as error:
                return error.reason, 400
            deliveries.record_once(event)  # durably, keyed on event["delivery_id"] - then answer
            return "", 204  # ATLAS never re-sends a delivery you answered 2xx
        ```
    """
    if not isinstance(raw_body, (bytes, bytearray, memoryview, str)):
        raise WebhookVerificationError(
            "not-raw",
            "pass the raw request body as received - bytes or a string - not a parsed object: "
            "re-serialising changes the bytes the signature covers",
        )
    keys = [secrets] if isinstance(secrets, str) else list(secrets)
    keys = [key for key in keys if isinstance(key, str) and key != ""]
    if not keys:
        raise WebhookVerificationError("no-secret", "no signing secret to verify with")
    if not isinstance(signature_header, str) or signature_header.strip() == "":
        raise WebhookVerificationError(
            "missing-header", f"the {SIGNATURE_HEADER} header is missing"
        )
    if len(signature_header) > _MAX_HEADER_LENGTH:
        raise WebhookVerificationError(
            "malformed-header", f"the {SIGNATURE_HEADER} header is too long to be ATLAS's"
        )

    timestamps: dict[str, None] = {}  # ordered and distinct
    signatures: list[bytes] = []
    for part in signature_header.split(","):
        name, separator, value = part.partition("=")
        if not separator:
            continue
        name, value = name.strip(), value.strip()
        if name == "t" and _TIMESTAMP.fullmatch(value):
            timestamps[value] = None
        # A v1 is 64 lower-case hex characters; anything else can never match and is skipped.
        # Other names are skipped too, so a future scheme sent beside v1 does not break this one.
        if name == "v1" and _SIGNATURE.fullmatch(value):
            signatures.append(bytes.fromhex(value))
    if not timestamps or not signatures:
        raise WebhookVerificationError(
            "malformed-header",
            f"the {SIGNATURE_HEADER} header carries no usable t= and v1= values",
        )
    if len(timestamps) > _MAX_TIMESTAMPS or len(signatures) > _MAX_SIGNATURES:
        raise WebhookVerificationError(
            "malformed-header",
            f"the {SIGNATURE_HEADER} header carries more timestamps or signatures than ATLAS "
            "ever sends",
        )

    if (
        isinstance(tolerance_seconds, bool)
        or not isinstance(tolerance_seconds, (int, float))
        or not math.isfinite(tolerance_seconds)
        or tolerance_seconds < 0
    ):
        raise AtlasConfigurationError(
            "tolerance_seconds must be a finite number of seconds, not negative: without a "
            "window, a captured delivery can be replayed for ever"
        )

    if now is not None and now.tzinfo is None:
        raise AtlasConfigurationError(
            "now must carry a time zone: a naive datetime is read as this machine's local time"
        )

    body = raw_body.encode("utf-8") if isinstance(raw_body, str) else bytes(raw_body)
    # Every timestamp is tried, and the one that produced a match is the one checked for freshness.
    # Checking the last one parsed instead is the classic hole: a captured old signature with a new
    # `t=` appended would verify against the old value and pass the window against the new one.
    matched: list[int] = []
    for timestamp in timestamps:
        for secret in keys:
            expected = hmac.new(
                secret.encode("utf-8"), timestamp.encode("ascii") + b"." + body, hashlib.sha256
            ).digest()
            if any(hmac.compare_digest(expected, signature) for signature in signatures):
                matched.append(int(timestamp))
                break
    if not matched:
        raise WebhookVerificationError(
            "no-match",
            "no signature matches this body under any secret given: it was not signed by ATLAS "
            "with your secret, or the body was altered",
        )

    current = math.floor((now or datetime.now(UTC)).timestamp())
    if not any(abs(current - timestamp) <= tolerance_seconds for timestamp in matched):
        raise WebhookVerificationError(
            "stale",
            f"the signature is authentic but its timestamp is more than {tolerance_seconds:g} "
            "seconds from now: it may be a replay",
        )

    try:
        return cast(ResourceWebhookEvent, json.loads(body.decode("utf-8")))
    except (ValueError, RecursionError):
        raise WebhookVerificationError(
            "not-json", "the signature is valid, and the body is not JSON"
        ) from None
