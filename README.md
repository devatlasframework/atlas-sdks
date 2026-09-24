# atlas-sdks

**Public** client libraries for the ATLAS API (`/v1`) — "The personalisation layer for
e-learning". **No SDK code exists yet.** The three SDKs — TypeScript, Python and Java — will be
generated from the published OpenAPI description (`atlas-docs/api/openapi.yaml`, mirrored from the
`atlas` repo's `packages/api-spec`) and will pin to that contract's own version (`info.version`),
not to an ATLAS release number.

## Layout

| Path | SDK (planned package name) |
|---|---|
| `typescript/` | `@atlas/sdk` — TS strict, ESM |
| `python/` | `atlas-sdk` — typed, ruff-clean |
| `java/` | `atlas-sdk` — Java 17+ compatible |

## Prerequisites

Per SDK: Node 22+ / Python 3.12+ / JDK 17+.

## How to run the tests

> Per SDK once scaffolded: `npm test` · `pytest` · `./mvnw verify`.

## Branching & releases

Each SDK will version **independently** (SemVer) and release on its own schedule when the public
API changes; SDK releases will never gate an app deployment. Nothing is published to any package
registry yet. Same branch model and Conventional
Commits as the other repos (`../docs/ATLAS_Development_Conventions.md`).
After cloning: `git config core.hooksPath .githooks`

## Environment variables

Examples use placeholders only (`ATLAS_API_KEY`) — never real keys.

## Ownership & help

Isuru Harischandra. This repo is public — see `CLAUDE.md` before writing anything.
