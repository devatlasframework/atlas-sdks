# ATLAS SDK (Python)

The Python client for the ATLAS API (`/v1`): call it with an API key, act as a person who consented
with a delegated pass, and verify the webhooks ATLAS sends you.

- For Python 3.12 and later, fully typed (checked with `mypy --strict`, and it ships `py.typed`),
  linted and formatted with ruff. No runtime dependencies: the transport is the standard library's.
- Generated from the ATLAS API contract, and it covers exactly what a developer's credentials can
  call. A client built with a key has the key's operations; a client built with a pass has the
  pass's. Calling anything else is an attribute error, and a type error under a type checker, not a
  `403`.
- Distribution `devatlasframework-sdk`, imported as `devatlasframework.sdk`. Version `0.1.0`,
  released as the GitHub Release `python-v0.1.0` of this repository. The repository README says how
  to install it, sha256 check included.

## Quick start

```python
import os
from devatlasframework.sdk import AtlasApiError, KeyClient

atlas = KeyClient(
    base_url=os.environ["ATLAS_BASE_URL"],  # the API address you were given - there is no default
    api_key=os.environ["ATLAS_API_KEY"],  # a server-side secret: never ship it to a user's device
)

key = atlas.describe_key()
print(f"key for organisation {key['orgId']}, with {', '.join(key['scopes'])}")

try:
    page = atlas.list_resources(status=["READY"])
    for lecture in page["items"]:
        print(lecture["id"], lecture["title"])
except AtlasApiError as error:
    if error.error_code == "ATLAS-SYS-007":
        print("this key lacks content:read")
    else:
        raise
```

`base_url` is required and is the address the API is served from, without `/v1`. It must be `https`;
plain `http` is accepted only for a loopback address (`localhost`, `127.0.0.1`, `[::1]`).

**Bodies are dictionaries keyed exactly as the API sends them.** Requests and responses are typed
`TypedDict`s: camelCase for most bodies (`key["orgId"]`, `{"profile": ...}`), and snake_case for the
token exchange's answer and for webhook events, because that is what the wire carries. Nothing is
renamed between your code and the API, so a field a later version of the API adds reaches you
untouched, and a type checker still knows every field the contract declares.

## What each operation does, and how it is retried

| Method                                      | Needs              | After a `5xx` or a dropped connection                   |
| ------------------------------------------- | ------------------ | ------------------------------------------------------- |
| `describe_key()`                            | nothing            | retried                                                 |
| `list_end_users()`                          | `end-users:manage` | retried                                                 |
| `link_end_user({"ref": ...})`               | `end-users:manage` | retried under one `Idempotency-Key`, so it acts once    |
| `revoke_end_user(id)`                       | `end-users:manage` | retried: revoking a revoked link answers with that link |
| `present_for_end_user(id, {"profile": ...})` | `ai:use`           | **never retried**: every call counts in your usage      |
| `developer_usage()`                         | `usage:read`       | retried                                                 |
| `list_resources(status=, q=, page=, size=)` | `content:read`     | retried                                                 |
| `get_resource(id)`                          | `content:read`     | retried                                                 |
| `get_resource_download(id)`                 | `content:read`     | retried                                                 |

A `PassClient` has the last three only. `KeyClient` works out your organisation with `describe_key`
on first use, unless you pass `org_id`. Each method's name is the contract's `operationId` in
snake_case.

These rules are not written here by hand. Each operation's class comes from the contract: an
idempotent method is repeatable, an operation declaring `Idempotency-Key` is repeatable under one
key, and anything else is sent once.

## Errors

Every refusal is an `AtlasApiError`. **Branch on `error_code`**: it is on every refusal and names one
cause exactly, and a code is never removed or reused once published. `ERROR_CODES` lists every code
the operations here document, and `KnownErrorCode` is their type.

