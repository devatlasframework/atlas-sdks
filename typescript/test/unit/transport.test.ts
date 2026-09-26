import { afterEach, describe, expect, it } from 'vitest';
import { AtlasApiError, AtlasConfigurationError, AtlasConnectionError } from '../../src/errors.js';
import { KeyClient } from '../../src/client.js';
import { CONTRACT_VERSION, SDK_VERSION } from '../../src/version.js';
import { instant, loopback, problem, type Loopback } from './loopback.js';

const KEY = 'unit-test-key-not-a-credential';
const ORG = '11111111-1111-4111-8111-111111111111';
const END_USER = '22222222-2222-4222-8222-222222222222';
const KEY_IDENTITY = {
  keyId: 'k',
  appId: 'a',
  orgId: ORG,
  keyPrefix: 'atl_sk_live_',
  last4: '0000',
  scopes: [],
};
const END_USER_BODY = { id: END_USER, appId: 'a', active: true, linkedAt: '2026-09-26T00:00:00Z' };

let server: Loopback | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function client(baseUrl: string, extra: Partial<ConstructorParameters<typeof KeyClient>[0]> = {}) {
  const clock = instant();
  const atlas = new KeyClient({ baseUrl, apiKey: KEY, orgId: ORG, ...extra }, clock.internals);
  return { atlas, sleeps: clock.sleeps };
}

describe('the address', () => {
  it('is required, because the contract names no host to default to', () => {
    expect(() => new KeyClient({ apiKey: KEY } as never)).toThrow(AtlasConfigurationError);
    expect(() => new KeyClient({ baseUrl: '', apiKey: KEY })).toThrow(/required/);
  });

  it('refuses plain http anywhere but a loopback address', () => {
    expect(() => new KeyClient({ baseUrl: 'http://api.example.test', apiKey: KEY })).toThrow(/https/);
    expect(() => new KeyClient({ baseUrl: 'http://127.0.0.1:8080', apiKey: KEY })).not.toThrow();
    expect(() => new KeyClient({ baseUrl: 'http://localhost:8080', apiKey: KEY })).not.toThrow();
    expect(() => new KeyClient({ baseUrl: 'http://[::1]:8080', apiKey: KEY })).not.toThrow();
    expect(() => new KeyClient({ baseUrl: 'https://api.example.test', apiKey: KEY })).not.toThrow();
  });

  it('refuses an address that already ends in the server path, a query, or a user name', () => {
    expect(() => new KeyClient({ baseUrl: 'https://api.example.test/v1', apiKey: KEY })).toThrow(/\/v1/);
    expect(() => new KeyClient({ baseUrl: 'https://api.example.test/?a=1', apiKey: KEY })).toThrow(/query/);
    expect(() => new KeyClient({ baseUrl: 'https://me:pw@api.example.test', apiKey: KEY })).toThrow(
      /user name/,
    );
  });

  it('requires a key', () => {
    expect(() => new KeyClient({ baseUrl: 'https://api.example.test', apiKey: '' })).toThrow(/apiKey/);
  });
});

