import { randomUUID } from 'node:crypto';
import {
  AtlasApiError,
  AtlasConfigurationError,
  AtlasConnectionError,
  AtlasError,
  type Problem,
} from './errors.js';
import { OPERATIONS, SERVER_PATH } from './generated/surface.js';
import { readRateLimit, readRetryAfter, type RateLimitState } from './rate-limit.js';
import { CONTRACT_VERSION, SDK_VERSION } from './version.js';

/** An operation this SDK covers, by its contract `operationId`. */
export type OperationId = keyof typeof OPERATIONS;

/** How the SDK retries. Every bound is its own: ATLAS promises no retention window to fit inside. */
export interface RetryPolicy {
  /** Attempts in total, the first included. Default `3`. `1` turns retrying off. */
  readonly maxAttempts: number;
  /**
   * The longest `Retry-After` the SDK waits out, in seconds. A `429` asking for longer is returned
   * to you as the error, so that no call can block for an unbounded time. Default `60`.
   */
  readonly maxRetryAfterSeconds: number;
  /** The first wait after a failure that names no wait, doubled per attempt, with jitter. Default `250`. */
  readonly baseDelayMs: number;
  /** The longest such wait. Default `5000`. */
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = Object.freeze({
  maxAttempts: 3,
  maxRetryAfterSeconds: 60,
  baseDelayMs: 250,
  maxDelayMs: 5000,
});

/** Why an attempt is being repeated. */
export type RetryReason = 'throttled' | 'server-error' | 'connection' | 'in-flight';

/** Passed to `onRetry` before the SDK waits and sends the same request again. */
export interface RetryEvent {
  readonly operationId: OperationId;
  /** The attempt that failed, counting from 1. */
  readonly attempt: number;
  readonly reason: RetryReason;
  /** How long the SDK will wait before the next attempt. */
  readonly delayMs: number;
  readonly status?: number;
  readonly requestId?: string;
  /** The `Retry-After` the refusal carried, in seconds. */
  readonly retryAfter?: number;
}

/** Passed to `onResponse` for every response, success or refusal. */
export interface ResponseEvent {
  readonly operationId: OperationId;
  readonly attempt: number;
  readonly status: number;
  readonly requestId: string | undefined;
  readonly rateLimit: RateLimitState | undefined;
}

/** Everything a client needs besides its credential. */
export interface ClientOptions {
  /**
   * The address the ATLAS API is served from, for example `https://api.example.test`, without the
   * `/v1` every operation adds. Required: the contract names no host, so there is nothing to
   * default to. `https` is required, except for a loopback address (`localhost`, `127.0.0.1`,
   * `[::1]`), because a key or a pass sent over plain http to anywhere else is sent in the clear.
   */
  readonly baseUrl: string;
  /** Replaces the global `fetch`, for a proxy agent or a test. */
  readonly fetch?: typeof fetch;
  /** How long one attempt may take before it is abandoned. Default `30000`. */
  readonly timeoutMs?: number;
  /** Overrides any part of `DEFAULT_RETRY`. */
  readonly retry?: Partial<RetryPolicy>;
  /** Appended to the SDK's own `User-Agent`, to name your application. */
  readonly userAgent?: string;
  /** Called before every retry, with what failed and how long the SDK will wait. */
  readonly onRetry?: (event: RetryEvent) => void;
  /** Called for every response, with its status, `X-Request-Id` and rate-limit figures. */
  readonly onResponse?: (event: ResponseEvent) => void;
}

/** Options every call accepts. */
export interface CallOptions {
  /** Cancels the call, including any wait between attempts. */
  readonly signal?: AbortSignal;
}

/** Test seams. Not exported from the package. */
export interface TransportInternals {
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
  readonly now?: () => Date;
}

type QueryValue = string | number | boolean | readonly (string | number | boolean)[] | undefined;

export interface Call {
  readonly path?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly body?: unknown;
  /** Returns the bearer token to send, or `undefined` for an operation that takes none. */
  readonly credential?: () => string | Promise<string>;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal | undefined;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Validates a caller-supplied address and returns it without a trailing slash. */
export function checkedBaseUrl(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AtlasConfigurationError(
      `${label} is required: the ATLAS API contract names no host, so there is nothing to default to`,
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AtlasConfigurationError(`${label} is not an absolute URL: ${JSON.stringify(value)}`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new AtlasConfigurationError(
      `${label} must use https (plain http is accepted only for a loopback address): a credential sent ` +
        'over plain http to anywhere else is sent in the clear',
    );
  }
  if (url.username || url.password) {
    throw new AtlasConfigurationError(`${label} must not carry a user name or password`);
  }
  if (url.search || url.hash) {
    throw new AtlasConfigurationError(`${label} must not carry a query or a fragment`);
  }
  const trimmed = url.href.replace(/\/+$/, '');
  if (label === 'baseUrl' && trimmed.endsWith(SERVER_PATH)) {
    throw new AtlasConfigurationError(
      `baseUrl ends with ${SERVER_PATH}, which every operation adds itself: pass the address the API is served from`,
    );
  }
  return trimmed;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * What a request header may carry, per RFC 9110: visible ASCII, space and tab. Checked before a
 * request is built, because `fetch` refuses anything else with an error that quotes the whole
 * value - and the value is usually your credential.
 */
const FIELD_VALUE = /^[\t\x20-\x7e]*$/;

function checkedHeader(value: string, what: string): string {
  if (!FIELD_VALUE.test(value)) {
    throw new AtlasConfigurationError(
      `${what} contains a character a request header cannot carry - a line break, a NUL or a non-ASCII ` +
        'character. It is not repeated here.',
    );
  }
  return value;
}

/**
 * The error to keep as a cause, or `undefined` if any message in its chain carries the secret.
 * Header values are validated before sending, so this should never drop anything; it is here so
 * that a platform error nobody anticipated cannot put a credential into a log.
 */
function safeCause(error: unknown, secret: string | undefined): unknown {
  if (!secret) return error;
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current.message.includes(secret) || current.stack?.includes(secret)) return undefined;
    current = current.cause;
  }
  return error;
}

/** The most a successful answer may be, and the most of a refusal that is read. */
const SUCCESS_LIMIT = 16 * 1024 * 1024;
const REFUSAL_LIMIT = 64 * 1024;

class BodyTooLarge extends AtlasError {
  constructor(limit: number) {
    super(`the response body is larger than ${limit} bytes, which is more than this API ever sends`);
  }
}

/** Reads a body as text, refusing to hold more than `limit` bytes of it. */
async function readLimited(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new BodyTooLarge(limit);
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLarge(limit);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function isProblem(value: unknown): value is Problem {
  return (
    typeof value === 'object' &&
    value !== null &&
    (typeof (value as Problem).status === 'number' || typeof (value as Problem).type === 'string')
  );
}

async function readProblem(response: Response): Promise<{ problem: Problem | undefined; note?: string }> {
  const contentType = response.headers.get('content-type') ?? '';
  let text = '';
  try {
    text = await readLimited(response, REFUSAL_LIMIT);
  } catch (error) {
    if (!(error instanceof BodyTooLarge)) throw error;
  }
  if (/json/i.test(contentType)) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isProblem(parsed)) return { problem: parsed };
    } catch {
      // Falls through to the note: a refusal that says it is JSON and is not.
    }
  }
  // Something in front of the API refused the request - the web server refuses a path with an
  // encoded slash or a NUL byte before the API sees it. Its body is never echoed: it is not a
  // problem document, and repeating markup into an error message helps nobody.
  return {
    problem: undefined,
    note: `the refusal carried no problem document (${contentType.split(';')[0] || 'no content type'})`,
  };
}

