"""Acting as a person who consented: PKCE, the consent address, the token leg, and renewal."""

from __future__ import annotations

import base64
import hashlib
import re
import secrets
import threading
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta
from typing import Literal, TypedDict, Unpack, cast
from urllib.parse import quote

from ._errors import (
    AtlasApiError,
    AtlasConfigurationError,
    AtlasConnectionError,
    AtlasError,
    RefreshRefusedError,
)
from ._generated.contract import DelegatedPassResponse, TokenExchangeRequest
from ._transport import ClientOptions, Transport, _Internals, checked_base_url


@dataclass(frozen=True, slots=True)
class PkcePair:
    """A PKCE pair: keep `verifier` on your server; send `challenge` to the consent page.

    Attributes:
        verifier: The secret half, sent only to the token exchange.
        challenge: The S256 challenge the consent address carries.
        method: S256 is the only method ATLAS accepts.
    """

    verifier: str = field(repr=False)  # the secret half: never in a log line
    challenge: str
    method: Literal["S256"] = "S256"


_VERIFIER = re.compile(r"[A-Za-z0-9\-._~]{43,128}")


def pkce_challenge(verifier: str) -> str:
    """The S256 challenge for a verifier: base64url of its SHA-256, without padding (RFC 7636).

    Raises:
        AtlasConfigurationError: The verifier is outside RFC 7636 section 4.1.

    Example:
        >>> pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    """
    if not isinstance(verifier, str) or not _VERIFIER.fullmatch(verifier):
        raise AtlasConfigurationError(
            'a PKCE verifier is 43 to 128 characters drawn from A-Z, a-z, 0-9, "-", ".", "_" '
            'and "~"'
        )
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def create_pkce_pair() -> PkcePair:
    """A fresh PKCE pair, with a verifier of 32 random bytes.

    Example:
        ```python
        pkce = create_pkce_pair()
        # store pkce.verifier with the sign-in attempt; put pkce.challenge in the consent address
        ```
    """
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode("ascii")
    return PkcePair(verifier=verifier, challenge=pkce_challenge(verifier))


def authorization_url(
    *,
    web_base_url: str,
    client_id: str,
    org_id: str,
    redirect_uri: str,
    scopes: Sequence[str],
    state: str,
    code_challenge: str,
) -> str:
    """The address to send a person to, to consent to your application acting as them.

    Args:
        web_base_url: The ATLAS web address you were given, where people sign in. It is not the
            API's address: the two are served from different hosts, which is why the contract
            names neither.
        client_id: Your application's client id.
        org_id: The organisation whose content the pass will read.
        redirect_uri: Where ATLAS sends the person back, exactly as you registered it: it is
            matched character for character.
        scopes: The permissions to ask for, such as `content:read`.
        state: A value you generate per attempt and check when the person returns.
        code_challenge: From `create_pkce_pair()`.

    Raises:
        AtlasConfigurationError: A parameter is missing, or the web address is not https.

    Example:
        ```python
        import secrets
        pkce = create_pkce_pair()
        state = secrets.token_urlsafe(16)
        url = authorization_url(
            web_base_url=os.environ["ATLAS_WEB_URL"], client_id=client_id, org_id=org_id,
            redirect_uri="https://app.example.test/atlas/callback",
            scopes=["content:read"], state=state, code_challenge=pkce.challenge,
        )
        ```
    """
    base = checked_base_url(web_base_url, "web_base_url")
    if isinstance(scopes, str):
        raise AtlasConfigurationError("scopes is a list of permissions, not one string")
    parameters = [
        ("client_id", client_id),
        ("org_id", org_id),
        ("redirect_uri", redirect_uri),
        ("scope", " ".join(scopes)),
        ("state", state),
        ("code_challenge", code_challenge),
        ("code_challenge_method", "S256"),
    ]
    for name, value in parameters:
        if not isinstance(value, str) or value == "":
            raise AtlasConfigurationError(f"{name} is required")
    query = "&".join(f"{name}={quote(value, safe='')}" for name, value in parameters)
    return f"{base}/oauth/authorize?{query}"


class DelegatedPassSnapshot(TypedDict):
    """A pass as you would store it between processes. Treat it like a password: it can be renewed.

    Attributes:
        access_token: The token sent as `Authorization: Bearer`.
        refresh_token: The renewal token, or `None` once the exchange has refused it.
        expires_at: When the access token stops working, ISO 8601.
        scope: The permissions granted, space-separated.
    """

    access_token: str
    refresh_token: str | None
    expires_at: str
    scope: str


