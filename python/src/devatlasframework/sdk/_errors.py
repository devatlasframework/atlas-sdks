"""Every error this SDK raises."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from ._generated.contract import Error, Problem
from ._rate_limit import RateLimitState


class AtlasError(Exception):
    """The base class of every error this SDK raises."""


class AtlasConfigurationError(AtlasError):
    """The SDK was set up in a way it refuses, before any request was sent."""


class AtlasApiError(AtlasError):
    """The API answered, and the answer was a refusal.

    Branch on `error_code`: it is on every refusal and names one cause exactly. The problem `type`
    is coarser (two causes can share one) and is an identifier to compare, never a link to fetch.
    Quote `request_id` in a support report; for an unexpected `500`, `error_id` is what identifies
    the failure. Credentials never appear on this object, in its message, or in anything it holds.

    Attributes:
        operation_id: The operation that was refused, by its contract `operationId`.
        status: The HTTP status.
        error_code: The code to branch on. `None` only when something in front of the API refused
            the request.
        error_id: On an unexpected `500`: the value that identifies that one failure.
        type: The problem `type` URI: an identifier, not a page.
        title: The problem's title.
        detail: The problem's detail.
        errors: For a validation refusal: each field that was refused, and why.
        problem: The whole problem document, when the refusal carried one.
        request_id: `X-Request-Id`: identifies this exact call in ATLAS's own records.
        retry_after: `Retry-After`, in seconds. `None` on a refusal that no wait would clear.
        rate_limit: Your overall request-rate budget as this response reported it, when it did.
        attempts: How many attempts were made before giving up, the first included.
    """

    operation_id: str
    status: int
    error_code: str | None
    error_id: str | None
    type: str | None
    title: str | None
    detail: str | None
    errors: list[Error] | None
    problem: Problem | None
    request_id: str | None
    retry_after: int | None
    rate_limit: RateLimitState | None
    attempts: int

    def __init__(
        self,
        *,
        operation_id: str,
        status: int,
        problem: Problem | None,
        request_id: str | None,
        retry_after: int | None,
        rate_limit: RateLimitState | None,
        attempts: int,
        note: str | None = None,
    ) -> None:
        summary = (
            (problem.get("errorCode") or problem.get("title")) if problem else None
        ) or f"HTTP {status}"
        super().__init__(
            f"{operation_id} was refused: {summary} ({status})"
            + (f". {note}" if note else "")
            + (f" [request {request_id}]" if request_id else "")
        )
        self.operation_id = operation_id
        self.status = status
        self.problem = problem
        self.error_code = problem.get("errorCode") if problem else None
        self.error_id = problem.get("errorId") if problem else None
        self.type = problem.get("type") if problem else None
        self.title = problem.get("title") if problem else None
        self.detail = problem.get("detail") if problem else None
        self.errors = problem.get("errors") if problem else None
        self.request_id = request_id
        self.retry_after = retry_after
        self.rate_limit = rate_limit
        self.attempts = attempts


class AtlasConnectionError(AtlasError):
    """No complete response arrived.

    The connection failed, the attempt timed out, or the answer stopped arriving part-way. (A
    redirect is an `AtlasApiError`: this SDK never follows one, so that your credential is never
    sent to another address.)

    Attributes:
        operation_id: The operation that was being sent.
        attempts: How many attempts were made, the first included.
        may_have_reached_server: True when the request may have reached the API before the failure.
            An operation that is not safe to repeat is never retried in that case, and you should
            find out what happened before sending it again.
    """

    def __init__(
        self, operation_id: str, message: str, attempts: int, may_have_reached_server: bool
    ) -> None:
        super().__init__(f"{operation_id}: {message}")
        self.operation_id = operation_id
        self.attempts = attempts
        self.may_have_reached_server = may_have_reached_server


type WebhookRefusal = Literal[
    "not-raw", "no-secret", "missing-header", "malformed-header", "no-match", "stale", "not-json"
]
"""Why a webhook delivery was refused."""


class WebhookVerificationError(AtlasError):
    """A webhook delivery failed verification. Answer it with a `4xx` and do not act on it.

    Attributes:
        reason: Why it was refused.
    """

    def __init__(self, reason: WebhookRefusal, message: str) -> None:
        super().__init__(message)
        self.reason: WebhookRefusal = reason


class RefreshRefusedError(AtlasError):
    """A delegated pass could not be renewed. The pass in hand works until `still_valid_until`.

    `refusal` says why. A `400` means the refresh token is spent or revoked, and the person must
    consent again once the pass expires. A `429` spent nothing, and renewal is tried again near
    expiry. Anything else may have reached ATLAS, so the pass sets `renewal_outcome_unknown` and the
    SDK never presents that token again on its own - presenting a spent one is treated as theft, and
    revokes every renewal token under the grant.

    Attributes:
        refusal: The refusal itself.
        still_valid_until: When the pass you still hold stops working.
    """

    def __init__(
        self, refusal: AtlasApiError | AtlasConnectionError, still_valid_until: datetime
    ) -> None:
        super().__init__(
            "the delegated pass could not be renewed; the current one works until "
            f"{still_valid_until.isoformat()}"
        )
        self.refusal = refusal
        self.still_valid_until = still_valid_until
