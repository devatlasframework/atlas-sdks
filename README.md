# atlas-sdks

**Public** client libraries for the ATLAS API (`/v1`) — "The personalisation layer for
e-learning". **No SDK code exists yet.** The three SDKs — TypeScript, Python and Java — will be
generated from the published OpenAPI description (`atlas-docs/api/openapi.yaml`, mirrored from the
`atlas` repo's `packages/api-spec`). Each will record which contract version (`info.version`) it
was generated from — the contract's own number, not an ATLAS release number.

## Layout

| Path | SDK |
|---|---|
| `typescript/` | TypeScript — TS strict, ESM |
| `python/` | Python — typed, ruff-clean |
| `java/` | Java — Java 17+ compatible |

**Package names are not chosen or reserved yet.** Until an SDK is published from this repository,
a package on any registry that calls itself the ATLAS SDK is not ours.

## Prerequisites

Per SDK: Node 22+ / Python 3.12+ / JDK 17+.

## How to run the tests

> Per SDK once scaffolded: `npm test` · `pytest` · `./mvnw verify`.

## Branching & releases

Each SDK will have its own SemVer version, separate from the contract version it was generated
from, and will release on its own schedule when the public API changes; SDK releases will never gate an app deployment. Nothing is published to any package
registry yet. Same branch model and Conventional
Commits as the other repos (`../docs/ATLAS_Development_Conventions.md`).
After cloning: `git config core.hooksPath .githooks`

## Environment variables

Examples use placeholders only (`ATLAS_API_KEY`) — never real keys.

## Ownership & help

Isuru Harischandra. This repo is public — see `CLAUDE.md` before writing anything.
