"""Sends one operation over the standard library's HTTP client, retried as its class allows."""

from __future__ import annotations

import contextlib
import http.client
import json
import platform
import random
import re
import ssl
import time
import urllib.error
import urllib.request
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from functools import partial
from typing import Any, Literal, Required, TypedDict, cast
from urllib.parse import quote, urlencode, urlsplit, urlunsplit

from ._errors import AtlasApiError, AtlasConfigurationError, AtlasConnectionError, AtlasError
from ._generated.contract import Problem
from ._generated.surface import OPERATIONS, SERVER_PATH, OperationId
from ._rate_limit import RateLimitState, read_rate_limit, read_retry_after
from ._version import CONTRACT_VERSION, SDK_VERSION


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    """How the SDK retries. Every bound is its own: ATLAS promises no retention window to fit.

    Attributes:
        max_attempts: Attempts in total, the first included. `1` turns retrying off.
        max_retry_after_seconds: The longest `Retry-After` the SDK waits out. A `429` asking for
            longer is raised to you, so that no call can block for an unbounded time.
        base_delay: The first wait, in seconds, after a failure that names no wait, doubled per
            attempt, with jitter.
        max_delay: The longest such wait, in seconds.
    """

    max_attempts: int = 3
    max_retry_after_seconds: int = 60
    base_delay: float = 0.25
    max_delay: float = 5.0


DEFAULT_RETRY = RetryPolicy()
"""The retry policy a client uses unless you give it another."""

type RetryReason = Literal["throttled", "server-error", "connection", "in-flight"]
"""Why an attempt is being repeated."""


@dataclass(frozen=True, slots=True)
class RetryEvent:
    """Passed to `on_retry` before the SDK waits and sends the same request again.

    Attributes:
        operation_id: The operation being retried.
        attempt: The attempt that failed, counting from 1.
        reason: Why it is being repeated.
        delay: How long the SDK will wait before the next attempt, in seconds.
        status: The status of the refusal, when there was one.
        request_id: The refusal's `X-Request-Id`, when there was one.
        retry_after: The `Retry-After` the refusal carried, in seconds.
    """

    operation_id: OperationId
    attempt: int
    reason: RetryReason
    delay: float
    status: int | None = None
    request_id: str | None = None
    retry_after: int | None = None


@dataclass(frozen=True, slots=True)
class ResponseEvent:
    """Passed to `on_response` for every response, success or refusal.

    Attributes:
        operation_id: The operation answered.
        attempt: The attempt answered, counting from 1.
        status: The HTTP status.
        request_id: The response's `X-Request-Id`.
        rate_limit: The request-rate budget the response reported, when it did.
    """

    operation_id: OperationId
    attempt: int
    status: int
    request_id: str | None
    rate_limit: RateLimitState | None


class ClientOptions(TypedDict, total=False):
    """Everything a client needs besides its credential.

    Attributes:
        base_url: The address the ATLAS API is served from, for example
            `https://api.example.test`, without the `/v1` every operation adds. Required: the
            contract names no host, so there is nothing to default to. `https` is required, except
            for a loopback address (`localhost`, `127.0.0.1`, `[::1]`), because a key or a pass sent
            over plain http to anywhere else is sent in the clear.
        timeout: How long, in seconds, one attempt waits on the server. Connecting and each
            wait for the response's head are bounded by it, and a body still arriving after it
            is cut off, however slowly it trickles in. Default `30`.
        retry: Replaces `DEFAULT_RETRY`.
        user_agent: Appended to the SDK's own `User-Agent`, to name your application.
        on_retry: Called before every retry, with what failed and how long the SDK will wait.
        on_response: Called for every response, with its status, `X-Request-Id` and rate-limit
            figures.
        ssl_context: The TLS settings to verify the API's certificate with, for a private
            certificate authority. Default: the system's trusted authorities.
        handlers: Extra `urllib.request` handler instances, such as a `ProxyHandler` with
            explicit proxies. The environment's proxy settings are honoured without one. A
            redirect handler or an HTTPS handler is refused: this SDK never follows a redirect,
            and TLS is set by `ssl_context`. A plain-http loopback `base_url` is never proxied.
    """

    base_url: Required[str]
    timeout: float
    retry: RetryPolicy
    user_agent: str
    on_retry: Callable[[RetryEvent], None]
    on_response: Callable[[ResponseEvent], None]
    ssl_context: ssl.SSLContext
    handlers: Sequence[urllib.request.BaseHandler]


