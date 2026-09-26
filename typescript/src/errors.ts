import type { components } from './generated/contract.js';
import type { ERROR_CODES } from './generated/surface.js';
import type { RateLimitState } from './rate-limit.js';

/** A problem document (RFC 9457): the one shape every refusal from the API takes. */
export type Problem = components['schemas']['Problem'];

/**
 * Every `errorCode` the operations this SDK covers document. Branch on these: a code is never
 * removed or reused once published, and a new one is a new minor version of the contract.
 */
export type KnownErrorCode = (typeof ERROR_CODES)[number];

/** The base class of every error this SDK throws. */
export class AtlasError extends Error {
  override name = 'AtlasError';
}

/** The SDK was set up in a way it refuses, before any request was sent. */
export class AtlasConfigurationError extends AtlasError {
  override name = 'AtlasConfigurationError';
}

export interface AtlasApiErrorDetails {
  readonly operationId: string;
  readonly status: number;
  readonly problem: Problem | undefined;
  readonly requestId: string | undefined;
  readonly retryAfter: number | undefined;
  readonly rateLimit: RateLimitState | undefined;
  readonly attempts: number;
  readonly note?: string;
}

/**
 * The API answered, and the answer was a refusal.
 *
 * Branch on `errorCode`: it is on every refusal and names one cause exactly. The problem `type` is
 * coarser (two causes can share one) and is an identifier to compare, never a link to fetch.
 * Quote `requestId` in a support report; for an unexpected `500`, `errorId` is what identifies the
 * failure. Credentials never appear on this object, in its message, or in anything it holds.
 */
export class AtlasApiError extends AtlasError {
  override name = 'AtlasApiError';
  /** The operation that was refused, by its contract `operationId`. */
  readonly operationId: string;
  /** The HTTP status. */
  readonly status: number;
  /** The code to branch on. Absent only when something in front of the API refused the request. */
  readonly errorCode: string | undefined;
  /** On an unexpected `500`: the value that identifies that one failure. */
  readonly errorId: string | undefined;
  /** The problem `type` URI: an identifier, not a page. */
  readonly type: string | undefined;
  readonly title: string | undefined;
  readonly detail: string | undefined;
  /** For a validation refusal: each field that was refused, and why. */
  readonly errors: Problem['errors'];
  /** The whole problem document, when the refusal carried one. */
  readonly problem: Problem | undefined;
  /** `X-Request-Id`: identifies this exact call in ATLAS's own records. */
  readonly requestId: string | undefined;
  /** `Retry-After`, in seconds. Absent on a refusal that no wait would clear. */
  readonly retryAfter: number | undefined;
  /** Your overall request-rate budget as this response reported it, when it did. */
  readonly rateLimit: RateLimitState | undefined;
  /** How many attempts were made before giving up, the first included. */
  readonly attempts: number;

  constructor(details: AtlasApiErrorDetails) {
    const problem = details.problem;
    const summary = problem?.errorCode ?? problem?.title ?? `HTTP ${details.status}`;
    super(
      `${details.operationId} was refused: ${summary} (${details.status})` +
        (details.note ? `. ${details.note}` : '') +
        (details.requestId ? ` [request ${details.requestId}]` : ''),
    );
    this.operationId = details.operationId;
    this.status = details.status;
    this.problem = problem;
    this.errorCode = problem?.errorCode;
    this.errorId = problem?.errorId;
    this.type = problem?.type;
    this.title = problem?.title;
    this.detail = problem?.detail;
    this.errors = problem?.errors;
    this.requestId = details.requestId;
    this.retryAfter = details.retryAfter;
    this.rateLimit = details.rateLimit;
    this.attempts = details.attempts;
  }
}

/**
 * No complete response arrived: the connection failed, the attempt timed out, the call was
 * cancelled, or the answer stopped arriving part-way. (A redirect is an `AtlasApiError`: this SDK
 * never follows one, so that your credential is never sent to another address.)
 */
export class AtlasConnectionError extends AtlasError {
  override name = 'AtlasConnectionError';
  readonly operationId: string;
  readonly attempts: number;
  /**
   * True when the request may have reached the API before the failure. An operation that is not
   * safe to repeat is never retried in that case, and you should find out what happened before
   * sending it again.
   */
  readonly mayHaveReachedServer: boolean;

  constructor(
    operationId: string,
    message: string,
    attempts: number,
    mayHaveReachedServer: boolean,
    cause?: unknown,
  ) {
    super(`${operationId}: ${message}`, cause === undefined ? undefined : { cause });
    this.operationId = operationId;
    this.attempts = attempts;
    this.mayHaveReachedServer = mayHaveReachedServer;
  }
}

/** Why a webhook delivery was refused. */
export type WebhookRefusal =
  'not-raw' | 'no-secret' | 'missing-header' | 'malformed-header' | 'no-match' | 'stale' | 'not-json';

/** A webhook delivery failed verification. Answer it with a `4xx` and do not act on it. */
export class WebhookVerificationError extends AtlasError {
  override name = 'WebhookVerificationError';
  readonly reason: WebhookRefusal;

  constructor(reason: WebhookRefusal, message: string) {
    super(message);
    this.reason = reason;
  }
}

/**
 * A delegated pass could not be renewed. The pass in hand stays usable until `stillValidUntil`.
 * `refusal` says why: a `400` means the refresh token is spent or revoked, and the person must
 * consent again once the pass expires; a `429` spent nothing, and renewal is tried again near
 * expiry; anything else may have reached ATLAS, so the pass sets `renewalOutcomeUnknown` and the
 * SDK never presents that token again on its own - presenting a spent one is treated as theft, and
 * revokes every renewal token under the grant.
 */
export class RefreshRefusedError extends AtlasError {
  override name = 'RefreshRefusedError';
  /** When the pass you still hold stops working. */
  readonly stillValidUntil: Date;
  /** The refusal itself. */
  readonly refusal: AtlasApiError | AtlasConnectionError;

  constructor(refusal: AtlasApiError | AtlasConnectionError, stillValidUntil: Date) {
    super(
      `the delegated pass could not be renewed; the current one works until ${stillValidUntil.toISOString()}`,
      {
        cause: refusal,
      },
    );
    this.refusal = refusal;
    this.stillValidUntil = stillValidUntil;
  }
}
