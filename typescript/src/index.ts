/**
 * The TypeScript SDK for the ATLAS API (`/v1`).
 *
 * - `KeyClient`: your server, calling with an API key.
 * - `PassClient`, with `createPkcePair`, `authorizationUrl` and `exchangeCode`: acting as a person
 *   who consented, with a delegated pass.
 * - `verifyWebhook`: checking that a message to your webhook endpoint came from ATLAS.
 */

export {
  KeyClient,
  PassClient,
  type BipolarScore,
  type DeveloperUsage,
  type EndUser,
  type EndUserPage,
  type KeyClientOptions,
  type KeyIdentity,
  type LearnerProfile,
  type LinkEndUserOptions,
  type LinkEndUserRequest,
  type ListResourcesQuery,
  type MultiCategoryScore,
  type PassClientOptions,
  type PersonalisationProfile,
  type PresentEndUserRequest,
  type Resource,
  type ResourceDownload,
  type ResourceList,
  type SubDimensionScore,
} from './client.js';
export {
  DelegatedPass,
  authorizationUrl,
  createPkcePair,
  exchangeCode,
  pkceChallenge,
  type AuthorizationUrlOptions,
  type DelegatedPassOptions,
  type DelegatedPassResponse,
  type DelegatedPassSnapshot,
  type ExchangeCodeOptions,
  type PkcePair,
  type TokenExchangeRequest,
} from './delegated.js';
export {
  AtlasApiError,
  AtlasConfigurationError,
  AtlasConnectionError,
  AtlasError,
  RefreshRefusedError,
  WebhookVerificationError,
  type KnownErrorCode,
  type Problem,
  type WebhookRefusal,
} from './errors.js';
export { ERROR_CODES } from './generated/surface.js';
export type { components, operations, webhooks } from './generated/contract.js';
export { readRateLimit, readRetryAfter, type RateLimitState } from './rate-limit.js';
export {
  DEFAULT_RETRY,
  type CallOptions,
  type ClientOptions,
  type OperationId,
  type ResponseEvent,
  type RetryEvent,
  type RetryPolicy,
  type RetryReason,
} from './transport.js';
export { CONTRACT_SHA256, CONTRACT_VERSION, SDK_VERSION, type Versions } from './version.js';
export {
  DEFAULT_TOLERANCE_SECONDS,
  SIGNATURE_HEADER,
  verifyWebhook,
  type ResourceWebhookEvent,
  type VerifyWebhookOptions,
} from './webhooks.js';