| Attribute                   | What it is                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `error_code`                | What to branch on. `None` only when something in front of the API refused the request |
| `status`, `title`, `detail` | The HTTP status and the problem document's own words                                  |
| `errors`                    | For a validation refusal: each field refused, and why                                 |
| `request_id`                | `X-Request-Id`: quote it in a support report, whatever the status                     |
| `error_id`                  | On an unexpected `500`: identifies that one failure                                   |
| `retry_after`               | `Retry-After`, in seconds. `None` on a refusal no wait would clear                    |
| `attempts`                  | How many attempts were made, the first included                                       |

When no response arrives at all, the error is an `AtlasConnectionError`. Its
`may_have_reached_server` tells you whether the request may have been processed. A credential never
appears on either error, in its message, or in any error it was raised from. Every error the SDK
raises is an `AtlasError`; only an exception your own callback raises (`on_retry`, `on_response`,
`on_renewed`) reaches you as itself.

## Retries

- **A `429` is waited out** for as long as its `Retry-After` says, then sent again, on every
  operation: a throttled request did nothing. A `429` with no `Retry-After` is raised at once,
  because it reports something waiting will not clear, such as an exhausted credit allowance.
- **A `5xx` or a dropped connection** is retried with backoff, but only where a retry cannot act
  twice (see the table).
- **`link_end_user` carries one `Idempotency-Key` on every attempt.** The API answers a retry with
  the first attempt's outcome. The SDK generates the key per call. Pass `idempotency_key=` yourself
  to make a retry that crosses a process restart act once too.
- **Every bound is the SDK's own:** `RetryPolicy.max_attempts` (3),
  `RetryPolicy.max_retry_after_seconds` (60) and the backoff delays, in seconds. ATLAS promises no
  window within which a repeated key is recognised, so keep retries of one logical call close
  together.
- **Calls block, and waits happen in the calling thread.** The SDK is synchronous: it has no
  cancellation token, so the retry bounds and `timeout` are what limit how long a call can take.
  `timeout` (default 30 seconds) bounds connecting and each wait for a response's head, and cuts
  off a body still arriving after it. Clients and passes are safe to share between threads.

```python
from devatlasframework.sdk import KeyClient, RetryPolicy

atlas = KeyClient(
    base_url=base_url,
    api_key=api_key,
    retry=RetryPolicy(max_attempts=5),
    on_retry=lambda event: log.warning(
        "%s %s, retrying in %.1f s", event.operation_id, event.reason, event.delay
    ),
)
```

The environment's proxy settings (`HTTPS_PROXY`, `NO_PROXY`, or the system's) are honoured for an
`https` address, which reaches the proxy as an encrypted tunnel. A plain-`http` loopback address
is never proxied, because a proxy would carry your credential off the machine in the clear. Pass
`ssl_context=` to verify the API's
certificate against a private certificate authority. The SDK never follows a redirect, so that your
credential is only ever sent to the address you configured.

## Rate limits

`client.rate_limit` is your overall request-rate budget as the last response reported it: a
`RateLimitState` with `limit`, `remaining`, `reset_seconds` and `observed_at`. It is `None` when no
response has reported one. **`None` does not mean unlimited:** ATLAS omits the figures when it
cannot count, rather than report ones it cannot stand behind.

Diagnose a refusal from the error's `retry_after` and `error_code`, never from `remaining`. A
narrower per-operation limit can refuse you while your overall figures still read healthy.

## Acting as a person: delegated passes

A person signs in to ATLAS, reads what you are asking for, and approves it. You then call the API
as them, limited to what they approved - today, reading their organisation's content.