describe('what every request carries', () => {
  it('sends the key as a bearer token, and names the SDK and the contract in the User-Agent', async () => {
    server = await loopback({ status: 200, body: KEY_IDENTITY });
    const { atlas } = client(server.baseUrl, { userAgent: 'acme-lms/2.1' });
    await atlas.describeKey();

    const [request] = server.received;
    expect(request?.method).toBe('GET');
    expect(request?.url).toBe('/v1/key');
    expect(request?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(request?.headers['user-agent']).toBe(
      `atlas-sdk-typescript/${SDK_VERSION} (contract ${CONTRACT_VERSION}; node ${process.versions.node}) acme-lms/2.1`,
    );
  });

  it('encodes path values and repeats an array query parameter', async () => {
    server = await loopback({
      status: 200,
      body: { items: [], page: 0, size: 5, totalItems: 0, totalPages: 0 },
    });
    const { atlas } = client(server.baseUrl);
    await atlas.listResources({ status: ['READY', 'FAILED'], q: 'a b', size: 5 });
    expect(server.received[0]?.url).toBe(`/v1/o/${ORG}/resources?status=READY&status=FAILED&q=a+b&size=5`);

    await atlas.getResource('x/y').catch(() => undefined);
    expect(server.received[1]?.url).toBe(`/v1/o/${ORG}/resources/x%2Fy`);
  });

  it('resolves the organisation from describeKey once, when none is given', async () => {
    server = await loopback(
      { status: 200, body: KEY_IDENTITY },
      { status: 200, body: { items: [], nextCursor: null } },
    );
    const atlas = new KeyClient({ baseUrl: server.baseUrl, apiKey: KEY });
    await atlas.listEndUsers();
    await atlas.listEndUsers();
    expect(server.received.map((r) => r.url)).toEqual([
      '/v1/key',
      `/v1/o/${ORG}/end-users`,
      `/v1/o/${ORG}/end-users`,
    ]);
  });
});

describe('a 429', () => {
  it('is waited out for as long as Retry-After says, then sent again', async () => {
    server = await loopback(
      { status: 429, headers: { 'retry-after': '7' }, body: problem(429, 'ATLAS-SYS-004') },
      { status: 200, body: KEY_IDENTITY },
    );
    const events: string[] = [];
    const { atlas, sleeps } = client(server.baseUrl, {
      onRetry: (event) => events.push(`${event.reason}:${event.retryAfter}`),
    });
    await expect(atlas.describeKey()).resolves.toMatchObject({ orgId: ORG });
    expect(sleeps).toEqual([7000]);
    expect(events).toEqual(['throttled:7']);
    expect(server.received).toHaveLength(2);
  });

  it('is retried even on an operation that is never retried after a failure, because a throttled call did nothing', async () => {
    server = await loopback(
      { status: 429, headers: { 'retry-after': '1' }, body: problem(429, 'ATLAS-SYS-004') },
      { status: 200, body: { endorsements: [] } },
    );
    const { atlas } = client(server.baseUrl);
    await atlas.presentForEndUser(END_USER, { profile: {} as never });
    expect(server.received).toHaveLength(2);
  });

  it('is returned at once when it names no wait, since no wait would clear it', async () => {
    server = await loopback({ status: 429, body: problem(429, 'ATLAS-BIL-001') });
    const { atlas, sleeps } = client(server.baseUrl);
    const error = await atlas.describeKey().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AtlasApiError);
    expect((error as AtlasApiError).retryAfter).toBeUndefined();
    expect(sleeps).toEqual([]);
    expect(server.received).toHaveLength(1);
  });

  it('is returned when the wait it asks for is longer than the bound', async () => {
    server = await loopback({
      status: 429,
      headers: { 'retry-after': '3600' },
      body: problem(429, 'ATLAS-SYS-004'),
    });
    const { atlas } = client(server.baseUrl);
    await expect(atlas.describeKey()).rejects.toMatchObject({ status: 429, retryAfter: 3600, attempts: 1 });
  });
});

