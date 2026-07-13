# atlas-sdks — house rules

**PUBLIC** client libraries for the ATLAS API (`/v1`): TypeScript, Python, Java. Everything
here ships to public registries — write accordingly.

The API's behaviour — auth (API keys / OAuth on-behalf), scopes, request checking, rate
limits and quotas, webhooks (signatures, retries), idempotency keys, versioning — is
specified in the architecture plan §11 (workspace `../docs/ATLAS_Platform_Architecture_Plan.md`).
SDK ergonomics must reflect those semantics (e.g. expose idempotency keys, verify webhook
signatures, surface rate-limit state).

## Rules

- **Public repo:** no internal URLs or hostnames, no references to unreleased features, no
  secrets or real keys anywhere (examples use `ATLAS_API_KEY` placeholders).
- The SDK surface mirrors the OpenAPI description (`atlas` repo → `packages/api-spec`) —
  generated where possible, hand-written ergonomics on top. Never invent or anticipate
  endpoints that aren't in the spec.
- Each SDK versions independently (SemVer); a breaking change needs a major bump plus a
  migration note in that SDK's changelog. SDK releases never gate an app deployment.
- Every public method carries docs and a runnable example; error handling mirrors the API's
  problem-details shape.
- Idiomatic per language: TS strict + ESM · Python fully typed + ruff · Java 17+ compatible,
  no exotic dependencies.