type OnRenewed = Callable[[DelegatedPassSnapshot], None]
"""Receives every renewed pass, before its new token is used."""

# How close to expiry a pass is renewed before use.
_RENEW_MARGIN = timedelta(seconds=30)


class _Renewal:
    """One renewal in flight, and its outcome, shared by every caller that asked for it."""

    def __init__(self) -> None:
        self.done = threading.Event()
        self.error: BaseException | None = None


@dataclass(frozen=True, slots=True)
class _Held:
    """Everything a pass holds, replaced whole, so no reader ever sees half of a renewal."""

    access_token: str
    refresh_token: str | None
    expires_at: datetime
    scope: str
    outcome_unknown: bool = False


class DelegatedPass:
    """A delegated pass and its renewal: the access token you send, and the one that replaces it.

    Renewal follows the rules the token exchange sets. A refresh token works once, and presenting a
    spent one is treated as theft, revoking every renewal token under the grant. So:

    - two renewals never run at once in one process, and one grant belongs to one process: two
      processes renewing the same stored pass will present a spent token;
    - a renewal is never repeated automatically after a failure that may have reached ATLAS (a
      `5xx`, a redirect, a lost connection, an answer that could not be read) - see
      `renewal_outcome_unknown`;
    - a refused renewal (`400`) drops the refresh token, and leaves the pass in use until it
      expires;
    - a throttled renewal (`429`) spent nothing, and keeps the refresh token.

    A pass is safe to share between threads: they share one renewal, and a snapshot never pairs a
    new access token with a spent refresh token.
    """

    def __init__(
        self,
        snapshot: DelegatedPassSnapshot,
        *,
        client_id: str,
        on_renewed: OnRenewed | None = None,
        _internals: _Internals | None = None,
        **options: Unpack[ClientOptions],
    ) -> None:
        """Holds a pass. Use `exchange_code`, `from_response` or `restore` rather than this."""
        if not isinstance(client_id, str) or client_id == "":
            raise AtlasConfigurationError("client_id is required")
        self._internals = _internals or _Internals()
        self._held = _Held(
            access_token=snapshot["access_token"],
            refresh_token=snapshot["refresh_token"],
            expires_at=datetime.fromisoformat(snapshot["expires_at"]),
            scope=snapshot["scope"],
        )
        self._client_id = client_id
        self._on_renewed = on_renewed
        self._transport = Transport(options, self._internals)
        self._lock = threading.Lock()
        self._renewal: _Renewal | None = None

    @classmethod
    def from_response(
        cls,
        response: DelegatedPassResponse,
        *,
        client_id: str,
        on_renewed: OnRenewed | None = None,
        _internals: _Internals | None = None,
        **options: Unpack[ClientOptions],
    ) -> DelegatedPass:
        """A pass from the token exchange's answer, as `exchange_code` returns it."""
        internals = _internals or _Internals()
        return cls(
            _snapshot_of(response, internals.now()),
            client_id=client_id,
            on_renewed=on_renewed,
            _internals=internals,
            **options,
        )

    @classmethod
    def restore(
        cls,
        snapshot: DelegatedPassSnapshot,
        *,
        client_id: str,
        on_renewed: OnRenewed | None = None,
        _internals: _Internals | None = None,
        **options: Unpack[ClientOptions],
    ) -> DelegatedPass:
        """A pass you stored with `snapshot()`.

        Raises:
            AtlasConfigurationError: The snapshot has no access token or no readable expiry.
        """
        try:
            valid = isinstance(snapshot["access_token"], str) and (
                datetime.fromisoformat(snapshot["expires_at"]).tzinfo is not None
            )
        except (KeyError, TypeError, ValueError):
            valid = False
        if not valid:
            raise AtlasConfigurationError(
                "a pass snapshot needs an access_token and an ISO expires_at with a time zone"
            )
        return cls(
            snapshot, client_id=client_id, on_renewed=on_renewed, _internals=_internals, **options
        )

    @property
    def access_token(self) -> str:
        """The token to send as `Authorization: Bearer`."""
        return self._held.access_token

    @property
    def expires_at(self) -> datetime:
        """When the access token stops working."""
        return self._held.expires_at

    @property
    def scope(self) -> str:
        """The permissions the person granted, space-separated, exactly as they consented."""
        return self._held.scope

    @property
    def renewable(self) -> bool:
        """Whether a renewal token is still held. It is dropped once the exchange refuses it."""
        return self._held.refresh_token is not None

    @property
    def renewal_outcome_unknown(self) -> bool:
        """True after a renewal failed in a way that may have reached ATLAS.

        That is a `5xx`, a redirect, a lost connection, or an answer that could not be read. The
        renewal may have landed, in which case the refresh token still held is spent and presenting
        it again revokes the grant. While this is true the pass is never renewed automatically;
        calling `refresh()` yourself is the decision to try that token again.
        """
        return self._held.outcome_unknown

    def is_expired(self) -> bool:
        """Whether the access token has stopped working."""
        return self._internals.now() >= self._held.expires_at

    def snapshot(self) -> DelegatedPassSnapshot:
        """Everything needed to `restore` this pass later. Store it like a password."""
        return _snapshot_from(self._held)

    def refresh(self) -> None:
        """Renews the pass now. Concurrent calls share one renewal: a refresh token works once.

        Every failure raises `RefreshRefusedError` and leaves the current pass in use until it
        expires. A refusal (`400`) also drops the refresh token, so it is never presented again. A
        throttled renewal (`429`) keeps it: nothing was spent. Any other failure may have reached
        ATLAS, so it keeps the token and sets `renewal_outcome_unknown`, and only another call to
        `refresh()` - yours, never the SDK's - presents it again.

        Raises:
            RefreshRefusedError: The renewal failed; the pass in hand still works until it expires.
            AtlasError: The pass holds no refresh token.

        Example:
            ```python
            try:
                delegated_pass.refresh()
            except RefreshRefusedError as error:
                schedule_reconsent(error.still_valid_until)
            ```
        """
        self._refresh(seen=None)

    def _refresh(self, seen: _Held | None) -> None:
        """Runs one renewal, or joins the one in flight.

        `seen` is the state an automatic renewal decided on. It renews only if that is still the
        state under the lock: if another thread renewed meanwhile, or a renewal failed in a way that
        makes the next one the caller's decision, it does nothing.
        """
        with self._lock:
            renewal = self._renewal
            owner = renewal is None
            if renewal is None:
                held = self._held
                if seen is not None and (
                    held is not seen or held.outcome_unknown or held.refresh_token is None
                ):
                    return
                renewal = self._renewal = _Renewal()
        if not owner:
            renewal.done.wait()
            if renewal.error is not None:
                raise renewal.error
            return
        try:
            self._renew()
        except BaseException as error:
            renewal.error = error
            raise
        finally:
            with self._lock:
                self._renewal = None
            renewal.done.set()

    def _renew(self) -> None:
        held = self._held
        if held.refresh_token is None:
            raise AtlasError(
                f"this pass cannot be renewed; it works until {held.expires_at.isoformat()}, and "
                "then the person must consent again"
            )
        body: TokenExchangeRequest = {
            "grantType": "refresh_token",
            "refreshToken": held.refresh_token,
            "clientId": self._client_id,
        }
        failure: AtlasApiError | AtlasConnectionError | None = None
        renewed: _Held | None = None
        try:
            response = cast(
                DelegatedPassResponse,
                self._transport.call("exchangeDelegatedToken", {"body": body}),
            )
            answer = _snapshot_of(response, self._internals.now())
            renewed = _Held(
                access_token=answer["access_token"],
                refresh_token=answer["refresh_token"],
                expires_at=datetime.fromisoformat(answer["expires_at"]),
                scope=answer["scope"],
            )
        except AtlasApiError as error:
            if error.status == 400:
                # The exchange's one refusal: the token is spent, revoked or unknown. Never again.
                self._held = replace(held, refresh_token=None, outcome_unknown=False)
            elif error.status >= 500 or error.status < 400:
                self._held = replace(held, outcome_unknown=True)
            # Any other 4xx, a 429 among them, was refused before the token was looked at.
            failure = error
        except AtlasConnectionError as error:
            if error.may_have_reached_server:
                self._held = replace(held, outcome_unknown=True)
            failure = error
        except Exception as error:
            # A 2xx the SDK could not read - not JSON, too large, missing a field. ATLAS answered,
            # so it may well have rotated the token: whether it did is unknown. Nothing from the
            # answer is repeated, because the answer may hold the new tokens.
            self._held = replace(held, outcome_unknown=True)
            failure = AtlasConnectionError(
                "exchangeDelegatedToken",
                f"the renewal's answer could not be read ({type(error).__name__}), so whether it "
                "rotated the refresh token is unknown",
                getattr(error, "attempts", 1),
                True,
            )
            # Kept as the cause: it is the SDK's own parse error, or one your on_response or
            # on_retry raised. Neither carries the answer's body.
            failure.__cause__ = error
        if failure is not None or renewed is None:
            assert failure is not None
            raise RefreshRefusedError(failure, held.expires_at) from failure
        try:
            # Handed over before any thread can use the new token: while this runs, the pass still
            # holds the old one, and a thread that needs a renewal joins this one.
            if self._on_renewed is not None:
                self._on_renewed(_snapshot_from(renewed))
        finally:
            self._held = renewed

    def current_access_token(self) -> str:
        """The access token to send now.

        It is renewed first when it is within 30 seconds of expiry, unless an earlier renewal's
        outcome is unknown. If the renewal fails while the pass still works, the pass is used as
        it is.
        """
        held = self._held
        near_expiry = self._internals.now() + _RENEW_MARGIN >= held.expires_at
        if near_expiry and held.refresh_token is not None and not held.outcome_unknown:
            try:
                self._refresh(seen=held)
            except AtlasError:
                # A renewal this call joined may have failed, or found nothing left to renew with.
                if self.is_expired():
                    raise
        return self._held.access_token


