# ATLAS SDK (TypeScript)

The TypeScript client for the ATLAS API (`/v1`): call it with an API key, act as a person who
consented with a delegated pass, and verify the webhooks ATLAS sends you.

- TS strict and ESM only, for Node 22 and later. No runtime dependencies.
- Generated from the ATLAS API contract, and it covers exactly what a developer's credentials can
  call. A client built with a key has the key's operations; a client built with a pass has the
  pass's. Calling anything else is a type error, not a `403`.
- Version `0.1.0`, not released yet. See the repository README for where releases will come from.

## Quick start

```ts
import { KeyClient, AtlasApiError } from '@devatlasframework/sdk';

const atlas = new KeyClient({
  baseUrl: process.env.ATLAS_BASE_URL!, // the API address you were given - there is no default
  apiKey: process.env.ATLAS_API_KEY!, // a server-side secret: never ship it to a browser
});

const key = await atlas.describeKey();
console.log(`key for organisation ${key.orgId}, with ${key.scopes.join(', ')}`);

try {
  const page = await atlas.listResources({ status: ['READY'] });
  for (const lecture of page.items) console.log(lecture.id, lecture.title);
} catch (error) {
  if (error instanceof AtlasApiError && error.errorCode === 'ATLAS-SYS-007') {
    console.error('this key lacks content:read');
  } else {
    throw error;
  }
}
```

`baseUrl` is required and is the address the API is served from, without `/v1`. It must be `https`;
plain `http` is accepted only for a loopback address (`localhost`, `127.0.0.1`, `[::1]`).

## What each operation does, and how it is retried

| Method                               | Needs              | After a `5xx` or a dropped connection                   |
| ------------------------------------ | ------------------ | ------------------------------------------------------- |
| `describeKey()`                      | nothing            | retried                                                 |
| `listEndUsers()`                     | `end-users:manage` | retried                                                 |
| `linkEndUser({ ref })`               | `end-users:manage` | retried under one `Idempotency-Key`, so it acts once    |
| `revokeEndUser(id)`                  | `end-users:manage` | retried: revoking a revoked link answers with that link |
| `presentForEndUser(id, { profile })` | `ai:use`           | **never retried**: every call counts in your usage      |
| `developerUsage()`                   | `usage:read`       | retried                                                 |
| `listResources(query)`               | `content:read`     | retried                                                 |
| `getResource(id)`                    | `content:read`     | retried                                                 |
| `getResourceDownload(id)`            | `content:read`     | retried                                                 |

A `PassClient` has the last three only. `KeyClient` works out your organisation with `describeKey`
on first use, unless you pass `orgId`.

These rules are not written here by hand. Each operation's class comes from the contract: an
idempotent method is repeatable, an operation declaring `Idempotency-Key` is repeatable under one
key, and anything else is sent once.

## Errors

Every refusal is an `AtlasApiError`. **Branch on `errorCode`**: it is on every refusal and names one
cause exactly, and a code is never removed or reused once published. `ERROR_CODES` lists every code
the operations here document, and `KnownErrorCode` is their type.

| Field                       | What it is                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `errorCode`                 | What to branch on. Absent only when something in front of the API refused the request |
| `status`, `title`, `detail` | The HTTP status and the problem document's own words                                  |
| `errors`                    | For a validation refusal: each field refused, and why                                 |
| `requestId`                 | `X-Request-Id`: quote it in a support report, whatever the status                     |
| `errorId`                   | On an unexpected `500`: identifies that one failure                                   |
| `retryAfter`                | `Retry-After`, in seconds. Absent on a refusal no wait would clear                    |
| `attempts`                  | How many attempts were made, the first included                                       |

When no response arrives at all, the error is an `AtlasConnectionError`. Its `mayHaveReachedServer`
tells you whether the request may have been processed. A credential never appears on either error.

## Retries

- **A `429` is waited out** for as long as its `Retry-After` says, then sent again, on every
  operation: a throttled request did nothing. A `429` with no `Retry-After` is returned at once,
  because it reports something waiting will not clear, such as an exhausted credit allowance.
- **A `5xx` or a dropped connection** is retried with backoff, but only where a retry cannot act
  twice (see the table).
- **`linkEndUser` carries one `Idempotency-Key` on every attempt.** The API answers a retry with the
  first attempt's outcome. The SDK generates the key per call. Pass `{ idempotencyKey }` yourself to
  make a retry that crosses a process restart act once too.
- **Every bound is the SDK's own:** `retry.maxAttempts` (3), `retry.maxRetryAfterSeconds` (60) and
  the backoff delays. ATLAS promises no window within which a repeated key is recognised, so keep
  retries of one logical call close together.

```ts
const atlas = new KeyClient({
  baseUrl,
  apiKey,
  retry: { maxAttempts: 5 },
  onRetry: (event) => log.warn(`${event.operationId} ${event.reason}, retrying in ${event.delayMs} ms`),
});
```

## Rate limits