describe('a 5xx or a lost connection', () => {
  it('is retried for a repeatable read', async () => {
    server = await loopback(
      { status: 503, body: problem(503, 'ATLAS-SYS-001') },
      { status: 200, body: KEY_IDENTITY },
    );
    const { atlas, sleeps } = client(server.baseUrl);
    await atlas.describeKey();
    expect(server.received).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
  });

  it('is never retried for present, which counts every call against your usage', async () => {
    server = await loopback({ status: 503, body: problem(503, 'ATLAS-SYS-001') }, { status: 200, body: {} });
    const { atlas } = client(server.baseUrl);
    await expect(atlas.presentForEndUser(END_USER, { profile: {} as never })).rejects.toMatchObject({
      status: 503,
      attempts: 1,
    });
    expect(server.received).toHaveLength(1);
  });

  it('is never retried for present when the connection drops after the request was sent', async () => {
    server = await loopback({ drop: true }, { status: 200, body: {} });
    const { atlas } = client(server.baseUrl);
    const error = await atlas.presentForEndUser(END_USER, { profile: {} as never }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AtlasConnectionError);
    expect(error).toMatchObject({ attempts: 1, mayHaveReachedServer: true });
    expect(server.received).toHaveLength(1);
  });

  it('stops at maxAttempts', async () => {
    server = await loopback({ status: 502, body: problem(502, 'ATLAS-SYS-001') });
    const { atlas } = client(server.baseUrl, { retry: { maxAttempts: 2 } });
    await expect(atlas.describeKey()).rejects.toMatchObject({ status: 502, attempts: 2 });
    expect(server.received).toHaveLength(2);
  });
});