/**
 * Sends one operation, applying the retry class the contract gives it:
 *
 * - `repeatable` (an idempotent method) and `repeatable-with-key` (the operation declares
 *   `Idempotency-Key`, and every attempt carries the same one) are retried after a `5xx` or a
 *   connection that failed;
 * - `once` is never retried after a failure that may have reached the API: `present` meters every
 *   call, and a replayed refresh token is treated as theft;
 * - every class waits out a `429`'s `Retry-After`, because a throttled request did nothing.
 */
export class Transport {
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #retry: RetryPolicy;
  readonly #userAgent: string;
  readonly #onRetry: ((event: RetryEvent) => void) | undefined;
  readonly #onResponse: ((event: ResponseEvent) => void) | undefined;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #random: () => number;
  readonly #now: () => Date;
  #rateLimit: RateLimitState | undefined;

  constructor(options: ClientOptions, internals: TransportInternals = {}) {
    this.#base = checkedBaseUrl(options?.baseUrl, 'baseUrl');
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#retry = { ...DEFAULT_RETRY, ...options.retry };
    if (!Number.isInteger(this.#retry.maxAttempts) || this.#retry.maxAttempts < 1) {
      throw new AtlasConfigurationError('retry.maxAttempts must be a whole number of at least 1');
    }
    this.#userAgent = checkedHeader(
      `atlas-sdk-typescript/${SDK_VERSION} (contract ${CONTRACT_VERSION}; node ${process.versions.node})` +
        (options.userAgent ? ` ${options.userAgent}` : ''),
      'userAgent',
    );
    this.#onRetry = options.onRetry;
    this.#onResponse = options.onResponse;
    this.#sleep = internals.sleep ?? defaultSleep;
    this.#random = internals.random ?? Math.random;
    this.#now = internals.now ?? (() => new Date());
  }

