import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KeyClient, PassClient, type EndUser, type LearnerProfile } from '../../src/client.js';
import { DelegatedPass, authorizationUrl, createPkcePair, exchangeCode } from '../../src/delegated.js';
import { AtlasApiError, RefreshRefusedError, WebhookVerificationError } from '../../src/errors.js';
import { OPERATIONS } from '../../src/generated/surface.js';
import type { ClientOptions, OperationId, ResponseEvent, RetryEvent } from '../../src/transport.js';
import { VERSIONS } from '../../src/version.js';
import { verifyWebhook } from '../../src/webhooks.js';

// The live suite: ../scenarios/live.json, executed against a deployed API. Configuration comes from
// the environment, or from typescript/.env.live (never committed). Credentials are only ever sent
// to ATLAS_BASE_URL, and none appears in the transcript this writes to live-results/.
//
//   NODE_EXTRA_CA_CERTS=<your CA, if the API's certificate is not publicly trusted> npm run test:live

interface Scenario {
  readonly id: string;
  readonly operations: readonly OperationId[];
  readonly expect: string;
}
interface ScenarioFile {
  readonly requires: Record<string, string>;
  readonly scenarios: readonly Scenario[];
}

const spec = JSON.parse(
  readFileSync(new URL('../../../scenarios/live.json', import.meta.url), 'utf8'),
) as ScenarioFile;
const { profile } = JSON.parse(
  readFileSync(new URL('../../../scenarios/fixtures/profile-scored.json', import.meta.url), 'utf8'),
) as { profile: LearnerProfile };

const envFile = new URL('../../.env.live', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);
const missing = Object.keys(spec.requires).filter((name) => !process.env[name]);
const env = (name: string): string => process.env[name] ?? '';

const exercised = new Map<string, Set<OperationId>>();
const transcript: Record<string, unknown>[] = [];
const results: Record<string, unknown> = {};
let current = '';

function observe(event: ResponseEvent): void {
  exercised.get(current)?.add(event.operationId);
  transcript.push({
    scenario: current,
    operationId: event.operationId,
    attempt: event.attempt,
    status: event.status,
    requestId: event.requestId,
  });
}

function keyClient(extra: Partial<ClientOptions> = {}): KeyClient {
  return new KeyClient({
    baseUrl: env('ATLAS_BASE_URL'),
    apiKey: env('ATLAS_API_KEY'),
    userAgent: 'atlas-sdks-live-suite',
    onResponse: observe,
    ...extra,
  });
}

const shared: { orgId?: string; appId?: string; endUser?: EndUser } = {};

/** Serves ATLAS_REDIRECT_URI until the consent page sends the person back, and returns the code. */
function waitForConsent(consentUrl: string, expectedState: string): Promise<string> {
  const redirect = new URL(env('ATLAS_REDIRECT_URI'));
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', redirect);
      if (url.pathname !== redirect.pathname) {
        response.writeHead(404).end();
        return;
      }
      const finish = (outcome: string) => {
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(`${outcome} You can close this tab and return to the terminal.`);
        server.close();
      };
      if (url.searchParams.get('state') !== expectedState) {
        finish('The state did not match, so this answer was ignored.');
        reject(new Error('the consent page answered with a state this run did not send'));
      } else if (url.searchParams.get('error')) {
        finish('Consent was not given.');
        reject(new Error(`the consent page answered ${url.searchParams.get('error')}`));
      } else {
        finish('Consent received.');
        resolve(url.searchParams.get('code') ?? '');
      }
    });
    server.listen(Number(redirect.port || 80), redirect.hostname, () => {
      mkdirSync(new URL('../../live-results/', import.meta.url), { recursive: true });
      writeFileSync(new URL('../../live-results/consent-url.txt', import.meta.url), `${consentUrl}\n`);
      console.log(`\n  CONSENT NEEDED - sign in and choose Allow at:\n  ${consentUrl}\n`);
    });
    setTimeout(
      () => {
        server.close();
        reject(new Error('nobody answered the consent page within 10 minutes'));
      },
      10 * 60 * 1000,
    ).unref();
  });
}

