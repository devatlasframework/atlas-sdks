"""The SDK covers exactly what the contract lets a developer's credential call.

This file is what holds it there, in both directions, the way the API holds its own allow-lists to
the contract. The operation list is never written down: it is derived from the contract's security
arrays, so a new key-reachable operation turns this red until a method exists, and a removed one
turns it red until the method goes. A method's name is its operationId in snake_case.
"""

from __future__ import annotations

import hashlib
import inspect
import re
from collections.abc import Callable
from importlib.metadata import version
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlsplit

import pytest

from devatlasframework.sdk import SDK_VERSION, KeyClient, PassClient
from devatlasframework.sdk._generated.surface import (
    CONTRACT,
    DEVELOPER_SCHEMES,
    ERROR_CODES,
    OPERATIONS,
)

from .conftest import REPO
from .loopback import END_USER, KEY, ORG, Reply, Start

SRC = Path(__file__).resolve().parents[2] / "src" / "devatlasframework" / "sdk"


def snake(operation_id: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", operation_id).lower()


def admitting(scheme: str) -> list[str]:
    return sorted(op_id for op_id, op in OPERATIONS.items() if scheme in op.credentials)


def methods_of(cls: type) -> list[str]:
    """The operation methods a client class carries: its own public functions, nothing else."""
    return sorted(
        name
        for name, member in vars(cls).items()
        if not name.startswith("_") and inspect.isfunction(member)
    )


def operation_of(method: str) -> str:
    return next(op_id for op_id in OPERATIONS if snake(op_id) == method)


class TestTheSurfaceThisSdkCovers:
    def test_has_a_client_for_each_developer_credential_and_no_other(self) -> None:
        assert sorted(DEVELOPER_SCHEMES) == ["apiKeyAuth", "delegatedPassAuth"]

    def test_gives_a_key_client_exactly_the_operations_that_admit_an_api_key(self) -> None:
        assert methods_of(KeyClient) == sorted(snake(i) for i in admitting("apiKeyAuth"))
        assert len(methods_of(KeyClient)) == 9

    def test_gives_a_pass_client_exactly_the_operations_that_admit_a_pass(self) -> None:
        assert methods_of(PassClient) == sorted(snake(i) for i in admitting("delegatedPassAuth"))
        assert len(methods_of(PassClient)) == 3

    def test_obtains_a_pass_through_the_one_operation_named_as_its_issuer(self) -> None:
        issuers = [(op_id, op.issues) for op_id, op in OPERATIONS.items() if op.issues]
        assert issuers == [("exchangeDelegatedToken", "delegatedPassAuth")]
        assert '"exchangeDelegatedToken"' in (SRC / "_delegated.py").read_text(encoding="utf-8")

    def test_covers_ten_operations_each_reachable_from_some_part_of_the_sdk(self) -> None:
        reachable = {
            *map(operation_of, methods_of(KeyClient)),
            *map(operation_of, methods_of(PassClient)),
            "exchangeDelegatedToken",
        }
        assert sorted(reachable) == sorted(OPERATIONS)
        assert len(OPERATIONS) == 10


def arguments_for(method: Callable[..., Any]) -> dict[str, Any]:
    """Whatever a method needs to be called: made-up ids, and a body where it takes one."""
    values: dict[str, Any] = {
        "end_user_id": END_USER,
        "resource_id": "33333333-3333-4333-8333-333333333333",
        "body": {"ref": "learner-1"},
    }
    return {name: values[name] for name in inspect.signature(method).parameters if name in values}


BOUND = [("key", m) for m in methods_of(KeyClient)] + [("pass", m) for m in methods_of(PassClient)]


class TestEachMethod:
    @pytest.mark.parametrize(("credential", "method"), BOUND)
    def test_sends_the_method_and_path_its_operation_declares(
        self, loopback: Start, credential: str, method: str
    ) -> None:
        server = loopback(Reply(200, body={}))
        client: KeyClient | PassClient = (
            KeyClient(base_url=server.base_url, api_key=KEY, org_id=ORG)
            if credential == "key"
            else PassClient(base_url=server.base_url, org_id=ORG, delegated_pass=KEY)
        )
        bound = getattr(client, method)
        bound(**arguments_for(bound))

        operation = OPERATIONS[operation_of(method)]  # type: ignore[index]
        expected = operation.path
        for name, value in {
            "orgId": ORG,
            "endUserId": END_USER,
            "resourceId": "33333333-3333-4333-8333-333333333333",
        }.items():
            expected = expected.replace(f"{{{name}}}", value)
        [request] = server.received
        assert request.method == operation.method
        assert urlsplit(request.target).path == f"/v1{expected}"
        assert request.headers["authorization"] == f"Bearer {KEY}"

    @pytest.mark.parametrize("client", [KeyClient, PassClient])
    def test_list_resources_takes_exactly_the_query_parameters_the_contract_declares(
        self, loopback: Start, client: type[KeyClient] | type[PassClient]
    ) -> None:
        declared = OPERATIONS["listResources"].query_params
        keyword = [
            name
            for name, parameter in inspect.signature(client.list_resources).parameters.items()
            if parameter.kind is inspect.Parameter.KEYWORD_ONLY
        ]
        assert keyword == [snake(name) for name in declared]

        server = loopback(Reply(200, body={}))
        instance: KeyClient | PassClient = (
            KeyClient(base_url=server.base_url, api_key=KEY, org_id=ORG)
            if client is KeyClient
            else PassClient(base_url=server.base_url, org_id=ORG, delegated_pass=KEY)
        )
        instance.list_resources(status=["READY"], q="x", page=1, size=2)
        sent = [name for name, _ in parse_qsl(urlsplit(server.received[0].target).query)]
        assert sent == list(declared)

    def test_no_other_operation_takes_a_query_parameter(self) -> None:
        with_query = sorted(op_id for op_id, op in OPERATIONS.items() if op.query_params)
        assert with_query == ["listResources"]


class TestTheRetryClassOfEachOperation:
    def test_comes_from_the_contract_and_the_three_never_repeated_blindly_are_classed_so(
        self,
    ) -> None:
        for op_id, op in OPERATIONS.items():
            assert op.retry in {"repeatable", "repeatable-with-key", "once"}, op_id
        # present counts every call; the token leg treats a replayed refresh token as theft.
        assert OPERATIONS["presentForEndUser"].retry == "once"
        assert OPERATIONS["exchangeDelegatedToken"].retry == "once"
        # The one operation that declares a repeat guard.
        assert [i for i, op in OPERATIONS.items() if op.idempotency_key] == ["linkEndUser"]
        assert OPERATIONS["linkEndUser"].retry == "repeatable-with-key"


class TestTheErrorCodesTheSdkBranchesOn:
    def test_are_all_documented_by_the_contract(self) -> None:
        used: set[str] = set()
        for source in SRC.glob("*.py"):
            used |= set(re.findall(r"ATLAS-[A-Z]+-\d{3}", source.read_text(encoding="utf-8")))
        assert used
        assert used <= set(ERROR_CODES)


class TestTheContractThisBuildWasGeneratedFrom:
    def test_is_the_one_the_stamp_names_byte_for_byte(self) -> None:
        stamp = (REPO / "contract" / "SOURCE.md").read_text(encoding="utf-8")

        def field(label: str) -> str | None:
            prefix = f"| {label} | "
            for line in stamp.splitlines():
                if line.startswith(prefix):
                    found = re.match(r"`([^`]*)`", line[len(prefix) :])
                    return found.group(1) if found else None
            return None

        contract = (REPO / "contract" / "openapi.yaml").read_bytes()
        assert CONTRACT.version == field("Contract version")
        assert CONTRACT.sha256 == field("`contract/openapi.yaml` sha256")
        assert hashlib.sha256(contract).hexdigest() == CONTRACT.sha256

    def test_has_a_version_of_its_own_and_so_does_this_sdk(self) -> None:
        assert version("devatlasframework-sdk") == SDK_VERSION