`client.rateLimit` is your overall request-rate budget as the last response reported it:
`{ limit, remaining, resetSeconds, observedAt }`. It is `undefined` when no response has reported
one. **`undefined` does not mean unlimited:** ATLAS omits the figures when it cannot count, rather
than report ones it cannot stand behind.

Diagnose a refusal from the error's `retryAfter` and `errorCode`, never from `remaining`. A narrower
per-operation limit can refuse you while your overall figures still read healthy.

## Acting as a person: delegated passes

A person signs in to ATLAS, reads what you are asking for, and approves it. You then call the API
as them, limited to what they approved - today, reading their organisation's content.

```ts
import { randomUUID } from 'node:crypto';
import { PassClient, authorizationUrl, createPkcePair, exchangeCode } from '@devatlasframework/sdk';

// 1. Send the person to the consent page. Keep the verifier and the state with their session.
const pkce = createPkcePair();
const state = randomUUID();
const consent = authorizationUrl({
  webBaseUrl: process.env.ATLAS_WEB_URL!, // where people sign in: not the API's address
  clientId,
  orgId,
  redirectUri: 'https://app.example.test/atlas/callback', // exactly as registered on your application
  scopes: ['content:read'],
  state,
  codeChallenge: pkce.challenge,
});

// 2. On your redirectUri: check `state`, then exchange the code at once - it lasts about a minute.
const pass = await exchangeCode({ baseUrl, clientId, code, redirectUri, codeVerifier: pkce.verifier });

// 3. Call the API as them. The pass renews itself shortly before it expires.
const asPerson = new PassClient({ baseUrl, orgId, pass });
const page = await asPerson.listResources();
```

The token exchange takes JSON: its request is camelCase and its answer snake_case, on purpose, so an
off-the-shelf OAuth2 client will not work against it. `exchangeCode` and `DelegatedPass` speak it.

**Renewal follows the token exchange's rules.** A refresh token works once, and presenting a spent
one is treated as theft, which revokes every renewal token under the grant. So:

- two renewals never run at once in one process;
- every failed renewal throws `RefreshRefusedError` and leaves the pass you hold usable until
  `stillValidUntil`;
- a refused renewal (`400`) drops the refresh token for good. After the pass expires, send the
  person through consent again;
- a throttled renewal (`429`) spent nothing, and is tried again near expiry;
- a renewal that failed in a way that may have reached ATLAS - a `5xx`, a redirect, a lost
  connection - sets `renewalOutcomeUnknown`, and the SDK never presents that token again on its
  own. Calling `pass.refresh()` yourself is the decision to try it.

**One grant belongs to one process.** To keep a pass across restarts, persist it from
`onRenewed`, which is awaited after every renewal before the new token is used. A snapshot taken
before a renewal holds a spent refresh token, and so does one that two processes both restore:
presenting it revokes the grant.

```ts
const options = { baseUrl, clientId, onRenewed: (snapshot) => store.save(personId, snapshot) };
const pass = DelegatedPass.restore(await store.load(personId), options); // or exchangeCode({ ...options, ... })
```

Store the snapshot like a password: it can be renewed.

## Webhooks

```ts
import express from 'express';
import { SIGNATURE_HEADER, WebhookVerificationError, verifyWebhook } from '@devatlasframework/sdk';

app.post('/atlas/webhooks', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const event = verifyWebhook(req.body, req.get(SIGNATURE_HEADER), process.env.ATLAS_WEBHOOK_SECRET!);
    await deliveries.recordOnce(event); // durably, keyed on event.delivery_id - then answer
    res.sendStatus(204); // ATLAS never re-sends a delivery you answered 2xx
  } catch (error) {
    if (error instanceof WebhookVerificationError) res.status(400).send(error.reason);
    else throw error;
  }
});
```

- **Pass the raw body,** the exact bytes received. Parsing and re-serialising changes them, and
  the signature covers the bytes.
- **During a secret rotation** ATLAS signs with both secrets. Pass both, or just yours; every
  signature is tried against every secret.
- **The signed timestamp must be within 300 seconds** of your clock, checked on the timestamp that
  produced the match.
- **Delivery is at least once.** A retry carries the same `delivery_id`, so record it and skip a
  delivery you have already handled.

## Versions

`SDK_VERSION` is this package's own version. `CONTRACT_VERSION` and `CONTRACT_SHA256` name the API
contract it was generated from. Every client carries all three as `client.versions`, and every
request names the SDK and the contract in its `User-Agent`. A new contract version does not change
the SDK's version unless the SDK changed.

## Developing

```sh
npm ci
npm run generate       # src/generated/ from ../contract/surface.json
npm test               # unit tests, against real sockets on loopback: no network
npm run typecheck
npm run build
npm run test:live      # every scenario in ../scenarios/live.json, against a deployed API
```

The live suite reads its configuration from the environment or from `.env.live` here, which is never
committed. `../scenarios/live.json` lists the variables it needs. If the API's certificate is not
publicly trusted, point `NODE_EXTRA_CA_CERTS` at the issuing CA. The suite fails, rather than skips,
when anything is missing.