  /** Your request-rate budget as the most recent response reported it, or `undefined` when unknown. */
  get rateLimit(): RateLimitState | undefined {
    return this.#rateLimit;
  }

  /** The address operations are sent to, with the contract's server path. */
  url(operationId: OperationId, path: Call['path'] = {}, query: Call['query'] = {}): string {
    const template = OPERATIONS[operationId].path;
    const filled = template.replace(/\{([^}]+)\}/g, (_, name: string) => {
      const value = path[name];
      if (typeof value !== 'string' || value === '') {
        throw new AtlasConfigurationError(`${operationId} needs a non-empty ${name}`);
      }
      // `encodeURIComponent` leaves `.` alone, and a URL resolves `.` and `..` as path steps: an
      // id of `..` would send this call, with its credential, to a different route.
      if (value === '.' || value === '..') {
        throw new AtlasConfigurationError(`${operationId}: ${name} cannot be "${value}"`);
      }
      return encodeURIComponent(value);
    });
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {
      if (value === undefined) continue;
      for (const one of Array.isArray(value) ? value : [value]) search.append(name, String(one));
    }
    const qs = search.toString();
    return `${this.#base}${SERVER_PATH}${filled}${qs ? `?${qs}` : ''}`;
  }

  async call<T>(operationId: OperationId, call: Call = {}): Promise<T> {
    const operation = OPERATIONS[operationId];
    const url = this.url(operationId, call.path, call.query);
    const payload = call.body === undefined ? undefined : JSON.stringify(call.body);
    // One key per logical call, generated once and sent on every attempt: that is what lets the
    // API recognise a retry as the same request and answer it with the first outcome.
    const idempotencyKey = operation.idempotencyKey
      ? checkedHeader(call.idempotencyKey ?? randomUUID(), 'idempotencyKey')
      : undefined;
    const ownKey = operation.idempotencyKey && call.idempotencyKey === undefined;

    for (let attempt = 1; ; attempt += 1) {
      const headers: Record<string, string> = {
        accept: 'application/json, application/problem+json',
        'user-agent': this.#userAgent,
      };
      if (payload !== undefined) headers['content-type'] = 'application/json';
      if (idempotencyKey !== undefined) headers['idempotency-key'] = idempotencyKey;
      const credential = call.credential
        ? checkedHeader(await call.credential(), 'the credential')
        : undefined;
      if (credential !== undefined) headers.authorization = `Bearer ${credential}`;

      const timeout = AbortSignal.timeout(this.#timeoutMs);
      const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout;

      let response: Response;
      try {
        response = await this.#fetch(url, {
          method: operation.method,
          headers,
          ...(payload === undefined ? {} : { body: payload }),
          // Never followed: a redirect would carry the Authorization header to an address you
          // did not configure.
          redirect: 'manual',
          signal,
        });
      } catch (error) {
        const cause = safeCause(error, credential);
        if (call.signal?.aborted) {
          throw new AtlasConnectionError(operationId, 'the call was cancelled', attempt, true, cause);
        }
        const timedOut = timeout.aborted;
        if (operation.retry !== 'once' && attempt < this.#retry.maxAttempts) {
          await this.#wait(operationId, attempt, 'connection', this.#backoff(attempt), call.signal);
          continue;
        }
        throw new AtlasConnectionError(
          operationId,
          timedOut
            ? `no response within ${this.#timeoutMs} ms`
            : 'the connection failed before a response arrived',
          attempt,
          true,
          cause,
        );
      }

      const now = this.#now();
      const requestId = response.headers.get('x-request-id') ?? undefined;
      const rateLimit = readRateLimit(response.headers, now);
      if (rateLimit) this.#rateLimit = rateLimit;
      this.#onResponse?.({ operationId, attempt, status: response.status, requestId, rateLimit });

      if (response.status >= 200 && response.status < 300) {
        return (await this.#reading(operationId, attempt, credential, () =>
          this.#readBody(operationId, response),
        )) as T;
      }

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        throw new AtlasApiError({
          operationId,
          status: response.status,
          problem: undefined,
          requestId,
          retryAfter: undefined,
          rateLimit,
          attempts: attempt,
          note: 'the API answered with a redirect, which this SDK never follows, so that your credential is only sent to the address you configured',
        });
      }

      const { problem, note } = await this.#reading(operationId, attempt, credential, () =>
        readProblem(response),
      );
      const retryAfter = readRetryAfter(response.headers, now);
      const next = this.#nextAttempt(operation.retry, response.status, problem, retryAfter, attempt, ownKey);
      if (next) {
        await this.#wait(operationId, attempt, next.reason, next.delayMs, call.signal, {
          status: response.status,
          ...(requestId === undefined ? {} : { requestId }),
          ...(retryAfter === undefined ? {} : { retryAfter }),
        });
        continue;
      }
      throw new AtlasApiError({
        operationId,
        status: response.status,
        problem,
        requestId,
        retryAfter,
        rateLimit,
        attempts: attempt,
        ...(note === undefined ? {} : { note }),
      });
    }
  }

  #nextAttempt(
    retry: 'repeatable' | 'repeatable-with-key' | 'once',
    status: number,
    problem: Problem | undefined,
    retryAfter: number | undefined,
    attempt: number,
    ownKey: boolean,
  ): { reason: RetryReason; delayMs: number } | undefined {
    if (attempt >= this.#retry.maxAttempts) return undefined;
    if (status === 429) {
      // No Retry-After means the refusal does not clear with time (an exhausted credit allowance),
      // and one longer than the bound is yours to decide about.
      if (retryAfter === undefined || retryAfter > this.#retry.maxRetryAfterSeconds) return undefined;
      return { reason: 'throttled', delayMs: retryAfter * 1000 + Math.floor(this.#random() * 250) };
    }
    if (
      status === 409 &&
      retry === 'repeatable-with-key' &&
      ownKey &&
      attempt > 1 &&
      problem?.errorCode === 'ATLAS-DEV-010'
    ) {
      // The code means "another request used this key" or "the first call is still in flight".
      // With a key the SDK generated for this one call, and a body identical byte for byte, only
      // the second is possible - so it waits, and the next attempt is answered with the outcome.
      // A key you supplied may have been used for something else, so that 409 is returned to you.
      return { reason: 'in-flight', delayMs: this.#backoff(attempt) };
    }
    if (status >= 500 && retry !== 'once') {
      return { reason: 'server-error', delayMs: this.#backoff(attempt) };
    }
    return undefined;
  }

  #backoff(attempt: number): number {
    const ceiling = Math.min(this.#retry.maxDelayMs, this.#retry.baseDelayMs * 2 ** (attempt - 1));
    return Math.floor(ceiling / 2 + (this.#random() * ceiling) / 2);
  }

  async #wait(
    operationId: OperationId,
    attempt: number,
    reason: RetryReason,
    delayMs: number,
    signal: AbortSignal | undefined,
    extra: { status?: number; requestId?: string; retryAfter?: number } = {},
  ): Promise<void> {
    this.#onRetry?.({ operationId, attempt, reason, delayMs, ...extra });
    try {
      await this.#sleep(delayMs, signal);
    } catch (error) {
      throw new AtlasConnectionError(
        operationId,
        'the call was cancelled while waiting to retry',
        attempt,
        true,
        error,
      );
    }
  }

  /**
   * Reads a response body, turning a timeout or a dropped connection part-way through into an
   * `AtlasConnectionError` rather than letting a platform error escape. The API has already acted
   * by then, so `mayHaveReachedServer` is true.
   */
  async #reading<R>(
    operationId: OperationId,
    attempt: number,
    credential: string | undefined,
    read: () => Promise<R>,
  ): Promise<R> {
    try {
      return await read();
    } catch (error) {
      if (error instanceof AtlasError) throw error;
      throw new AtlasConnectionError(
        operationId,
        'the response did not finish arriving',
        attempt,
        true,
        safeCause(error, credential),
      );
    }
  }

  async #readBody(operationId: OperationId, response: Response): Promise<unknown> {
    let text: string;
    try {
      text = await readLimited(response, SUCCESS_LIMIT);
    } catch (error) {
      if (error instanceof BodyTooLarge) throw new AtlasError(`${operationId}: ${error.message}`);
      throw error;
    }
    if (text === '') return undefined;
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new AtlasError(
        `${operationId}: the API answered ${response.status} with a body that is not JSON`,
        {
          cause: error,
        },
      );
    }
  }
}