def _snapshot_from(held: _Held) -> DelegatedPassSnapshot:
    return {
        "access_token": held.access_token,
        "refresh_token": held.refresh_token,
        "expires_at": held.expires_at.isoformat(),
        "scope": held.scope,
    }


def _snapshot_of(response: DelegatedPassResponse, now: datetime) -> DelegatedPassSnapshot:
    return {
        "access_token": response["access_token"],
        "refresh_token": response["refresh_token"],
        "expires_at": (now + timedelta(seconds=response["expires_in"])).isoformat(),
        "scope": response["scope"],
    }


def exchange_code(
    *,
    client_id: str,
    code: str,
    redirect_uri: str,
    code_verifier: str,
    on_renewed: OnRenewed | None = None,
    _internals: _Internals | None = None,
    **options: Unpack[ClientOptions],
) -> DelegatedPass:
    """Swaps the one-time `code` from the consent page for a pass.

    Run it on your server: it sends the PKCE verifier, and it answers with a refresh token. The
    request is camelCase and the answer snake_case, on purpose - see `TokenExchangeRequest` and
    `DelegatedPassResponse`. It is sent once and never retried after a failure that may have
    reached the API: a code works once.

    Args:
        client_id: Your application's client id: every renewal names it.
        code: The one-time `code` ATLAS sent back. It expires about a minute after consent.
        redirect_uri: The same `redirect_uri` the consent address named.
        code_verifier: The verifier whose challenge the consent address carried.
        on_renewed: Called with the renewed pass after every renewal, before the new token is
            used. Store the snapshot here if you store passes at all: a renewal spends the refresh
            token you stored before, and presenting a spent one - after a restart, or from a second
            process - is treated as theft and revokes the grant. If it raises, the error reaches
            you, and the pass in memory still holds the renewed tokens.
        **options: Everything else, as `ClientOptions` describes it. `base_url` is required.

    Example:
        ```python
        delegated_pass = exchange_code(
            base_url=os.environ["ATLAS_BASE_URL"], client_id=client_id,
            code=request.args["code"], redirect_uri=redirect_uri, code_verifier=stored_verifier,
        )
        as_learner = PassClient(
            base_url=os.environ["ATLAS_BASE_URL"], org_id=org_id, delegated_pass=delegated_pass
        )
        ```
    """
    for name, value in (
        ("client_id", client_id),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("code_verifier", code_verifier),
    ):
        if not isinstance(value, str) or value == "":
            raise AtlasConfigurationError(f"{name} is required")
    body: TokenExchangeRequest = {
        "grantType": "authorization_code",
        "code": code,
        "redirectUri": redirect_uri,
        "codeVerifier": code_verifier,
        "clientId": client_id,
    }
    internals = _internals or _Internals()
    response = cast(
        DelegatedPassResponse,
        Transport(options, internals).call("exchangeDelegatedToken", {"body": body}),
    )
    return DelegatedPass.from_response(
        response, client_id=client_id, on_renewed=on_renewed, _internals=internals, **options
    )
