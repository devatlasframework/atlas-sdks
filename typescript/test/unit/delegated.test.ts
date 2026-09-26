import { afterEach, describe, expect, it } from 'vitest';
import { PassClient } from '../../src/client.js';
import {
  DelegatedPass,
  authorizationUrl,
  createPkcePair,
  exchangeCode,
  pkceChallenge,
  type DelegatedPassResponse,
  type DelegatedPassSnapshot,
} from '../../src/delegated.js';
import {
  AtlasApiError,
  AtlasConfigurationError,
  AtlasConnectionError,
  RefreshRefusedError,
} from '../../src/errors.js';
import { loopback, problem, type Loopback } from './loopback.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = 'app_client_1234';
const T0 = new Date('2026-09-26T10:00:00Z');

function pass(n: number, expiresIn = 600): DelegatedPassResponse {
  return {
    access_token: `pass-${n}`,
    token_type: 'Bearer',
    expires_in: expiresIn,
    refresh_token: `refresh-${n}`,
    scope: 'content:read',
  };
}

let server: Loopback | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('PKCE', () => {
  it('derives the RFC 7636 appendix B challenge from its verifier', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('makes a 43-character verifier and the S256 challenge that goes with it', () => {
    const pair = createPkcePair();
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.challenge).toBe(pkceChallenge(pair.verifier));
    expect(pair.method).toBe('S256');
    expect(createPkcePair().verifier).not.toBe(pair.verifier);
  });

  it('refuses a verifier outside RFC 7636 section 4.1', () => {
    expect(() => pkceChallenge('too-short')).toThrow(AtlasConfigurationError);
    expect(() => pkceChallenge(`${'a'.repeat(43)} `)).toThrow(AtlasConfigurationError);
  });
});

