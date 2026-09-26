import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AtlasConfigurationError, WebhookVerificationError } from '../../src/errors.js';
import { verifyWebhook } from '../../src/webhooks.js';

// Two sources of signed deliveries, and neither is this SDK: it ships no signer, so no test here
// can pass by agreeing with itself.
//
// 1. A delivery captured from ATLAS's real sender on Dev. Its endpoint was deleted after the
//    capture, so its secret signs nothing any more; it is here because it is the real thing.
// 2. A vector signed by OpenSSL, for the cases a single capture cannot show: a rotation carrying
//    two signatures, and a header built to defeat a verifier that checks the wrong timestamp.
interface Captured {
  readonly secret: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}
const captured = JSON.parse(
  readFileSync(new URL('../../../scenarios/fixtures/webhook-delivery-dev.json', import.meta.url), 'utf8'),
) as Captured;

interface Vector {
  readonly timestamp: number;
  readonly body: string;
  readonly secrets: { readonly current: string; readonly previous: string };
  readonly signatures: { readonly current: string; readonly previous: string };
  readonly headers: { readonly current: string; readonly rotation: string };
}
const vector = JSON.parse(
  readFileSync(new URL('./vectors/openssl-webhook.json', import.meta.url), 'utf8'),
) as Vector;

const at = (seconds: number) => ({ now: new Date(seconds * 1000) });

function refusal(run: () => unknown): WebhookVerificationError {
  try {
    run();
  } catch (error) {
    if (error instanceof WebhookVerificationError) return error;
    throw error;
  }
  throw new Error('verified, and should have been refused');
}