describe('linkEndUser, the one action with a repeat guard', () => {
  it('replays a lost response under the same Idempotency-Key, so the retry acts once', async () => {
    server = await loopback({ drop: true }, { status: 201, body: END_USER_BODY });
    const { atlas } = client(server.baseUrl);
    await expect(atlas.linkEndUser({ ref: 'learner-1' })).resolves.toMatchObject({ id: END_USER });

    expect(server.received).toHaveLength(2);
    const [first, second] = server.received;
    expect(first?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(second?.headers['idempotency-key']).toBe(first?.headers['idempotency-key']);
    expect(second?.body.equals(first?.body ?? Buffer.alloc(0))).toBe(true);
  });

  it('sends a key of your own when you give one', async () => {
    server = await loopback({ status: 201, body: END_USER_BODY });
    const { atlas } = client(server.baseUrl);
    await atlas.linkEndUser({ ref: 'learner-1' }, { idempotencyKey: 'order-4821-link' });
    expect(server.received[0]?.headers['idempotency-key']).toBe('order-4821-link');
  });

  it('waits and retries when its own retry finds the first call still in flight (ATLAS-DEV-010)', async () => {
    server = await loopback(
      { status: 503, body: problem(503, 'ATLAS-SYS-001') },
      { status: 409, body: problem(409, 'ATLAS-DEV-010') },
      { status: 201, body: END_USER_BODY },
    );
    const reasons: string[] = [];
    const { atlas } = client(server.baseUrl, { onRetry: (event) => reasons.push(event.reason) });
    await atlas.linkEndUser({ ref: 'learner-1' });
    expect(reasons).toEqual(['server-error', 'in-flight']);
    expect(new Set(server.received.map((r) => r.headers['idempotency-key'])).size).toBe(1);
  });

  it('does not retry ATLAS-DEV-010 on a first attempt: there, the key was reused for a different request', async () => {
    server = await loopback({ status: 409, body: problem(409, 'ATLAS-DEV-010') });
    const { atlas } = client(server.baseUrl);
    await expect(
      atlas.linkEndUser({ ref: 'learner-1' }, { idempotencyKey: 'reused-key-1' }),
    ).rejects.toMatchObject({
      errorCode: 'ATLAS-DEV-010',
      attempts: 1,
    });
  });
});

describe('a refusal', () => {
  it('carries the code to branch on, the request id to quote, and the rate-limit figures', async () => {
    server = await loopback({
      status: 403,
      headers: {
        'x-request-id': 'req-abc123',
        'ratelimit-limit': '600',
        'ratelimit-remaining': '598',
        'ratelimit-reset': '41',
      },
      body: problem(403, 'ATLAS-SYS-007', { detail: 'This key lacks usage:read' }),
    });
    const { atlas } = client(server.baseUrl);
    const error = (await atlas.developerUsage().catch((e: unknown) => e)) as AtlasApiError;
    expect(error).toBeInstanceOf(AtlasApiError);
    expect(error).toMatchObject({
      operationId: 'developerUsage',
      status: 403,
      errorCode: 'ATLAS-SYS-007',
      detail: 'This key lacks usage:read',
      requestId: 'req-abc123',
      rateLimit: { limit: 600, remaining: 598, resetSeconds: 41 },
    });
    expect(error.message).toContain('ATLAS-SYS-007');
  });

  it('carries the errorId of an unexpected 500, which is what to quote', async () => {
    server = await loopback({ status: 500, body: problem(500, 'ATLAS-SYS-001', { errorId: 'err-77' }) });
    const { atlas } = client(server.baseUrl, { retry: { maxAttempts: 1 } });
    await expect(atlas.describeKey()).rejects.toMatchObject({
      errorId: 'err-77',
      errorCode: 'ATLAS-SYS-001',
    });
  });

  it('survives a body that is not a problem document, and never echoes it', async () => {
    const html = '<html><body>HTTP Status 400 - Bad Request <script>x</script></body></html>';
    server = await loopback({ status: 400, headers: { 'content-type': 'text/html' }, raw: html });
    const { atlas } = client(server.baseUrl);
    const error = (await atlas.describeKey().catch((e: unknown) => e)) as AtlasApiError;
    expect(error.errorCode).toBeUndefined();
    expect(error.problem).toBeUndefined();
    expect(error.message).toContain('text/html');
    expect(error.message).not.toContain('<');
  });

  it('never carries the credential, in the message or anywhere on the error', async () => {
    server = await loopback({ status: 401, body: problem(401, 'ATLAS-SYS-002') });
    const { atlas } = client(server.baseUrl);
    const error = await atlas.describeKey().catch((e: unknown) => e);
    const everything = JSON.stringify(error, Object.getOwnPropertyNames(error as object)) + String(error);
    expect(everything).not.toContain(KEY);
  });
});

describe('a redirect', () => {
  it('is never followed, so the key never reaches another address', async () => {
    const elsewhere = await loopback({ status: 200, body: KEY_IDENTITY });
    try {
      server = await loopback({ status: 307, headers: { location: `${elsewhere.baseUrl}/v1/key` } });
      const { atlas } = client(server.baseUrl);
      const error = (await atlas.describeKey().catch((e: unknown) => e)) as AtlasApiError;
      expect(error).toBeInstanceOf(AtlasApiError);
      expect(error.status).toBe(307);
      expect(error.message).toMatch(/redirect/);
      expect(elsewhere.received).toHaveLength(0);
    } finally {
      await elsewhere.close();
    }
  });
});

describe('rate-limit state', () => {
  it('is what the last response reported', async () => {
    server = await loopback({
      status: 200,
      headers: { 'ratelimit-limit': '600', 'ratelimit-remaining': '12', 'ratelimit-reset': '9' },
      body: KEY_IDENTITY,
    });
    const { atlas } = client(server.baseUrl);
    expect(atlas.rateLimit).toBeUndefined();
    await atlas.describeKey();
    expect(atlas.rateLimit).toMatchObject({ limit: 600, remaining: 12, resetSeconds: 9 });
  });

  it('is unknown, not unlimited, when the headers are absent', async () => {
    server = await loopback({ status: 200, body: KEY_IDENTITY });
    const { atlas } = client(server.baseUrl);
    await atlas.describeKey();
    expect(atlas.rateLimit).toBeUndefined();
  });
});

describe('cancelling', () => {
  it('stops a call waiting to retry', async () => {
    server = await loopback({
      status: 429,
      headers: { 'retry-after': '30' },
      body: problem(429, 'ATLAS-SYS-004'),
    });
    const controller = new AbortController();
    const atlas = new KeyClient(
      { baseUrl: server.baseUrl, apiKey: KEY, orgId: ORG },
      {
        sleep: (_ms, signal) =>
          new Promise((_, reject) =>
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true }),
          ),
      },
    );
    const call = atlas.describeKey({ signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(call).rejects.toBeInstanceOf(AtlasConnectionError);
    expect(server.received).toHaveLength(1);
  });
});

describe('what is refused before anything is sent', () => {
  it('a credential a header cannot carry, without repeating it anywhere', async () => {
    server = await loopback({ status: 200, body: KEY_IDENTITY });
    for (const bad of [`${KEY}\r\nx: y`, `${KEY}\nwrapped`, `${KEY}\u0000`, `${KEY}é`]) {
      const atlas = new KeyClient({ baseUrl: server.baseUrl, apiKey: bad, orgId: ORG });
      const error = await atlas.describeKey().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AtlasConfigurationError);
      const everything = JSON.stringify(error, Object.getOwnPropertyNames(error as object)) + String(error);
      expect(everything).not.toContain(KEY);
    }
    expect(server.received).toHaveLength(0);
  });

  it('a user agent or an idempotency key a header cannot carry', async () => {
    server = await loopback({ status: 201, body: END_USER_BODY });
    expect(() => new KeyClient({ baseUrl: server!.baseUrl, apiKey: KEY, userAgent: 'app\r\nx: y' })).toThrow(
      AtlasConfigurationError,
    );
    const { atlas } = client(server.baseUrl);
    await expect(
      atlas.linkEndUser({ ref: 'r' }, { idempotencyKey: 'key\nwith-a-break' }),
    ).rejects.toBeInstanceOf(AtlasConfigurationError);
    expect(server.received).toHaveLength(0);
  });

  it('a path value of . or .., which a URL would resolve into a different route', async () => {
    server = await loopback({ status: 200, body: {} });
    const { atlas } = client(server.baseUrl);
    for (const id of ['.', '..']) {
      await expect(atlas.getResource(id)).rejects.toBeInstanceOf(AtlasConfigurationError);
      await expect(atlas.revokeEndUser(id)).rejects.toBeInstanceOf(AtlasConfigurationError);
    }
    expect(server.received).toHaveLength(0);
  });
});