```python
import secrets
from devatlasframework.sdk import PassClient, authorization_url, create_pkce_pair, exchange_code

# 1. Send the person to the consent page. Keep the verifier and the state with their session.
pkce = create_pkce_pair()
state = secrets.token_urlsafe(16)
consent = authorization_url(
    web_base_url=os.environ["ATLAS_WEB_URL"],  # where people sign in: not the API's address
    client_id=client_id,
    org_id=org_id,
    redirect_uri="https://app.example.test/atlas/callback",  # exactly as registered
    scopes=["content:read"],
    state=state,
    code_challenge=pkce.challenge,
)

# 2. On your redirect_uri: check `state`, then exchange the code at once - it lasts about a minute.
delegated_pass = exchange_code(
    base_url=base_url,
    client_id=client_id,
    code=code,
    redirect_uri=redirect_uri,
    code_verifier=pkce.verifier,
)

# 3. Call the API as them. The pass renews itself shortly before it expires.
as_person = PassClient(base_url=base_url, org_id=org_id, delegated_pass=delegated_pass)
page = as_person.list_resources()
```

The token exchange takes JSON: its request is camelCase and its answer snake_case, on purpose, so an
off-the-shelf OAuth2 client will not work against it. `exchange_code` and `DelegatedPass` speak it.

**Renewal follows the token exchange's rules.** A refresh token works once, and presenting a spent
one is treated as theft, which revokes every renewal token under the grant. So:

- two renewals never run at once in one process: threads asking together share one renewal;
- every failed renewal raises `RefreshRefusedError` and leaves the pass you hold usable until
  `still_valid_until`;
- a refused renewal (`400`) drops the refresh token for good. After the pass expires, send the
  person through consent again;
- a throttled renewal (`429`) spent nothing, and is tried again near expiry;
- a renewal that failed in a way that may have reached ATLAS - a `5xx`, a redirect, a lost
  connection - sets `renewal_outcome_unknown`, and the SDK never presents that token again on its
  own. Calling `delegated_pass.refresh()` yourself is the decision to try it.

**One grant belongs to one process.** To keep a pass across restarts, persist it from `on_renewed`,
which is called after every renewal, before the new token is used. A snapshot taken before a
renewal holds a spent refresh token, and so does one that two processes both restore: presenting it
revokes the grant.

```python
from devatlasframework.sdk import DelegatedPass


def save(snapshot):  # a JSON-serialisable dict
    store.save(person_id, snapshot)


delegated_pass = DelegatedPass.restore(
    store.load(person_id), base_url=base_url, client_id=client_id, on_renewed=save
)
```

Store the snapshot like a password: it can be renewed.

## Webhooks

```python
from flask import Flask, request
from devatlasframework.sdk import SIGNATURE_HEADER, WebhookVerificationError, verify_webhook


@app.post("/atlas/webhooks")
def atlas_webhook():
    try:
        event = verify_webhook(
            request.get_data(),  # the raw bytes, not request.json
            request.headers.get(SIGNATURE_HEADER),
            os.environ["ATLAS_WEBHOOK_SECRET"],
        )
    except WebhookVerificationError as error:
        return error.reason, 400
    deliveries.record_once(event)  # durably, keyed on event["delivery_id"] - then answer
    return "", 204  # ATLAS never re-sends a delivery you answered 2xx
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

With [uv](https://docs.astral.sh/uv/):

```sh
uv sync --locked
uv run python scripts/generate.py   # src/devatlasframework/sdk/_generated/ from ../contract/surface.json
uv run pytest                       # unit tests, against real sockets on loopback: no network
uv run mypy                         # strict, including the compile-time checks in tests/typing/
uv run ruff check . && uv run ruff format --check .
uv build --build-constraints build-constraints.txt --require-hashes
uv run python scripts/check_promises.py && uv run python scripts/smoke_wheel.py
uv run pytest tests/live -s         # every scenario in ../scenarios/live.json, against a deployed API
```

The types are generated by `datamodel-code-generator` (pinned in `uv.lock`) as `TypedDict`s: types
only, so nothing at run time can drop or rename a field. The live suite reads its configuration
from the environment or from `.env.live` here, which is never committed. `../scenarios/live.json`
lists the variables it needs. If the API's certificate is not signed by an authority this machine
trusts, point `ATLAS_CA_FILE` at the issuing CA's PEM file. The suite fails, rather than skips, when
anything is missing.