const run: Record<string, () => Promise<void>> = {
  async 'describe-key'() {
    const key = await keyClient().describeKey();
    expect(key.scopes).toEqual(
      expect.arrayContaining(['content:read', 'end-users:manage', 'ai:use', 'usage:read']),
    );
    shared.orgId = key.orgId;
    shared.appId = key.appId;
    results['describe-key'] = {
      orgId: key.orgId,
      appId: key.appId,
      scopes: key.scopes,
      expiresAt: key.expiresAt,
    };
  },

  async 'read-named-content'() {
    const atlas = keyClient();
    const page = await atlas.listResources({ status: ['READY'], size: 10 });
    const named = page.items.find((resource) => resource.status === 'READY' && resource.title);
    expect(named, 'a READY resource with a title, not an empty list').toBeDefined();
    const one = await atlas.getResource(named!.id);
    expect(one).toMatchObject({ id: named!.id, title: named!.title });
    const download = await atlas.getResourceDownload(named!.id);
    expect(download.downloadUrl).toMatch(/^https?:\/\//);
    expect(download.filename).not.toBe('');
    // The download address is itself a credential for the file, so it is never written down.
    results['read-named-content'] = {
      totalReady: page.totalItems,
      resource: { id: one.id, title: one.title, status: one.status, versionNumber: one.versionNumber },
      download: { filename: download.filename, expiresAt: download.expiresAt },
    };
  },

  async 'link-retried-under-one-key'() {
    const keys: string[] = [];
    let dropped = false;
    const faulty: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const isLink = init?.method === 'POST' && String(input).endsWith('/end-users');
      if (isLink) keys.push(new Headers(init?.headers).get('idempotency-key') ?? '');
      if (isLink && !dropped) {
        dropped = true;
        await response.arrayBuffer();
        throw new TypeError('fault injected: the API answered, and the answer was discarded');
      }
      return response;
    };
    const atlas = keyClient({ fetch: faulty });
    const ref = `sdk-live-${Date.now()}`;
    const before = (await atlas.listEndUsers()).items.filter((endUser) => endUser.active).length;

    const endUser = await atlas.linkEndUser({ ref });
    expect(keys, 'two attempts').toHaveLength(2);
    expect(keys[1], 'one Idempotency-Key across both').toBe(keys[0]);

    const after = await atlas.listEndUsers();
    expect(after.items.filter((one) => one.active)).toHaveLength(before + 1);
    expect(after.items.filter((one) => one.id === endUser.id)).toHaveLength(1);

    const conflict = await atlas
      .linkEndUser({ ref: `${ref}-other` }, { idempotencyKey: keys[0]! })
      .catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(AtlasApiError);
    expect(conflict).toMatchObject({ status: 409, errorCode: 'ATLAS-DEV-010' });

    shared.endUser = endUser;
    results['link-retried-under-one-key'] = {
      attempts: 2,
      sameKey: keys[0] === keys[1],
      activeLinks: { before, after: before + 1 },
      endUserId: endUser.id,
      sameKeyDifferentBody: {
        status: (conflict as AtlasApiError).status,
        errorCode: (conflict as AtlasApiError).errorCode,
      },
    };
  },

  async 'present-both-shapes'() {
    const plan = await keyClient().presentForEndUser(shared.endUser!.id, { profile });
    // An endorsement's key is `<sub-dimension>.<category or pole>`, such as `D2a.Quiet`; its
    // `dimension` is the top-level one (`OD2`), so the shape is read through the key.
    const shapeOf = (key: string) =>
      profile.subDimensionScores[key.slice(0, key.indexOf('.'))]?.structureType;
    const endorsed = plan.endorsements.map((endorsement) => ({
      key: endorsement.key,
      shape: shapeOf(endorsement.key),
    }));
    expect(
      endorsed.some((one) => one.shape === 'bipolar'),
      'an endorsement from a bipolar sub-dimension',
    ).toBe(true);
    expect(
      endorsed.some((one) => one.shape === 'multi-category'),
      'and one from a multi-category one',
    ).toBe(true);
    results['present-both-shapes'] = { endorsements: endorsed.map((one) => `${one.key} (${one.shape})`) };
  },

  async usage() {
    const usage = await keyClient().developerUsage();
    expect(
      usage.apps.some((app) => app.appId === shared.appId),
      "the key's own application",
    ).toBe(true);
    results.usage = {
      periodStart: usage.periodStart,
      periodEnd: usage.periodEnd,
      calls: usage.calls,
      state: usage.state,
    };
  },

  async 'revoke-link'() {
    const revoked = await keyClient().revokeEndUser(shared.endUser!.id);
    expect(revoked).toMatchObject({ id: shared.endUser!.id, active: false });
    expect(revoked.revokedAt).toBeTruthy();
    results['revoke-link'] = { active: revoked.active, revokedAt: revoked.revokedAt };
  },

  async 'delegated-grant'() {
    const baseUrl = env('ATLAS_BASE_URL');
    const orgId = env('ATLAS_PASS_ORG_ID');
    const options = { baseUrl, clientId: env('ATLAS_CLIENT_ID'), onResponse: observe };
    const pkce = createPkcePair();
    const state = randomUUID();
    const consentUrl = authorizationUrl({
      webBaseUrl: env('ATLAS_WEB_URL'),
      clientId: env('ATLAS_CLIENT_ID'),
      orgId,
      redirectUri: env('ATLAS_REDIRECT_URI'),
      scopes: ['content:read'],
      state,
      codeChallenge: pkce.challenge,
    });
    const code = await waitForConsent(consentUrl, state);
    const pass = await exchangeCode({
      ...options,
      code,
      redirectUri: env('ATLAS_REDIRECT_URI'),
      codeVerifier: pkce.verifier,
    });

    const asPerson = new PassClient({ baseUrl, orgId, pass, onResponse: observe });
    const page = await asPerson.listResources({ size: 5 });
    const first = page.items[0];
    expect(first, 'the person can read at least one resource').toBeDefined();
    await asPerson.getResource(first!.id);
    await asPerson.getResourceDownload(first!.id);

    const beforeRefresh = pass.snapshot();
    await pass.refresh();
    expect(pass.accessToken).not.toBe(beforeRefresh.accessToken);

    const spent = DelegatedPass.restore(beforeRefresh, options);
    const refused = await spent.refresh().catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(RefreshRefusedError);
    expect((refused as RefreshRefusedError).refusal).toMatchObject({
      status: 400,
      errorCode: 'ATLAS-DEV-014',
    });

    // A refused renewal leaves a live pass live: the one issued before the refresh still reads.
    const stillLive = await new PassClient({
      baseUrl,
      orgId,
      pass: spent,
      onResponse: observe,
    }).listResources({ size: 1 });
    expect(stillLive.items.length).toBeGreaterThan(0);

    results['delegated-grant'] = {
      scope: pass.scope,
      passReads: { resources: page.totalItems, resourceId: first!.id },
      refreshed: true,
      spentRefreshToken: { status: 400, errorCode: 'ATLAS-DEV-014' },
      passIssuedBeforeRefreshStillReads: true,
    };
  },

  async 'webhook-from-the-real-sender'() {
    const url = new URL(env('ATLAS_WEBHOOK_CAPTURE_URL'));
    url.searchParams.set('sorting', 'newest');
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    expect(response.status, "the receiver's request log").toBe(200);
    const log = (await response.json()) as {
      data?: { content?: string; created_at?: string; headers?: Record<string, string[]> }[];
    };
    const header = (entry: { headers?: Record<string, string[]> }, name: string) =>
      entry.headers?.[name]?.[0];
    const delivery = (log.data ?? []).find((entry) => header(entry, 'atlas-signature'));
    expect(delivery, "a delivery from ATLAS in the receiver's log").toBeDefined();

    const signature = header(delivery!, 'atlas-signature')!;
    const arrived = new Date(`${delivery!.created_at!.replace(' ', 'T')}Z`);
    const event = verifyWebhook(delivery!.content ?? '', signature, env('ATLAS_WEBHOOK_SECRET'), {
      now: arrived,
    });

    const tampered = Buffer.from(delivery!.content ?? '', 'utf8');
    tampered[tampered.length - 2] = tampered[tampered.length - 2]! ^ 0x01;
    expect(() => verifyWebhook(tampered, signature, env('ATLAS_WEBHOOK_SECRET'), { now: arrived })).toThrow(
      WebhookVerificationError,
    );

    // A delivery that verifies proves who signed it, not which environment sent it: a capture left
    // in the receiver by another environment, with the same secret, would verify too. So it must be
    // recent, and it must be about a resource the environment under test actually holds.
    const ageHours = (Date.now() - arrived.getTime()) / 3_600_000;
    expect(ageHours, 'the delivery arrived within the last 24 hours').toBeLessThan(24);
    const about = await keyClient().getResource(event.data.resource_id);
    expect(about.id, 'the delivery names a resource this environment holds').toBe(event.data.resource_id);

    results['webhook-from-the-real-sender'] = {
      deliveryId: event.delivery_id,
      type: event.type,
      resource: { id: about.id, title: about.title },
      ageHours: Math.round(ageHours * 10) / 10,
      arrived: arrived.toISOString(),
      signedAt: new Date(Number(/(?:^|,)t=(\d+)/.exec(signature)?.[1]) * 1000).toISOString(),
      attempt: header(delivery!, 'atlas-delivery-attempt'),
      oneByteChanged: 'refused',
    };
  },

  async 'throttled-and-honoured'() {
    const retries: RetryEvent[] = [];
    const atlas = keyClient({ onRetry: (event) => retries.push(event), retry: { maxRetryAfterSeconds: 90 } });
    let calls = 0;
    const started = Date.now();
    while (!retries.some((retry) => retry.reason === 'throttled') && calls < 1500) {
      await atlas.describeKey();
      calls += 1;
    }
    const throttled = retries.find((retry) => retry.reason === 'throttled');
    expect(throttled, 'a 429 within 1500 calls').toBeDefined();
    expect(throttled!.status).toBe(429);
    expect(throttled!.retryAfter).toBeGreaterThan(0);
    expect(throttled!.delayMs).toBeGreaterThanOrEqual(throttled!.retryAfter! * 1000);
    results['throttled-and-honoured'] = {
      callsUntilThrottled: calls,
      retryAfter: throttled!.retryAfter,
      waitedMs: throttled!.delayMs,
      requestId: throttled!.requestId,
      thenSucceeded: true,
      seconds: Math.round((Date.now() - started) / 1000),
    };
  },
};

