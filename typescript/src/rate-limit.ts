/**
 * Your request-rate budget, as the last response reported it.
 *
 * It describes one budget: your own overall request rate. Several operations also have narrower
 * limits of their own, and when one of those refuses you, the response still carries your overall
 * figures unchanged - so `remaining` can read a healthy number beside a `429`. Diagnose a refusal
 * from its `Retry-After` and its `errorCode` (both on `AtlasApiError`), never from `remaining`.
 */
export interface RateLimitState {
  /** Your request ceiling for one window (`RateLimit-Limit`). */
  readonly limit: number;
  /** Requests left in the current window, floored at zero (`RateLimit-Remaining`). */
  readonly remaining: number;
  /** Seconds until the current window ends, as of `observedAt` (`RateLimit-Reset`). */
  readonly resetSeconds: number;
  /** When the response carrying these figures arrived. */
  readonly observedAt: Date;
}

function integer(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  return Number(value.trim());
}

/**
 * Reads the three `RateLimit-*` headers, or returns `undefined` when any is missing or unreadable.
 *
 * Absence is not "unlimited". ATLAS omits the headers when it cannot reach the counter behind the
 * budget, rather than report a figure it cannot stand behind, so `undefined` means unknown.
 */
export function readRateLimit(headers: Headers, observedAt: Date): RateLimitState | undefined {
  const limit = integer(headers.get('ratelimit-limit'));
  const remaining = integer(headers.get('ratelimit-remaining'));
  const resetSeconds = integer(headers.get('ratelimit-reset'));
  if (limit === undefined || remaining === undefined || resetSeconds === undefined) return undefined;
  return Object.freeze({ limit, remaining, resetSeconds, observedAt });
}

/**
 * Reads `Retry-After` as seconds: either form RFC 9110 allows, delta-seconds or an HTTP date.
 * `undefined` when it is absent, which on a `429` means the refusal does not clear after an
 * interval (an exhausted credit allowance, for one) and waiting would not help.
 */
export function readRetryAfter(headers: Headers, now: Date): number | undefined {
  const value = headers.get('retry-after')?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now.getTime()) / 1000));
}