describe('a body', () => {
  it('that stalls part-way is an AtlasConnectionError, not a platform error', async () => {
    const { createServer } = await import('node:http');
    const stalling = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
      response.write('{"keyId":');
    });
    await new Promise<void>((resolve) => stalling.listen(0, '127.0.0.1', resolve));
    const { port } = stalling.address() as import('node:net').AddressInfo;
    try {
      const atlas = new KeyClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: KEY, timeoutMs: 300 });
      const error = await atlas.describeKey().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AtlasConnectionError);
      expect(error).toMatchObject({ mayHaveReachedServer: true });
    } finally {
      stalling.closeAllConnections();
      await new Promise((resolve) => stalling.close(resolve));
    }
  });

  it('of a refusal larger than an API ever sends is not read in full, and not echoed', async () => {
    server = await loopback({
      status: 400,
      headers: { 'content-type': 'application/json' },
      raw: `"${'x'.repeat(200_000)}"`,
    });
    const { atlas } = client(server.baseUrl);
    const error = (await atlas.describeKey().catch((e: unknown) => e)) as AtlasApiError;
    expect(error).toBeInstanceOf(AtlasApiError);
    expect(error.problem).toBeUndefined();
    expect(error.message.length).toBeLessThan(500);
  });
});

describe('ATLAS-DEV-010 after a key you supplied', () => {
  it('is returned to you, because that key may have been used for something else', async () => {
    server = await loopback(
      { status: 503, body: problem(503, 'ATLAS-SYS-001') },
      { status: 409, body: problem(409, 'ATLAS-DEV-010') },
      { status: 201, body: END_USER_BODY },
    );
    const { atlas } = client(server.baseUrl);
    await expect(
      atlas.linkEndUser({ ref: 'learner-1' }, { idempotencyKey: 'supplied-key-1' }),
    ).rejects.toMatchObject({
      status: 409,
      errorCode: 'ATLAS-DEV-010',
      attempts: 2,
    });
    expect(server.received).toHaveLength(2);
  });
});
