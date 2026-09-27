"""The two clients: one for an API key, one for a delegated pass."""

from __future__ import annotations

import threading
from collections.abc import Sequence
from typing import TYPE_CHECKING, Literal, Unpack, cast

from ._errors import AtlasConfigurationError
from ._generated.contract import (
    DeveloperUsageResponse,
    EndUserPage,
    EndUserResponse,
    KeyIdentityResponse,
    LinkEndUserRequest,
    PersonalisationProfile,
    PresentEndUserRequest,
    ResourceDownloadResponse,
    ResourceListResponse,
    ResourceResponse,
)
from ._rate_limit import RateLimitState
from ._transport import ClientOptions, Transport, _Internals
from ._version import VERSIONS, Versions

if TYPE_CHECKING:
    from ._delegated import DelegatedPass

type ResourceStatus = Literal[
    "AWAITING_UPLOAD", "SCANNING", "READING", "BUILDING", "READY", "FAILED"
]
"""A lecture's processing state, as `list_resources` filters on it."""


def _required(value: object, name: str) -> str:
    if not isinstance(value, str) or value == "":
        raise AtlasConfigurationError(f"{name} is required")
    return value


class KeyClient:
    """Calls the ATLAS API with an API key.

    It has exactly the operations a key can reach, so an operation your credential could never
    call is an attribute error - and a type error under a type checker - rather than a `403`.

    Example:
        ```python
        import os
        from devatlasframework.sdk import KeyClient

        atlas = KeyClient(
            base_url=os.environ["ATLAS_BASE_URL"],  # the API address you were given
            api_key=os.environ["ATLAS_API_KEY"],
        )
        key = atlas.describe_key()
        print(key["orgId"], key["scopes"])
        ```
    """

    versions: Versions = VERSIONS
    """This SDK's version and the contract it was generated from."""

    def __init__(
        self,
        *,
        api_key: str,
        org_id: str | None = None,
        _internals: _Internals | None = None,
        **options: Unpack[ClientOptions],
    ) -> None:
        """Builds a client that authenticates with an API key.

        Args:
            api_key: Your API key (`atl_sk_live_...`). It is a server-side secret: never put it in
                code that runs on someone else's machine.
            org_id: The organisation your key belongs to. Optional: when you leave it out, the
                first call that needs it asks `describe_key` once and remembers the answer.
            **options: Everything else, as `ClientOptions` describes it. `base_url` is required.
        """
        self._api_key = _required(api_key, "api_key")
        self._org_id = org_id
        self._org_lock = threading.Lock()
        self._transport = Transport(options, _internals)

    @property
    def rate_limit(self) -> RateLimitState | None:
        """Your request-rate budget as the most recent response reported it, or `None`.

        Diagnose a refusal from the error's `retry_after` and `error_code`, never from this: a
        narrower per-operation limit can refuse you while it reads healthy.
        """
        return self._transport.rate_limit

    def describe_key(self) -> KeyIdentityResponse:
        """What this key is: its organisation, its application and the permissions it carries.

        Needs no permission, so a key can always ask what it is before it is told what it lacks.

        Example:
            ```python
            key = atlas.describe_key()
            print(key["orgId"], key["appId"], key["scopes"], key.get("expiresAt"))
            ```
        """
        return cast(
            KeyIdentityResponse,
            self._transport.call("describeKey", {"credential": self._credential}),
        )

    def list_end_users(self) -> EndUserPage:
        """Every learner of yours linked to the application this key belongs to.

        Needs `end-users:manage`.

        Example:
            ```python
            active = [one for one in atlas.list_end_users()["items"] if one["active"]]
            ```
        """
        return cast(
            EndUserPage,
            self._transport.call(
                "listEndUsers", {"path": {"orgId": self._org()}, "credential": self._credential}
            ),
        )

    def link_end_user(
        self, body: LinkEndUserRequest, *, idempotency_key: str | None = None
    ) -> EndUserResponse:
        """Links one of your own learners, named by your reference for them.

        Linking one already linked returns the existing link. Needs `end-users:manage`. Retried
        safely: every attempt carries the same `Idempotency-Key`, so a retry after a lost response
        acts once.

        Args:
            body: Your reference for the learner, as `{"ref": ...}`.
            idempotency_key: The repeat guard, 8-255 characters. The SDK generates one per call
                when you do not, and sends the same one on every attempt. Pass your own to make a
                retry that crosses a process restart act once too - and never reuse one for a
                different request.

        Example:
            ```python
            end_user = atlas.link_end_user({"ref": "learner-4821"})
            ```
        """
        return cast(
            EndUserResponse,
            self._transport.call(
                "linkEndUser",
                {
                    "path": {"orgId": self._org()},
                    "body": body,
                    "credential": self._credential,
                    "idempotency_key": idempotency_key,
                },
            ),
        )

    def revoke_end_user(self, end_user_id: str) -> EndUserResponse:
        """Unlinks a learner. Needs `end-users:manage`.

        Retried after a lost response, safely: revoking a link that is already revoked answers with
        that link, because it is the state you asked for.

        Example:
            ```python
            atlas.revoke_end_user(end_user["id"])
            ```
        """
        return cast(
            EndUserResponse,
            self._transport.call(
                "revokeEndUser",
                {
                    "path": {
                        "orgId": self._org(),
                        "endUserId": _required(end_user_id, "end_user_id"),
                    },
                    "credential": self._credential,
                },
            ),
        )

    def present_for_end_user(
        self, end_user_id: str, body: PresentEndUserRequest
    ) -> PersonalisationProfile:
        """How to present content to one of your learners, computed from the profile you send.

        It answers with their endorsed preferences, the features to offer and the presentation to
        apply. Needs `ai:use`.

        It is sent once and never retried after a failure that may have reached the API, because
        every call is counted in your usage and a retry would count twice. A `429` is still retried
        after its `Retry-After`, because a throttled call is not counted.

        Example:
            ```python
            plan = atlas.present_for_end_user(end_user["id"], {"profile": profile})
            for endorsement in plan["endorsements"]:
                print(endorsement["key"], endorsement["strength"])
            ```
        """
        return cast(
            PersonalisationProfile,
            self._transport.call(
                "presentForEndUser",
                {
                    "path": {
                        "orgId": self._org(),
                        "endUserId": _required(end_user_id, "end_user_id"),
                    },
                    "body": body,
                    "credential": self._credential,
                },
            ),
        )

    def developer_usage(self) -> DeveloperUsageResponse:
        """How much your applications have used this period, and where you stand.

        Needs `usage:read`.

        Example:
            ```python
            usage = atlas.developer_usage()
            print(usage["calls"], usage["state"])
            ```
        """
        return cast(
            DeveloperUsageResponse,
            self._transport.call(
                "developerUsage", {"path": {"orgId": self._org()}, "credential": self._credential}
            ),
        )

    def list_resources(
        self,
        *,
        status: Sequence[ResourceStatus] | None = None,
        q: str | None = None,
        page: int | None = None,
        size: int | None = None,
    ) -> ResourceListResponse:
        """Your organisation's lectures, a page at a time. Needs `content:read`.

        Args:
            status: Only lectures in these states. Omitted means all of them.
            q: Only lectures whose title contains this, case-insensitively.
            page: The zero-based page. Default `0`.
            size: Lectures per page, 1-100. Default `24`.

        Example:
            ```python
            page = atlas.list_resources(status=["READY"], size=50)
            for resource in page["items"]:
                print(resource["id"], resource["title"])
            ```
        """
        return cast(
            ResourceListResponse,
            self._transport.call(
                "listResources",
                {
                    "path": {"orgId": self._org()},
                    "query": {"status": status, "q": q, "page": page, "size": size},
                    "credential": self._credential,
                },
            ),
        )

    def get_resource(self, resource_id: str) -> ResourceResponse:
        """One lecture: its title, status and current version. Needs `content:read`.

        Example:
            ```python
            resource = atlas.get_resource(resource_id)
            ```
        """
        return cast(
            ResourceResponse,
            self._transport.call(
                "getResource",
                {
                    "path": {
                        "orgId": self._org(),
                        "resourceId": _required(resource_id, "resource_id"),
                    },
                    "credential": self._credential,
                },
            ),
        )

    def get_resource_download(self, resource_id: str) -> ResourceDownloadResponse:
        """A short-lived address to download a lecture's original file. Needs `content:read`.

        Example:
            ```python
            download = atlas.get_resource_download(resource_id)
            print(download["downloadUrl"], download["expiresAt"], download["filename"])
            ```
        """
        return cast(
            ResourceDownloadResponse,
            self._transport.call(
                "getResourceDownload",
                {
                    "path": {
                        "orgId": self._org(),
                        "resourceId": _required(resource_id, "resource_id"),
                    },
                    "credential": self._credential,
                },
            ),
        )

    def _credential(self) -> str:
        return self._api_key

    def _org(self) -> str:
        if self._org_id is None:
            with self._org_lock:
                if self._org_id is None:
                    self._org_id = self.describe_key()["orgId"]
        return self._org_id


