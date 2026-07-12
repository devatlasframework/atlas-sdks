# atlas-sdks

**Public** client libraries for the ATLAS API (`/v1`) — "The personalisation layer for
e-learning". SDKs for TypeScript, Python, and Java, generated from / kept in step with the
OpenAPI description (`atlas` repo → `packages/api-spec`).

## Layout

| Path | SDK |
|---|---|
| `typescript/` | `@atlas/sdk` — TS strict, ESM |
| `python/` | `atlas-sdk` — typed, ruff-clean |
| `java/` | `atlas-sdk` — Java 17+ compatible |

## Prerequisites

Per SDK: Node 22+ / Python 3.12+ / JDK 17+.

## How to run the tests

> Per SDK once scaffolded: `npm test` · `pytest` · `./mvnw verify`.

## Branching & releases

Each SDK versions **independently** (SemVer) and releases on its own schedule when the public
API changes; SDK releases never gate an app deployment. Same branch model and Conventional
Commits as the other repos (`../docs/ATLAS_Development_Conventions.md`).
After cloning: `git config core.hooksPath .githooks`

## Environment variables

Examples use placeholders only (`ATLAS_API_KEY`) — never real keys.

## Ownership & help

Isuru Harischandra. This repo is public — see `CLAUDE.md` before writing anything.
