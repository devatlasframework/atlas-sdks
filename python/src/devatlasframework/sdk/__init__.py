"""The Python SDK for the ATLAS API (`/v1`).

- `KeyClient`: your server, calling with an API key.
- `PassClient`, with `create_pkce_pair`, `authorization_url` and `exchange_code`: acting as a
  person who consented, with a delegated pass.
- `verify_webhook`: checking that a message to your webhook endpoint came from ATLAS.

Request and response bodies are `TypedDict`s keyed exactly as the API sends them - camelCase for
most bodies, snake_case for the token exchange's answer and webhook events - so nothing is renamed
between your code and the wire, and a field a later version of the API adds reaches you untouched.
"""

from ._client import KeyClient, PassClient, ResourceStatus
from ._delegated import (
    DelegatedPass,
    DelegatedPassSnapshot,
    OnRenewed,
    PkcePair,
    authorization_url,
    create_pkce_pair,
    exchange_code,
    pkce_challenge,
)
from ._errors import (
    AtlasApiError,
    AtlasConfigurationError,
    AtlasConnectionError,
    AtlasError,
    RefreshRefusedError,
    WebhookRefusal,
    WebhookVerificationError,
)
from ._generated.contract import (
    ApiScope,
    AttentionChecksSummary,
    BipolarScore,
    DelegatedPassResponse,
    DeveloperAppUsage,
    DeveloperRateLimitStanding,
    DeveloperUsageState,
    EndorsedCategory,
    EndUserPage,
    FeatureReason,
    LearnerProfile,
    LinkEndUserRequest,
    MultiCategoryScore,
    PersonalisationProfile,
    PresentationPlan,
    PresentEndUserRequest,
    Problem,
    ProfileAppearanceDefaults,
    RecommendedFeature,
    ResourceListResponse,
    ResourceWebhookEvent,
    ResourceWebhookEventData,
    SubDimensionScore,
    TokenExchangeRequest,
)
from ._generated.contract import DeveloperUsageResponse as DeveloperUsage
from ._generated.contract import EndUserResponse as EndUser
from ._generated.contract import KeyIdentityResponse as KeyIdentity
from ._generated.contract import ResourceDownloadResponse as ResourceDownload
from ._generated.contract import ResourceListResponse as ResourceList
from ._generated.contract import ResourceResponse as Resource
from ._generated.surface import ERROR_CODES, KnownErrorCode, OperationId
from ._rate_limit import RateLimitState, read_rate_limit, read_retry_after
from ._transport import (
    DEFAULT_RETRY,
    ClientOptions,
    ResponseEvent,
    RetryEvent,
    RetryPolicy,
    RetryReason,
)
from ._version import CONTRACT_SHA256, CONTRACT_VERSION, SDK_VERSION, VERSIONS, Versions
from ._webhooks import DEFAULT_TOLERANCE_SECONDS, SIGNATURE_HEADER, verify_webhook

__version__ = SDK_VERSION

__all__ = [
    "CONTRACT_SHA256",
    "CONTRACT_VERSION",
    "DEFAULT_RETRY",
    "DEFAULT_TOLERANCE_SECONDS",
    "ERROR_CODES",
    "SDK_VERSION",
    "SIGNATURE_HEADER",
    "VERSIONS",
    "ApiScope",
    "AtlasApiError",
    "AtlasConfigurationError",
    "AtlasConnectionError",
    "AtlasError",
    "AttentionChecksSummary",
    "BipolarScore",
    "ClientOptions",
    "DelegatedPass",
    "DelegatedPassResponse",
    "DelegatedPassSnapshot",
    "DeveloperAppUsage",
    "DeveloperRateLimitStanding",
    "DeveloperUsage",
    "DeveloperUsageState",
    "EndUser",
    "EndUserPage",
    "EndorsedCategory",
    "FeatureReason",
    "KeyClient",
    "KeyIdentity",
    "KnownErrorCode",
    "LearnerProfile",
    "LinkEndUserRequest",
    "MultiCategoryScore",
    "OnRenewed",
    "OperationId",
    "PassClient",
    "PersonalisationProfile",
    "PkcePair",
    "PresentEndUserRequest",
    "PresentationPlan",
    "Problem",
    "ProfileAppearanceDefaults",
    "RateLimitState",
    "RecommendedFeature",
    "RefreshRefusedError",
    "Resource",
    "ResourceDownload",
    "ResourceList",
    "ResourceListResponse",
    "ResourceStatus",
    "ResourceWebhookEvent",
    "ResourceWebhookEventData",
    "ResponseEvent",
    "RetryEvent",
    "RetryPolicy",
    "RetryReason",
    "SubDimensionScore",
    "TokenExchangeRequest",
    "Versions",
    "WebhookRefusal",
    "WebhookVerificationError",
    "__version__",
    "authorization_url",
    "create_pkce_pair",
    "exchange_code",
    "pkce_challenge",
    "read_rate_limit",
    "read_retry_after",
    "verify_webhook",
]