describe('the live scenarios', () => {
  beforeAll(() => {
    if (missing.length > 0) {
      throw new Error(
        `the live suite needs ${missing.join(', ')} - see scenarios/live.json. It fails rather than skips: ` +
          'a live run that never reached the API would prove nothing.',
      );
    }
  });

  for (const scenario of spec.scenarios) {
    it(scenario.id, async () => {
      const implementation = run[scenario.id];
      if (!implementation) throw new Error(`this runner does not implement the scenario "${scenario.id}"`);
      current = scenario.id;
      exercised.set(scenario.id, new Set());
      await implementation();
      const seen = [...(exercised.get(scenario.id) ?? [])];
      for (const operation of scenario.operations)
        expect(seen, `${scenario.id} calls ${operation}`).toContain(operation);
    });
  }

  it('called every operation this SDK covers, on the deployed API', () => {
    const called = new Set([...exercised.values()].flatMap((seen) => [...seen]));
    expect([...called].sort()).toEqual(Object.keys(OPERATIONS).sort());
    expect(transcript.length, 'responses received').toBeGreaterThan(0);
  });

  afterAll(() => {
    const report = {
      ranAt: new Date().toISOString(),
      baseUrl: env('ATLAS_BASE_URL'),
      versions: VERSIONS,
      results,
      responses: transcript.length,
      transcript,
    };
    mkdirSync(new URL('../../live-results/', import.meta.url), { recursive: true });
    const file = new URL(
      `../../live-results/run-${report.ranAt.replace(/[:.]/g, '-')}.json`,
      import.meta.url,
    );
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    console.log(
      `\n  live results: ${JSON.stringify({ versions: VERSIONS, responses: transcript.length, results }, null, 2)}\n`,
    );
  });
});