describe("a delivery captured from ATLAS's real sender", () => {
  const header = captured.headers['atlas-signature'] ?? '';
  const signedAt = Number(/(?:^|,)t=(\d+)/.exec(header)?.[1]);

  it('verifies, and returns the event it carries', () => {
    const event = verifyWebhook(captured.body, header, captured.secret, at(signedAt));
    expect(event.delivery_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(['resource.ready', 'resource.updated', 'resource.failed']).toContain(event.type);
  });

  it('verifies from bytes as well as from a string', () => {
    expect(() =>
      verifyWebhook(new TextEncoder().encode(captured.body), header, captured.secret, at(signedAt)),
    ).not.toThrow();
  });

  it('is refused with one byte of the body changed', () => {
    const bytes = Buffer.from(captured.body, 'utf8');
    bytes[bytes.length - 2] = bytes[bytes.length - 2]! ^ 0x01;
    expect(refusal(() => verifyWebhook(bytes, header, captured.secret, at(signedAt))).reason).toBe(
      'no-match',
    );
  });

  it('is refused once it is older than the window', () => {
    expect(
      refusal(() => verifyWebhook(captured.body, header, captured.secret, at(signedAt + 301))).reason,
    ).toBe('stale');
  });

  it('is refused under a secret it was not signed with', () => {
    expect(
      refusal(() => verifyWebhook(captured.body, header, `${captured.secret}x`, at(signedAt))).reason,
    ).toBe('no-match');
  });
});

describe('a delivery signed by OpenSSL', () => {
  it('verifies against a single signature', () => {
    const event = verifyWebhook(
      vector.body,
      vector.headers.current,
      vector.secrets.current,
      at(vector.timestamp),
    );
    expect(event.type).toBe('resource.ready');
  });

  it('verifies during a rotation under either secret, whichever order the signatures come in', () => {
    const swapped = `t=${vector.timestamp},v1=${vector.signatures.previous},v1=${vector.signatures.current}`;
    for (const header of [vector.headers.rotation, swapped]) {
      for (const secret of [vector.secrets.current, vector.secrets.previous]) {
        expect(() => verifyWebhook(vector.body, header, secret, at(vector.timestamp))).not.toThrow();
      }
    }
    expect(() =>
      verifyWebhook(
        vector.body,
        vector.headers.current,
        [vector.secrets.previous, vector.secrets.current],
        at(vector.timestamp),
      ),
    ).not.toThrow();
  });

  it('is refused when one character of the signature is changed', () => {
    const sig = vector.signatures.current;
    const flipped = `${sig.slice(0, -1)}${sig.endsWith('0') ? '1' : '0'}`;
    const header = `t=${vector.timestamp},v1=${flipped}`;
    expect(
      refusal(() => verifyWebhook(vector.body, header, vector.secrets.current, at(vector.timestamp))).reason,
    ).toBe('no-match');
  });

  it('checks freshness on the timestamp that produced the match, not the last one in the header', () => {
    // An old delivery with a fresh `t=` appended: its signature matches the OLD timestamp only.
    // A verifier that checks the window against the last `t` it parsed would accept it.
    const later = vector.timestamp + 86_400;
    const header = `${vector.headers.current},t=${later}`;
    expect(refusal(() => verifyWebhook(vector.body, header, vector.secrets.current, at(later))).reason).toBe(
      'stale',
    );
  });

  it('accepts clock skew inside the window in both directions', () => {
    for (const skew of [-300, 300]) {
      expect(() =>
        verifyWebhook(
          vector.body,
          vector.headers.current,
          vector.secrets.current,
          at(vector.timestamp + skew),
        ),
      ).not.toThrow();
    }
  });
});

describe('what the verifier refuses before it computes anything', () => {
  it('a parsed object, because re-serialising changes the bytes', () => {
    const parsed = JSON.parse(vector.body) as unknown;
    expect(
      refusal(() => verifyWebhook(parsed as string, vector.headers.current, vector.secrets.current)).reason,
    ).toBe('not-raw');
  });

  it("a missing header, a header with nothing usable in it, and one too long to be ATLAS's", () => {
    expect(refusal(() => verifyWebhook(vector.body, undefined, vector.secrets.current)).reason).toBe(
      'missing-header',
    );
    expect(refusal(() => verifyWebhook(vector.body, 'v0=abc', vector.secrets.current)).reason).toBe(
      'malformed-header',
    );
    expect(
      refusal(() => verifyWebhook(vector.body, `t=1,v1=${'A'.repeat(64)}`, vector.secrets.current)).reason,
    ).toBe('malformed-header');
    expect(
      refusal(() => verifyWebhook(vector.body, `t=1,${'v1=x,'.repeat(300)}`, vector.secrets.current)).reason,
    ).toBe('malformed-header');
  });

  it('no secret at all', () => {
    expect(refusal(() => verifyWebhook(vector.body, vector.headers.current, [])).reason).toBe('no-secret');
    expect(refusal(() => verifyWebhook(vector.body, vector.headers.current, '')).reason).toBe('no-secret');
  });
});

describe('what the verifier refuses to spend CPU on', () => {
  it('more timestamps than ATLAS ever sends', () => {
    const header = `t=1,t=2,t=${vector.timestamp},v1=${vector.signatures.current}`;
    expect(
      refusal(() => verifyWebhook(vector.body, header, vector.secrets.current, at(vector.timestamp))).reason,
    ).toBe('malformed-header');
  });

  it('more signatures than ATLAS ever sends', () => {
    const header = `t=${vector.timestamp},${`v1=${'0'.repeat(64)},`.repeat(4)}v1=${vector.signatures.current}`;
    expect(
      refusal(() => verifyWebhook(vector.body, header, vector.secrets.current, at(vector.timestamp))).reason,
    ).toBe('malformed-header');
  });

  it('a tolerance that is not a finite, non-negative number of seconds', () => {
    for (const toleranceSeconds of [Number.POSITIVE_INFINITY, Number.NaN, -1]) {
      expect(() =>
        verifyWebhook(vector.body, vector.headers.current, vector.secrets.current, {
          ...at(vector.timestamp),
          toleranceSeconds,
        }),
      ).toThrow(AtlasConfigurationError);
    }
  });
});