@dataclass(frozen=True, slots=True)
class _Internals:
    """Test seams. Not part of the package's interface."""

    sleep: Callable[[float], None] = time.sleep
    random: Callable[[], float] = random.random
    now: Callable[[], datetime] = field(default=lambda: datetime.now(UTC))
    monotonic: Callable[[], float] = time.monotonic


type QueryValue = str | int | bool | Sequence[str | int | bool] | None


class Call(TypedDict, total=False):
    """One request, before the transport turns it into bytes."""

    path: Mapping[str, str]
    query: Mapping[str, QueryValue]
    body: object
    # Returns the bearer token to send, or is absent for an operation that takes none.
    credential: Callable[[], str]
    idempotency_key: str | None


_LOOPBACK = frozenset({"localhost", "127.0.0.1", "::1"})
_VISIBLE_ASCII = re.compile(r"[\x21-\x7e]*")


def checked_base_url(value: object, label: str) -> str:
    """Validates a caller-supplied address and returns it without a trailing slash.

    Raises:
        AtlasConfigurationError: The address is missing, not absolute, not https off loopback, or
            carries a user name, a query, a fragment or the server path.
    """
    if not isinstance(value, str) or not value.strip():
        raise AtlasConfigurationError(
            f"{label} is required: the ATLAS API contract names no host, so there is nothing to "
            "default to"
        )
    try:
        if not _VISIBLE_ASCII.fullmatch(value):
            raise ValueError(value)
        parts = urlsplit(value)
        host = parts.hostname
        _ = parts.port  # raises on a port that is not a number
    except ValueError:
        raise AtlasConfigurationError(f"{label} is not an absolute URL: {value!r}") from None
    if not parts.scheme or not host:
        raise AtlasConfigurationError(f"{label} is not an absolute URL: {value!r}")
    scheme = parts.scheme.lower()
    if scheme != "https" and not (scheme == "http" and host in _LOOPBACK):
        raise AtlasConfigurationError(
            f"{label} must use https (plain http is accepted only for a loopback address): a "
            "credential sent over plain http to anywhere else is sent in the clear"
        )
    if parts.username is not None or parts.password is not None:
        raise AtlasConfigurationError(f"{label} must not carry a user name or password")
    if parts.query or parts.fragment or "?" in value or "#" in value:
        raise AtlasConfigurationError(f"{label} must not carry a query or a fragment")
    trimmed = urlunsplit((scheme, parts.netloc.lower(), parts.path, "", "")).rstrip("/")
    if label == "base_url" and trimmed.endswith(SERVER_PATH):
        raise AtlasConfigurationError(
            f"base_url ends with {SERVER_PATH}, which every operation adds itself: pass the "
            "address the API is served from"
        )
    return trimmed


# What a request header may carry, per RFC 9110: visible ASCII, space and tab. Checked before a
# request is built, because http.client refuses anything else with an error that quotes the whole
# value - and the value is usually your credential.
_FIELD_VALUE = re.compile(r"[\t\x20-\x7e]*")


def checked_header(value: str, what: str) -> str:
    """Returns a header value, or refuses one a request header cannot carry, without repeating it.

    Raises:
        AtlasConfigurationError: The value holds a line break, a NUL or a non-ASCII character.
    """
    if not isinstance(value, str) or not _FIELD_VALUE.fullmatch(value):
        raise AtlasConfigurationError(
            f"{what} contains a character a request header cannot carry - a line break, a NUL or "
            "a non-ASCII character. It is not repeated here."
        )
    return value


def _mentions(error: BaseException, secret: str) -> bool:
    """Whether an error, or anything it was raised from, carries the secret in its text."""
    seen: BaseException | None = error
    for _ in range(5):
        if seen is None:
            return False
        if secret in str(seen) or secret in repr(seen.args):
            return True
        seen = seen.__cause__ or seen.__context__
    return False


def _safe_cause(error: BaseException, secret: str | None) -> BaseException | None:
    """The error to chain as a cause, or `None` if its text carries the secret.

    Header values are validated before sending, so this should never drop anything; it is here so
    that a platform error nobody anticipated cannot put a credential into a log.
    """
    if secret and _mentions(error, secret):
        return None
    return error


