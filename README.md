# atlas-sdks

**Public** client libraries for the ATLAS API (`/v1`) — "The personalisation layer for
e-learning". The TypeScript SDK is here. The Python SDK follows, under the same rules. Both are
generated from the ATLAS API contract, and both cover exactly what a developer's credentials can
call.

## Layout

| Path | What |
|---|---|
| `typescript/` | TypeScript SDK — TS strict, ESM |
| `python/` | Python SDK — typed, ruff-clean. Not written yet |
| `contract/` | The API contract every SDK is generated from, the stamp naming it, and the surface derived from it |
| `scenarios/` | The live scenarios every SDK runs against a deployed API, and their fixtures |
| `tools/` | Vendor the contract, check its stamp, derive the surface |

## What an SDK covers

Every operation whose `security` admits an API key or a delegated pass, plus the operation that
issues a pass, which the contract names in `x-atlas-issued-by`. `tools/derive-surface.mjs` derives
that set from the contract, and no list of operations exists anywhere in this repository. Today it
is ten operations: nine that a key reaches, three of which a pass reaches too, and the token
exchange. Operations only a signed-in person's own session can call are not in any SDK.

## Installing

**Nothing is published to a package registry, and nothing will be before an ATLAS environment has a
public address:** a package you could install but point nowhere would help nobody. An SDK release
will be a GitHub Release of this repository, with the package attached and its sha256 in the release
notes. For TypeScript:

```sh
npm install https://github.com/devatlasframework/atlas-sdks/releases/download/typescript-v<version>/devatlasframework-sdk-<version>.tgz
```

**Until then, any package on any registry that calls itself the ATLAS SDK is not ours.**

## Prerequisites

Per SDK: Node 22+ / Python 3.12+.

## How to run the tests

```sh
cd typescript && npm ci && npm test   # the unit suite: no network
cd typescript && npm run test:live    # against a deployed API - see scenarios/live.json
cd tools && npm ci && npm run verify  # the contract matches its stamp, and the surface is current
```

## Versions

Each SDK has its own SemVer version and releases on its own schedule when the public API changes;
SDK releases never gate an app deployment. Each SDK also records the version of the contract it
was generated from, readable at run time (`CONTRACT_VERSION` in TypeScript). The two numbers
answer different questions. The SDK's version says what changed in the SDK, and the contract's says
which API it describes.

## Branching & releases

Same branch model and Conventional Commits as the other repos
(`../docs/ATLAS_Development_Conventions.md`). A release tags `typescript-v<version>` or
`python-v<version>`. After cloning: `git config core.hooksPath .githooks`

## Environment variables

Examples use placeholders only (`ATLAS_API_KEY`) — never real keys. The live suite reads its
configuration from the environment or from `typescript/.env.live`, which is never committed; the
variables it needs are listed in `scenarios/live.json`.

## Ownership & help

Isuru Harischandra. This repo is public — see `CLAUDE.md` before writing anything, and
`SECURITY.md` to report a vulnerability.
