# atlas-sdks

**Public** client libraries for the ATLAS API (`/v1`) — "The personalisation layer for
e-learning". Two SDKs, TypeScript and Python, both generated from the ATLAS API contract, and both
covering exactly what a developer's credentials can call.

## Layout

| Path | What |
|---|---|
| `typescript/` | TypeScript SDK — TS strict, ESM |
| `python/` | Python SDK — fully typed, ruff-clean, synchronous, standard library only |
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
is a GitHub Release of this repository, with the package attached and its sha256 in the release
notes. Download the file, compare its sha256 with the release notes, and install the file you
checked, never the URL: a release asset can be replaced under the same name. For TypeScript:

```sh
curl -fsSLO https://github.com/devatlasframework/atlas-sdks/releases/download/typescript-v<version>/devatlasframework-sdk-<version>.tgz
openssl dgst -sha256 devatlasframework-sdk-<version>.tgz
npm install ./devatlasframework-sdk-<version>.tgz
```

For Python, the wheel (`devatlasframework-sdk`, imported as `devatlasframework.sdk`):

```sh
curl -fsSLO https://github.com/devatlasframework/atlas-sdks/releases/download/python-v<version>/devatlasframework_sdk-<version>-py3-none-any.whl
openssl dgst -sha256 devatlasframework_sdk-<version>-py3-none-any.whl
pip install ./devatlasframework_sdk-<version>-py3-none-any.whl
```

A tag ending `-rc.N` is a release candidate, published as a GitHub pre-release for testing. Install
the release it becomes instead.

The Python manifest carries the `Private :: Do Not Upload` classifier, which PyPI refuses, as the
TypeScript manifest is marked `private`: nothing can be published by accident.

**Any package on any registry that calls itself the ATLAS SDK is not ours.**

## Prerequisites

Per SDK: Node 22+ / Python 3.12+.

## How to run the tests

```sh
cd typescript && npm ci && npm test   # the unit suite: no network
cd typescript && npm run test:live    # against a deployed API - see scenarios/live.json
cd python && uv sync --locked && uv run pytest   # the unit suite: no network
cd python && uv run pytest tests/live -s          # against a deployed API
cd tools && npm ci && npm run verify  # the contract matches its stamp, and the surface is current
```

## Versions

Each SDK has its own SemVer version and releases on its own schedule when the public API changes;
SDK releases never gate an app deployment. Each SDK also records the version of the contract it
was generated from, readable at run time (`CONTRACT_VERSION` in both). The two numbers
answer different questions. The SDK's version says what changed in the SDK, and the contract's says
which API it describes.

## Branching & releases

Same branch model and Conventional Commits as the other repos
(`../docs/ATLAS_Development_Conventions.md`). A release tags `typescript-v<version>` or
`python-v<version>`. After cloning: `git config core.hooksPath .githooks`

## Environment variables

Examples use placeholders only (`ATLAS_API_KEY`) — never real keys. The live suite reads its
configuration from the environment or from `typescript/.env.live` or `python/.env.live`, which are
never committed; the variables they need are listed in `scenarios/live.json`.

## Ownership & help

Isuru Harischandra. This repo is public — see `CLAUDE.md` before writing anything, and
`SECURITY.md` to report a vulnerability.