# The most a successful answer may be, and the most of a refusal that is read.
_SUCCESS_LIMIT = 16 * 1024 * 1024
_REFUSAL_LIMIT = 64 * 1024
_CHUNK = 64 * 1024


class _BodyTooLargeError(AtlasError):
    def __init__(self, limit: int) -> None:
        super().__init__(
            f"the response body is larger than {limit} bytes, which is more than this API ever "
            "sends"
        )


class _Response:
    """A response, whichever way urllib handed it over: returned for a 2xx, raised otherwise."""

    def __init__(self, raw: http.client.HTTPResponse | urllib.error.HTTPError) -> None:
        self._raw = raw
        self.status: int = raw.status if isinstance(raw, http.client.HTTPResponse) else raw.code
        self.headers = raw.headers

    def header(self, name: str) -> str | None:
        value = self.headers.get(name)
        return value if isinstance(value, str) else None

    def read_limited(self, limit: int, deadline: float, monotonic: Callable[[], float]) -> bytes:
        """Reads the body, refusing to hold more than `limit` bytes of it."""
        declared = (self.header("content-length") or "").strip()
        if declared.isdigit() and int(declared) > limit:
            self.close()
            raise _BodyTooLargeError(limit)
        # read1 returns whatever has arrived rather than waiting to fill the buffer, so a body that
        # trickles in is cut off at the deadline instead of each byte restarting an idle timeout.
        read: Callable[[int], bytes] = getattr(self._raw, "read1", None) or self._raw.read
        expected = int(declared) if declared.isdigit() else None
        chunks: list[bytes] = []
        size = 0
        while expected is None or size < expected:
            chunk = read(_CHUNK)
            if not chunk:
                break
            size += len(chunk)
            if size > limit:
                self.close()
                raise _BodyTooLargeError(limit)
            chunks.append(chunk)
            # Checked after a read, and never once the declared length is in hand: a response that
            # has fully arrived is kept, however long its head took. Throwing a complete answer
            # away would report a counted `present` as a failure, and invite a retry counted twice.
            if (expected is None or size < expected) and monotonic() > deadline:
                raise TimeoutError("the response body did not arrive within the timeout")
        return b"".join(chunks)

    def close(self) -> None:
        with contextlib.suppress(OSError):  # closing a broken socket
            self._raw.close()


def _is_problem(value: object) -> bool:
    return isinstance(value, dict) and (
        isinstance(value.get("status"), int) or isinstance(value.get("type"), str)
    )


