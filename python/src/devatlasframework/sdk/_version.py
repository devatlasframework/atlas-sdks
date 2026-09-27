"""This SDK's version, and the contract it was generated from."""

from dataclasses import dataclass
from typing import Final

from ._generated.surface import CONTRACT

SDK_VERSION: Final = "0.1.0"
"""This SDK's own version.

It moves when this SDK changes, never because the contract did: a breaking change to this SDK's
own surface is this SDK's major, and the contract keeps a version of its own. The package version
is read from this line, so the two cannot differ.
"""

CONTRACT_VERSION: Final[str] = CONTRACT.version
"""The version of the API contract this build was generated from."""

CONTRACT_SHA256: Final[str] = CONTRACT.sha256
"""The sha256 of that contract file."""


@dataclass(frozen=True, slots=True)
class Versions:
    """Both numbers, readable at run time from any client as `client.versions`.

    Attributes:
        sdk: This SDK's version.
        contract: The version of the API contract this SDK was generated from.
        contract_sha256: The sha256 of that contract file.
    """

    sdk: str
    contract: str
    contract_sha256: str


VERSIONS: Final = Versions(
    sdk=SDK_VERSION, contract=CONTRACT_VERSION, contract_sha256=CONTRACT_SHA256
)
"""This build's versions."""
