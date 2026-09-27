"""Rate-limit state, read from the headers ATLAS sends."""

from __future__ import annotations

import math
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from email.utils import parsedate_to_datetime

# ASCII digits only, and few enough to be a real figure: `\d` matches any script's digits, and
# int() refuses more than 4300 of them with a ValueError the caller never asked for.
_INTEGER = re.compile(r"[0-9]{1,15}")

type HeaderLookup = Callable[[str], str | None]
"""Reads one response header by name, case-insensitively: `response.headers.get`."""


@dataclass(frozen=True, slots=True)
class RateLimitState:
    """Your request-rate budget, as the last response reported it.

    It describes one budget: your own overall request rate. Several operations also have narrower
    limits of their own, and when one of those refuses you, the response still carries your overall
    figures unchanged - so `remaining` can read a healthy number beside a `429`. Diagnose a refusal
    from its `retry_after` and its `error_code` (both on `AtlasApiError`), never from `remaining`.

    Attributes:
        limit: Your request ceiling for one window (`RateLimit-Limit`).
        remaining: Requests left in the current window, floored at zero (`RateLimit-Remaining`).
        reset_seconds: Seconds until the current window ends, as of `observed_at`
            (`RateLimit-Reset`).
        observed_at: When the response carrying these figures arrived.
    """

    limit: int
    remaining: int
    reset_seconds: int
    observed_at: datetime


def _integer(value: str | None) -> int | None:
    if value is None or not _INTEGER.fullmatch(value.strip()):
        return None
    return int(value.strip())


def read_rate_limit(header: HeaderLookup, observed_at: datetime) -> RateLimitState | None:
    """Reads the three `RateLimit-*` headers, or returns `None` when any is missing or unreadable.

    Absence is not "unlimited". ATLAS omits the headers when it cannot reach the counter behind the
    budget, rather than report a figure it cannot stand behind, so `None` means unknown.

    Args:
        header: Reads one response header by name, such as `response.headers.get`.
        observed_at: When the response arrived.

    Returns:
        The budget the response reported, or `None` when it reported none.

    Example:
        >>> from datetime import UTC, datetime
        >>> headers = {"ratelimit-limit": "600", "ratelimit-remaining": "599"}
        >>> headers["ratelimit-reset"] = "60"
        >>> read_rate_limit(headers.get, datetime(2026, 1, 1, tzinfo=UTC)).remaining
        599
    """
    limit = _integer(header("ratelimit-limit"))
    remaining = _integer(header("ratelimit-remaining"))
    reset_seconds = _integer(header("ratelimit-reset"))
    if limit is None or remaining is None or reset_seconds is None:
        return None
    return RateLimitState(limit, remaining, reset_seconds, observed_at)


def read_retry_after(header: HeaderLookup, now: datetime) -> int | None:
    """Reads `Retry-After` as seconds: either form RFC 9110 allows, delta-seconds or an HTTP date.

    `None` when it is absent, which on a `429` means the refusal does not clear after an interval
    (an exhausted credit allowance, for one) and waiting would not help.

    Args:
        header: Reads one response header by name, such as `response.headers.get`.
        now: The time an HTTP date is measured from.

    Returns:
        The wait in whole seconds, or `None` when the header is absent or unreadable.

    Example:
        >>> from datetime import UTC, datetime
        >>> read_retry_after({"retry-after": "30"}.get, datetime(2026, 1, 1, tzinfo=UTC))
        30
    """
    value = (header("retry-after") or "").strip()
    if not value:
        return None
    if _INTEGER.fullmatch(value):
        return int(value)
    try:
        at = parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError, OverflowError):
        return None
    if at.tzinfo is None or now.tzinfo is None:
        return None
    return max(0, math.ceil((at - now).total_seconds()))