def _read_problem(
    response: _Response, deadline: float, monotonic: Callable[[], float]
) -> tuple[Problem | None, str | None]:
    content_type = response.header("content-type") or ""
    text = b""
    with contextlib.suppress(_BodyTooLargeError):
        text = response.read_limited(_REFUSAL_LIMIT, deadline, monotonic)
    if "json" in content_type.lower():
        try:
            parsed: object = json.loads(text)
        except (ValueError, RecursionError):
            parsed = None  # a refusal that says it is JSON and is not: falls through to the note
        if _is_problem(parsed):
            return cast(Problem, parsed), None
    # Something in front of the API refused the request - the web server refuses a path with an
    # encoded slash or a NUL byte before the API sees it. Its body is never echoed: it is not a
    # problem document, and repeating markup into an error message helps nobody.
    kind = content_type.split(";")[0].strip() or "no content type"
    return None, f"the refusal carried no problem document ({kind})"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follows a redirect: it would carry the Authorization header to another address."""

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: object,
        code: int,
        msg: str,
        headers: object,
        newurl: str,
    ) -> None:
        return None


_REDIRECTS = (301, 302, 303, 307, 308)


def _opener(
    ssl_context: ssl.SSLContext | None,
    handlers: Sequence[urllib.request.BaseHandler],
    plain_http: bool,
) -> urllib.request.OpenerDirector:
    for handler in handlers:
        if isinstance(handler, type):
            # build_opener would instantiate a class, past every check below.
            raise AtlasConfigurationError(
                "handlers takes handler instances, not classes: pass Handler(), not Handler"
            )
        if isinstance(handler, urllib.request.HTTPRedirectHandler) or any(
            hasattr(handler, name)
            for name in ("redirect_request", *(f"http_error_{code}" for code in _REDIRECTS))
        ):
            raise AtlasConfigurationError(
                "handlers must not include a redirect handler: this SDK never follows a redirect, "
                "so that your credential is only sent to the address you configured"
            )
        if isinstance(handler, urllib.request.HTTPSHandler):
            raise AtlasConfigurationError(
                "handlers must not include an HTTPS handler: pass ssl_context to change how the "
                "API's certificate is verified"
            )
        if plain_http and isinstance(handler, urllib.request.ProxyHandler):
            raise AtlasConfigurationError(
                "a proxy cannot be used with a plain-http base_url: plain http is accepted only "
                "because a loopback address never leaves this machine, and a proxy would carry "
                "your credential off it in the clear"
            )
    own: list[urllib.request.BaseHandler] = [
        urllib.request.HTTPSHandler(context=ssl_context or ssl.create_default_context()),
        _NoRedirect(),
    ]
    if plain_http:
        # Never proxied, whatever HTTP_PROXY says: the same reason as above.
        own.append(urllib.request.ProxyHandler({}))
    elif not any(isinstance(handler, urllib.request.ProxyHandler) for handler in handlers):
        # The proxy the environment names (HTTPS_PROXY, NO_PROXY, or the system's settings).
        # https goes through a proxy as CONNECT, so the proxy never sees a header.
        own.append(urllib.request.ProxyHandler())
    opener = urllib.request.build_opener(*own, *handlers)
    opener.addheaders = []  # no default User-Agent: the SDK sends its own
    # And prove it: the only thing that may answer a redirect is the handler that refuses it.
    answering = opener.handle_error.get("http", {})  # type: ignore[attr-defined]
    for code in _REDIRECTS:
        if not all(isinstance(each, _NoRedirect) for each in answering.get(code, [])):
            raise AtlasConfigurationError(
                f"a handler answers HTTP {code}, and this SDK never follows a redirect"
            )
    return opener


def _query_text(value: str | int | bool) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


class Transport:
    """Sends one operation, applying the retry class the contract gives it.

    - `repeatable` (an idempotent method) and `repeatable-with-key` (the operation declares
      `Idempotency-Key`, and every attempt carries the same one) are retried after a `5xx` or a
      connection that failed;
    - `once` is never retried after a failure that may have reached the API: `present` meters
      every call, and a replayed refresh token is treated as theft;
    - every class waits out a `429`'s `Retry-After`, because a throttled request did nothing.
    """

    def __init__(self, options: ClientOptions, internals: _Internals | None = None) -> None:
        self._base = checked_base_url(options.get("base_url"), "base_url")
        self._timeout = float(options.get("timeout", 30.0))
        if not self._timeout > 0:
            raise AtlasConfigurationError("timeout must be a positive number of seconds")
        self._retry = options.get("retry", DEFAULT_RETRY)
        if (
            not isinstance(self._retry.max_attempts, int)
            or isinstance(self._retry.max_attempts, bool)
            or self._retry.max_attempts < 1
        ):
            raise AtlasConfigurationError("retry.max_attempts must be a whole number of at least 1")
        extra = options.get("user_agent")
        self._user_agent = checked_header(
            f"atlas-sdk-python/{SDK_VERSION} (contract {CONTRACT_VERSION}; "
            f"python {platform.python_version()})" + (f" {extra}" if extra else ""),
            "user_agent",
        )
        self._on_retry = options.get("on_retry")
        self._on_response = options.get("on_response")
        self._opener = _opener(
            options.get("ssl_context"),
            options.get("handlers", ()),
            plain_http=self._base.startswith("http://"),
        )
        self._internals = internals or _Internals()
        self._rate_limit: RateLimitState | None = None

    @property
    def rate_limit(self) -> RateLimitState | None:
        """Your request-rate budget as the most recent response reported it, or `None`."""
        return self._rate_limit

    def url(
        self,
        operation_id: OperationId,
        path: Mapping[str, str] | None = None,
        query: Mapping[str, QueryValue] | None = None,
    ) -> str:
        """The address an operation is sent to, with the contract's server path."""
        operation = OPERATIONS[operation_id]
        values = path or {}

        def fill(match: re.Match[str]) -> str:
            name = match.group(1)
            value = values.get(name)
            if not isinstance(value, str) or value == "":
                raise AtlasConfigurationError(f"{operation_id} needs a non-empty {name}")
            # quote() leaves "." alone, and a URL resolves "." and ".." as path steps: an id of
            # ".." would send this call, with its credential, to a different route.
            if value in {".", ".."}:
                raise AtlasConfigurationError(f'{operation_id}: {name} cannot be "{value}"')
            return quote(value, safe="")

        filled = re.sub(r"\{([^}]+)\}", fill, operation.path)
        pairs: list[tuple[str, str]] = []
        for name, value in (query or {}).items():
            if value is None:
                continue
            many = [value] if isinstance(value, (str, int, bool)) else list(value)
            pairs.extend((name, _query_text(one)) for one in many)
        search = urlencode(pairs, quote_via=quote)
        return f"{self._base}{SERVER_PATH}{filled}" + (f"?{search}" if search else "")

    def call(self, operation_id: OperationId, call: Call | None = None) -> Any:
        """Sends an operation and returns its parsed JSON body.

        Raises:
            AtlasApiError: The API refused it.
            AtlasConnectionError: No complete response arrived.
            AtlasConfigurationError: The request could not be built.
        """
        call = call or {}
        operation = OPERATIONS[operation_id]
        url = self.url(operation_id, call.get("path"), call.get("query"))
        payload: bytes | None = None
        if "body" in call:
            try:
                payload = json.dumps(
                    call["body"], ensure_ascii=False, separators=(",", ":"), allow_nan=False
                ).encode("utf-8")
            except (TypeError, ValueError) as error:
                raise AtlasConfigurationError(
                    f"{operation_id}: the body is not JSON-serialisable ({type(error).__name__})"
                ) from None
        # One key per logical call, generated once and sent on every attempt: that is what lets the
        # API recognise a retry as the same request and answer it with the first outcome.
        supplied = call.get("idempotency_key")
        idempotency_key = (
            checked_header(
                supplied if supplied is not None else str(uuid.uuid4()), "idempotency_key"
            )
            if operation.idempotency_key
            else None
        )
        own_key = operation.idempotency_key and supplied is None
        get_credential = call.get("credential")

        attempt = 0
        while True:
            attempt += 1
            headers = {
                "Accept": "application/json, application/problem+json",
                "User-Agent": self._user_agent,
            }
            if payload is not None:
                headers["Content-Type"] = "application/json"
            if idempotency_key is not None:
                headers["Idempotency-Key"] = idempotency_key
            credential = (
                checked_header(get_credential(), "the credential") if get_credential else None
            )
            if credential is not None:
                headers["Authorization"] = f"Bearer {credential}"

            request = urllib.request.Request(  # noqa: S310 - the scheme is checked: https or loopback http
                url, data=payload, headers=headers, method=operation.method
            )
            deadline = self._internals.monotonic() + self._timeout
            failure: BaseException | None = None
            response: _Response | None = None
            try:
                response = _Response(self._opener.open(request, timeout=self._timeout))
            except urllib.error.HTTPError as refusal:
                response = _Response(refusal)
            except (OSError, http.client.HTTPException) as error:
                failure = error

            if failure is not None or response is None:
                if operation.retry != "once" and attempt < self._retry.max_attempts:
                    self._wait(operation_id, attempt, "connection", self._backoff(attempt))
                    continue
                timed_out = isinstance(failure, TimeoutError) or isinstance(
                    getattr(failure, "reason", None), TimeoutError
                )
                raise AtlasConnectionError(
                    operation_id,
                    f"no response within {self._timeout:g} s"
                    if timed_out
                    else "the connection failed before a response arrived",
                    attempt,
                    True,
                ) from (_safe_cause(failure, credential) if failure else None)

            now = self._internals.now()
            request_id = response.header("x-request-id")
            rate_limit = read_rate_limit(response.header, now)
            if rate_limit is not None:
                self._rate_limit = rate_limit
            if self._on_response is not None:
                self._on_response(
                    ResponseEvent(operation_id, attempt, response.status, request_id, rate_limit)
                )

            if 200 <= response.status < 300:
                try:
                    body = self._reading(
                        operation_id,
                        attempt,
                        credential,
                        partial(
                            response.read_limited,
                            _SUCCESS_LIMIT,
                            deadline,
                            self._internals.monotonic,
                        ),
                    )
                except _BodyTooLargeError as error:
                    raise AtlasError(f"{operation_id}: {error}") from None
                finally:
                    response.close()
                return self._parse(operation_id, response.status, body)

            if 300 <= response.status < 400:
                response.close()
                raise AtlasApiError(
                    operation_id=operation_id,
                    status=response.status,
                    problem=None,
                    request_id=request_id,
                    retry_after=None,
                    rate_limit=rate_limit,
                    attempts=attempt,
                    note="the API answered with a redirect, which this SDK never follows, so that "
                    "your credential is only sent to the address you configured",
                )

            try:
                problem, note = self._reading(
                    operation_id,
                    attempt,
                    credential,
                    partial(_read_problem, response, deadline, self._internals.monotonic),
                )
            finally:
                response.close()
            retry_after = read_retry_after(response.header, now)
            step = self._next_attempt(
                operation.retry, response.status, problem, retry_after, attempt, own_key
            )
            if step is not None:
                reason, delay = step
                self._wait(
                    operation_id,
                    attempt,
                    reason,
                    delay,
                    status=response.status,
                    request_id=request_id,
                    retry_after=retry_after,
                )
                continue
            raise AtlasApiError(
                operation_id=operation_id,
                status=response.status,
                problem=problem,
                request_id=request_id,
                retry_after=retry_after,
                rate_limit=rate_limit,
                attempts=attempt,
                note=note,
            )

    def _next_attempt(
        self,
        retry: Literal["repeatable", "repeatable-with-key", "once"],
        status: int,
        problem: Problem | None,
        retry_after: int | None,
        attempt: int,
        own_key: bool,
    ) -> tuple[RetryReason, float] | None:
        if attempt >= self._retry.max_attempts:
            return None
        if status == 429:
            # No Retry-After means the refusal does not clear with time (an exhausted credit
            # allowance), and one longer than the bound is yours to decide about.
            if retry_after is None or retry_after > self._retry.max_retry_after_seconds:
                return None
            return "throttled", retry_after + self._internals.random() * 0.25
        if (
            status == 409
            and retry == "repeatable-with-key"
            and own_key
            and attempt > 1
            and problem is not None
            and problem.get("errorCode") == "ATLAS-DEV-010"
        ):
            # The code means "another request used this key" or "the first call is still in
            # flight". With a key the SDK generated for this one call, and a body identical byte for
            # byte, only the second is possible - so it waits, and the next attempt is answered with
            # the outcome. A key you supplied may have been used for something else, so that 409 is
            # raised to you.
            return "in-flight", self._backoff(attempt)
        if status >= 500 and retry != "once":
            return "server-error", self._backoff(attempt)
        return None

    def _backoff(self, attempt: int) -> float:
        ceiling = min(self._retry.max_delay, self._retry.base_delay * 2.0 ** (attempt - 1))
        return ceiling / 2 + self._internals.random() * ceiling / 2

    def _wait(
        self,
        operation_id: OperationId,
        attempt: int,
        reason: RetryReason,
        delay: float,
        *,
        status: int | None = None,
        request_id: str | None = None,
        retry_after: int | None = None,
    ) -> None:
        if self._on_retry is not None:
            self._on_retry(
                RetryEvent(operation_id, attempt, reason, delay, status, request_id, retry_after)
            )
        self._internals.sleep(delay)

    def _reading[R](
        self,
        operation_id: OperationId,
        attempt: int,
        credential: str | None,
        read: Callable[[], R],
    ) -> R:
        """Reads a body, turning a timeout or a dropped connection into `AtlasConnectionError`.

        The API has already acted by then, so `may_have_reached_server` is true.
        """
        failure: BaseException | None = None
        try:
            return read()
        except AtlasError:
            raise
        except (OSError, http.client.HTTPException, ValueError) as error:
            failure = error
        raise AtlasConnectionError(
            operation_id, "the response did not finish arriving", attempt, True
        ) from _safe_cause(failure, credential)

    def _parse(self, operation_id: OperationId, status: int, body: bytes) -> object:
        if body == b"":
            return None
        try:
            return cast(object, json.loads(body))
        except (ValueError, RecursionError):
            raise AtlasError(
                f"{operation_id}: the API answered {status} with a body that is not JSON"
            ) from None