class PassClient:
    """Calls the ATLAS API with a delegated pass, as the person who consented.

    It has exactly the operations a pass can reach - the three content reads - so anything else is
    an attribute error, and a type error under a type checker.

    Example:
        ```python
        from devatlasframework.sdk import PassClient

        as_learner = PassClient(base_url=base_url, org_id=org_id, delegated_pass=delegated_pass)
        page = as_learner.list_resources()
        ```
    """

    versions: Versions = VERSIONS
    """This SDK's version and the contract it was generated from."""

    def __init__(
        self,
        *,
        org_id: str,
        delegated_pass: DelegatedPass | str,
        _internals: _Internals | None = None,
        **options: Unpack[ClientOptions],
    ) -> None:
        """Builds a client that acts as the person who consented.

        Args:
            org_id: The organisation the person consented for: the `org_id` you sent them to
                consent with.
            delegated_pass: The pass. A `DelegatedPass` renews itself before it expires, and keeps
                working until it expires if a renewal is refused. A bare access token is sent as
                it is, until it stops working.
            **options: Everything else, as `ClientOptions` describes it. `base_url` is required.
        """
        from ._delegated import DelegatedPass  # noqa: PLC0415 - the two modules name each other

        self._org_id = _required(org_id, "org_id")
        if isinstance(delegated_pass, str):
            self._pass: DelegatedPass | str = _required(delegated_pass, "delegated_pass")
        elif isinstance(delegated_pass, DelegatedPass):
            self._pass = delegated_pass
        else:
            raise AtlasConfigurationError(
                "delegated_pass is required: a DelegatedPass, or an access token"
            )
        self._transport = Transport(options, _internals)

    @property
    def rate_limit(self) -> RateLimitState | None:
        """Your request-rate budget as the most recent response reported it; see `KeyClient`."""
        return self._transport.rate_limit

    def list_resources(
        self,
        *,
        status: Sequence[ResourceStatus] | None = None,
        q: str | None = None,
        page: int | None = None,
        size: int | None = None,
    ) -> ResourceListResponse:
        """The lectures the person can read in this organisation, a page at a time.

        The pass needs `content:read`.

        Args:
            status: Only lectures in these states. Omitted means all of them.
            q: Only lectures whose title contains this, case-insensitively.
            page: The zero-based page. Default `0`.
            size: Lectures per page, 1-100. Default `24`.

        Example:
            ```python
            page = as_learner.list_resources(size=20)
            ```
        """
        return cast(
            ResourceListResponse,
            self._transport.call(
                "listResources",
                {
                    "path": {"orgId": self._org_id},
                    "query": {"status": status, "q": q, "page": page, "size": size},
                    "credential": self._credential,
                },
            ),
        )

    def get_resource(self, resource_id: str) -> ResourceResponse:
        """One lecture, as the person can see it. The pass needs `content:read`.

        Example:
            ```python
            resource = as_learner.get_resource(resource_id)
            ```
        """
        return cast(
            ResourceResponse,
            self._transport.call(
                "getResource",
                {
                    "path": {
                        "orgId": self._org_id,
                        "resourceId": _required(resource_id, "resource_id"),
                    },
                    "credential": self._credential,
                },
            ),
        )

    def get_resource_download(self, resource_id: str) -> ResourceDownloadResponse:
        """A short-lived download address for a lecture's original file.

        The pass needs `content:read`.

        Example:
            ```python
            download = as_learner.get_resource_download(resource_id)
            ```
        """
        return cast(
            ResourceDownloadResponse,
            self._transport.call(
                "getResourceDownload",
                {
                    "path": {
                        "orgId": self._org_id,
                        "resourceId": _required(resource_id, "resource_id"),
                    },
                    "credential": self._credential,
                },
            ),
        )

    def _credential(self) -> str:
        if isinstance(self._pass, str):
            return self._pass
        return self._pass.current_access_token()