describe('the consent URL', () => {
  it('carries every parameter the contract documents, and S256', () => {
    const url = new URL(
      authorizationUrl({
        webBaseUrl: 'https://learn.example.test/',
        clientId: CLIENT_ID,
        orgId: ORG,
        redirectUri: 'http://127.0.0.1:53682/callback',
        scopes: ['content:read'],
        state: 'st-1',
        codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://learn.example.test/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      org_id: ORG,
      redirect_uri: 'http://127.0.0.1:53682/callback',
      scope: 'content:read',
      state: 'st-1',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
    });
  });

  it('separates scopes with an encoded space', () => {
    const url = authorizationUrl({
      webBaseUrl: 'https://learn.example.test',
      clientId: CLIENT_ID,
      orgId: ORG,
      redirectUri: 'https://app.example.test/cb',
      scopes: ['content:read', 'usage:read'],
      state: 's',
      codeChallenge: 'c',
    });
    expect(url).toContain('scope=content%3Aread%20usage%3Aread');
  });

  it('refuses a web address over plain http off loopback, and a missing parameter', () => {
    const base = {
      clientId: CLIENT_ID,
      orgId: ORG,
      redirectUri: 'https://a.test/cb',
      scopes: ['content:read'],
      state: 's',
      codeChallenge: 'c',
    };
    expect(() => authorizationUrl({ ...base, webBaseUrl: 'http://learn.example.test' })).toThrow(/https/);
    expect(() => authorizationUrl({ ...base, webBaseUrl: 'https://learn.example.test', state: '' })).toThrow(
      /state/,
    );
  });
});

describe('the token leg', () => {
  it('sends camelCase, reads snake_case, and renames nothing on the wire', async () => {
    server = await loopback({ status: 200, body: pass(1) });
    const delegated = await exchangeCode(
      {
        baseUrl: server.baseUrl,
        clientId: CLIENT_ID,
        code: 'code-1',
        redirectUri: 'http://127.0.0.1:53682/callback',
        codeVerifier: 'v'.repeat(43),
      },
      { now: () => T0 },
    );

    const [request] = server.received;
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('/v1/oauth/token');
    expect(request?.headers.authorization).toBeUndefined();
    expect(request?.headers['content-type']).toBe('application/json');
    expect(request?.body.toString('utf8')).toBe(
      JSON.stringify({
        grantType: 'authorization_code',
        code: 'code-1',
        redirectUri: 'http://127.0.0.1:53682/callback',
        codeVerifier: 'v'.repeat(43),
        clientId: CLIENT_ID,
      }),
    );
    expect(delegated.accessToken).toBe('pass-1');
    expect(delegated.scope).toBe('content:read');
    expect(delegated.expiresAt.toISOString()).toBe('2026-09-26T10:10:00.000Z');
  });

  it('is never retried after a 5xx: a code works once', async () => {
    server = await loopback(
      { status: 503, body: problem(503, 'ATLAS-SYS-001') },
      { status: 200, body: pass(1) },
    );
    await expect(
      exchangeCode({
        baseUrl: server.baseUrl,
        clientId: CLIENT_ID,
        code: 'c',
        redirectUri: 'https://a.test/cb',
        codeVerifier: 'v'.repeat(43),
      }),
    ).rejects.toBeInstanceOf(AtlasApiError);
    expect(server.received).toHaveLength(1);
  });
});

describe('renewing a pass', () => {
  async function held(response = pass(1), clock = () => T0) {
    return DelegatedPass.fromResponse(
      response,
      { baseUrl: server!.baseUrl, clientId: CLIENT_ID },
      { now: clock },
    );
  }

  it('sends the refresh token camelCase and rotates both tokens', async () => {
    server = await loopback({ status: 200, body: pass(2) });
    const delegated = await held();
    await delegated.refresh();
    expect(JSON.parse(server.received[0]!.body.toString('utf8'))).toEqual({
      grantType: 'refresh_token',
      refreshToken: 'refresh-1',
      clientId: CLIENT_ID,
    });
    expect(delegated.accessToken).toBe('pass-2');
    expect(delegated.snapshot().refreshToken).toBe('refresh-2');
  });

  it('keeps the live pass when the renewal is refused, and never presents the refused token again', async () => {
    server = await loopback({ status: 400, body: problem(400, 'ATLAS-DEV-014') });
    const delegated = await held();
    const error = (await delegated.refresh().catch((e: unknown) => e)) as RefreshRefusedError;
    expect(error).toBeInstanceOf(RefreshRefusedError);
    expect(error.refusal).toBeInstanceOf(AtlasApiError);
    expect((error.refusal as AtlasApiError).errorCode).toBe('ATLAS-DEV-014');
    expect(error.stillValidUntil.toISOString()).toBe('2026-09-26T10:10:00.000Z');
    expect(delegated.accessToken).toBe('pass-1');
    expect(delegated.renewable).toBe(false);

    await expect(delegated.refresh()).rejects.toThrow(/cannot be renewed/);
    expect(server.received).toHaveLength(1);
  });

  it('is never retried after a lost connection, and keeps the token for you to decide about', async () => {
    server = await loopback({ drop: true }, { status: 200, body: pass(2) });
    const delegated = await held();
    const error = (await delegated.refresh().catch((e: unknown) => e)) as RefreshRefusedError;
    expect(error.refusal).toBeInstanceOf(AtlasConnectionError);
    expect(server.received).toHaveLength(1);
    expect(delegated.renewable).toBe(true);
    expect(delegated.accessToken).toBe('pass-1');
  });

  it('runs one renewal when two are asked for at once, because a refresh token works once', async () => {
    server = await loopback({ status: 200, body: pass(2) });
    const delegated = await held();
    await Promise.all([delegated.refresh(), delegated.refresh()]);
    expect(server.received).toHaveLength(1);
  });

  it('renews before use near expiry, and uses the live pass if that renewal is refused', async () => {
    server = await loopback({ status: 400, body: problem(400, 'ATLAS-DEV-014') });
    let now = T0;
    const delegated = await held(pass(1, 60), () => now);
    now = new Date(T0.getTime() + 45_000); // 15 s before expiry: inside the renewal margin
    await expect(delegated.currentAccessToken()).resolves.toBe('pass-1');
    expect(server.received).toHaveLength(1);

    now = new Date(T0.getTime() + 61_000); // expired, and nothing left to renew with
    expect(delegated.isExpired()).toBe(true);
  });

  it('round-trips through a snapshot', async () => {
    server = await loopback({ status: 200, body: pass(2) });
    const snapshot = (await held()).snapshot();
    const restored = DelegatedPass.restore(snapshot, { baseUrl: server.baseUrl, clientId: CLIENT_ID });
    expect(restored.accessToken).toBe('pass-1');
    expect(restored.expiresAt.toISOString()).toBe(snapshot.expiresAt);
  });
});

describe('PassClient', () => {
  it('sends the pass it holds, and reads as the person', async () => {
    server = await loopback({
      status: 200,
      body: { items: [], page: 0, size: 24, totalItems: 0, totalPages: 0 },
    });
    const delegated = DelegatedPass.fromResponse(pass(9), { baseUrl: server.baseUrl, clientId: CLIENT_ID });
    const asLearner = new PassClient({ baseUrl: server.baseUrl, orgId: ORG, pass: delegated });
    await asLearner.listResources();
    expect(server.received[0]?.headers.authorization).toBe('Bearer pass-9');
    expect(server.received[0]?.url).toBe(`/v1/o/${ORG}/resources`);
  });

  it('requires the organisation the person consented for', () => {
    expect(() => new PassClient({ baseUrl: 'https://api.example.test', pass: 'p' } as never)).toThrow(
      /orgId/,
    );
  });
});

describe('a renewal that fails for a reason other than refusal', () => {
  function heldAt(clock: () => Date, onRenewed?: (snapshot: DelegatedPassSnapshot) => Promise<void> | void) {
    return DelegatedPass.fromResponse(
      pass(1, 60),
      { baseUrl: server!.baseUrl, clientId: CLIENT_ID, ...(onRenewed ? { onRenewed } : {}) },
      { now: clock },
    );
  }

  it('keeps the refresh token after a 429: a throttled renewal spent nothing', async () => {
    server = await loopback(
      { status: 429, body: problem(429, 'ATLAS-SYS-004') },
      { status: 200, body: pass(2) },
    );
    let now = T0;
    const delegated = heldAt(() => now);
    await expect(delegated.refresh()).rejects.toBeInstanceOf(RefreshRefusedError);
    expect(delegated.renewable).toBe(true);
    expect(delegated.renewalOutcomeUnknown).toBe(false);

    now = new Date(T0.getTime() + 45_000); // inside the margin: renewal is tried again, and lands
    await expect(delegated.currentAccessToken()).resolves.toBe('pass-2');
  });

  it('never presents the token again on its own after a 5xx, until you call refresh()', async () => {
    server = await loopback(
      { status: 503, body: problem(503, 'ATLAS-SYS-001') },
      { status: 200, body: pass(2) },
    );
    let now = T0;
    const delegated = heldAt(() => now);
    await expect(delegated.refresh()).rejects.toBeInstanceOf(RefreshRefusedError);
    expect(delegated.renewable).toBe(true);
    expect(delegated.renewalOutcomeUnknown).toBe(true);

    now = new Date(T0.getTime() + 45_000);
    await expect(delegated.currentAccessToken()).resolves.toBe('pass-1');
    await expect(delegated.currentAccessToken()).resolves.toBe('pass-1');
    expect(server.received).toHaveLength(1);

    await delegated.refresh(); // your decision to try the token again
    expect(server.received).toHaveLength(2);
    expect(delegated.accessToken).toBe('pass-2');
    expect(delegated.renewalOutcomeUnknown).toBe(false);
  });

  it('never presents the token again on its own after a dropped connection', async () => {
    server = await loopback({ drop: true }, { status: 200, body: pass(2) });
    let now = T0;
    const delegated = heldAt(() => now);
    await expect(delegated.refresh()).rejects.toBeInstanceOf(RefreshRefusedError);
    expect(delegated.renewalOutcomeUnknown).toBe(true);
    now = new Date(T0.getTime() + 45_000);
    await delegated.currentAccessToken();
    await delegated.currentAccessToken();
    expect(server.received).toHaveLength(1);
  });

  it('hands the renewed pass to onRenewed, and waits for it before the new token is used', async () => {
    server = await loopback({ status: 200, body: pass(2) });
    const order: string[] = [];
    const delegated = heldAt(
      () => T0,
      async (snapshot) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push(`stored ${snapshot.accessToken} ${snapshot.refreshToken}`);
      },
    );
    await delegated.refresh();
    order.push(`using ${delegated.accessToken}`);
    expect(order).toEqual(['stored pass-2 refresh-2', 'using pass-2']);
  });
});
