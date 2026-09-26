import { createHmac, timingSafeEqual } from 'node:crypto';
import { AtlasConfigurationError, WebhookVerificationError } from './errors.js';
import type { components } from './generated/contract.js';

/** The body of every message ATLAS sends to your webhook endpoint. */
export type ResourceWebhookEvent = components['schemas']['ResourceWebhookEvent'];

/** The header carrying the signature, lower-cased as it arrives in most servers' header maps. */
export const SIGNATURE_HEADER = 'atlas-signature';

/** How far the signed timestamp may be from your clock, in seconds, as ATLAS publishes it. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** A signature header longer than this is refused unread. ATLAS sends one timestamp and at most two signatures. */
const MAX_HEADER_LENGTH = 1024;

/**
 * The most timestamps and signatures a header may carry. Every timestamp costs a keyed hash of the
 * whole body per secret, and an unauthenticated caller writes the header, so an unbounded count is
 * a way to spend your CPU for free. ATLAS sends one timestamp, and two signatures during a rotation.
 */
const MAX_TIMESTAMPS = 2;
const MAX_SIGNATURES = 4;

export interface VerifyWebhookOptions {
  /** How far the signed timestamp may be from `now`, in seconds. Default `300`. */
  readonly toleranceSeconds?: number;
  /** The time to check against. Default: this machine's clock. */
  readonly now?: Date;
}

/**
 * Verifies a webhook delivery and returns its event. Throws `WebhookVerificationError` when the
 * delivery is not authentic or not fresh: answer it with a `4xx` and do nothing else with it.
 *
 * Pass the RAW request body - the exact bytes received, before any JSON parsing. Parsing and
 * re-serialising changes the bytes, and the signature covers the bytes.
 *
 * Pass every secret you may be signing under. While you rotate an endpoint's secret, ATLAS signs
 * with the new one and the old one, and either verifies. Every signature in the header is tried
 * against every secret, so a delivery verifies throughout the overlap.
 *
 * Then deduplicate on the event's `delivery_id`: delivery is at least once, and a retried delivery
 * carries the same `delivery_id` with a fresh signature.
 *
 * @example
 * ```ts
 * import express from 'express';
 * import { verifyWebhook, WebhookVerificationError, SIGNATURE_HEADER } from '@devatlasframework/sdk';
 *
 * app.post('/atlas/webhooks', express.raw({ type: 'application/json' }), async (req, res) => {
 *   try {
 *     const event = verifyWebhook(req.body, req.get(SIGNATURE_HEADER), process.env.ATLAS_WEBHOOK_SECRET!);
 *     await deliveries.recordOnce(event); // durably, keyed on event.delivery_id - then answer
 *     res.sendStatus(204); // ATLAS never re-sends a delivery you answered 2xx
 *   } catch (error) {
 *     if (error instanceof WebhookVerificationError) res.status(400).send(error.reason);
 *     else throw error;
 *   }
 * });
 * ```
 */
export function verifyWebhook(
  rawBody: string | Uint8Array,
  signatureHeader: string | null | undefined,
  secrets: string | readonly string[],
  options: VerifyWebhookOptions = {},
): ResourceWebhookEvent {
  if (typeof rawBody !== 'string' && !(rawBody instanceof Uint8Array)) {
    throw new WebhookVerificationError(
      'not-raw',
      'pass the raw request body as received - a string or bytes - not a parsed object: re-serialising changes the bytes the signature covers',
    );
  }
  const keys = (typeof secrets === 'string' ? [secrets] : [...secrets]).filter(
    (secret) => typeof secret === 'string' && secret !== '',
  );
  if (keys.length === 0) throw new WebhookVerificationError('no-secret', 'no signing secret to verify with');
  if (typeof signatureHeader !== 'string' || signatureHeader.trim() === '') {
    throw new WebhookVerificationError('missing-header', `the ${SIGNATURE_HEADER} header is missing`);
  }
  if (signatureHeader.length > MAX_HEADER_LENGTH) {
    throw new WebhookVerificationError(
      'malformed-header',
      `the ${SIGNATURE_HEADER} header is too long to be ATLAS's`,
    );
  }

  const timestamps = new Set<string>();
  const signatures: Buffer[] = [];
  for (const part of signatureHeader.split(',')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (name === 't' && /^\d{1,12}$/.test(value)) timestamps.add(value);
    // A v1 is 64 lower-case hex characters; anything else can never match and is skipped. Other
    // names are skipped too, so a future signature scheme sent beside v1 does not break this one.
    if (name === 'v1' && /^[0-9a-f]{64}$/.test(value)) signatures.push(Buffer.from(value, 'hex'));
  }
  if (timestamps.size === 0 || signatures.length === 0) {
    throw new WebhookVerificationError(
      'malformed-header',
      `the ${SIGNATURE_HEADER} header carries no usable t= and v1= values`,
    );
  }
  if (timestamps.size > MAX_TIMESTAMPS || signatures.length > MAX_SIGNATURES) {
    throw new WebhookVerificationError(
      'malformed-header',
      `the ${SIGNATURE_HEADER} header carries more timestamps or signatures than ATLAS ever sends`,
    );
  }

  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new AtlasConfigurationError(
      'toleranceSeconds must be a finite number of seconds, not negative: without a window, a captured delivery can be replayed for ever',
    );
  }

  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  // Every timestamp is tried, and the one that produced a match is the one checked for freshness.
  // Checking the last one parsed instead is the classic hole: a captured old signature with a new
  // `t=` appended would verify against the old value and pass the window against the new one.
  const matched: number[] = [];
  for (const timestamp of timestamps) {
    for (const secret of keys) {
      const expected = createHmac('sha256', secret).update(`${timestamp}.`, 'utf8').update(body).digest();
      if (signatures.some((signature) => timingSafeEqual(expected, signature))) {
        matched.push(Number(timestamp));
        break;
      }
    }
  }
  if (matched.length === 0) {
    throw new WebhookVerificationError(
      'no-match',
      'no signature matches this body under any secret given: it was not signed by ATLAS with your secret, or the body was altered',
    );
  }

  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (!matched.some((timestamp) => Math.abs(now - timestamp) <= tolerance)) {
    throw new WebhookVerificationError(
      'stale',
      `the signature is authentic but its timestamp is more than ${tolerance} seconds from now: it may be a replay`,
    );
  }

  try {
    return JSON.parse(body.toString('utf8')) as ResourceWebhookEvent;
  } catch {
    throw new WebhookVerificationError('not-json', 'the signature is valid, and the body is not JSON');
  }
}
