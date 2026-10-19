# Security Policy

`atlas-sdks` holds the official client libraries for the ATLAS API — TypeScript and Python.
These SDKs run **inside your application** and handle **your API credentials**, so we treat
anything that could leak a token, weaken transport security, or let a malicious API response affect
your process as a serious bug.

This repository is also the **public reporting entry point for the whole ATLAS platform**. Most
ATLAS repositories are private, so if you have found a security issue anywhere in ATLAS — the API,
the web app, the document pipeline, the infrastructure — report it here and we will route it
internally. Please do not go looking for somewhere better to file it.

---

## Supported Versions

An SDK is released as a **GitHub Release of this repository**, tagged `typescript-v<version>` or
`python-v<version>`, with the package attached and its sha256 in the release notes. Neither SDK is
on npm or PyPI, and neither will be before an ATLAS environment has a public address.

| Version                       | Supported          | Notes                                                         |
| ----------------------------- | ------------------ | ------------------------------------------------------------- |
| Latest release of each SDK    | :white_check_mark: | The newest `typescript-v…` and `python-v…` release            |
| Release candidates (`…-rc.N`) | :x:                | Pre-releases for testing only; install the release instead    |
| `develop`                     | :white_check_mark: | Unreleased source — report anything you find here             |
| Any package on a registry     | :x:                | **Not ours.** Nothing bearing the ATLAS name is on a registry |

Each SDK versions independently under SemVer, and **only the most recent released minor of each SDK
receives security fixes**. Pinning an older minor means pinning its bugs; upgrade to receive fixes.

> **Because we publish nothing to a registry, any package claiming to be an ATLAS SDK there is not
> ours.** If you find one, please report it — see _Impersonated packages_ below.

---

## Reporting a Vulnerability

**Do not open a public issue, discussion, or pull request for a security problem**, and please do
not post about it publicly before it is fixed and disclosed.

Use GitHub's private reporting:

**[Report a vulnerability](https://github.com/devatlasframework/atlas-sdks/security/advisories/new)**
&nbsp;— or the _Security_ tab → _Advisories_ → _Report a vulnerability_

Your report is visible only to you and the maintainers. It gives us a private space to develop and
test a fix, and lets us credit you and request a CVE when the advisory is published.

### What to include

A report we can reproduce is worth ten we cannot:

- **What breaks, and what an attacker gains** — the impact, in a sentence or two.
- **Which SDK and version**, plus language runtime and OS.
- **Reproduction steps** and the smallest possible proof of concept.
- **Your severity assessment**, and whether it affects only the SDK or the ATLAS service behind it.
- Whether you plan to publish, and on what timeline.

### What happens next

| Stage                  | Target                                                                            |
| ---------------------- | --------------------------------------------------------------------------------- |
| **Acknowledgement**    | Within **5 business days**                                                        |
| **Triage + severity**  | Within **10 business days** — reproduced and scored, or an explanation of why not |
| **Fix developed**      | Per severity (below), in a private advisory fork                                  |
| **Fix released**       | Released from this repository, with the advisory                                  |
| **Advisory published** | Within **10 business days of the fix being released**, crediting you              |

If we conclude something is not a vulnerability, we will say so plainly and explain why — and we
are happy to be argued with.

> **On capacity, so expectations are honest:** ATLAS is built and maintained by a single developer
> as part of an MSc research project. There is no 24/7 rotation and **no bug bounty** — we cannot
> offer payment. What we offer is a real fix, a straight answer, and public credit.

### Severity and fix timelines

We score with **CVSS v3.1**, with one ATLAS-specific escalation: **anything that crosses an
organisation boundary or exposes another tenant's data is at least High**, regardless of base
score. Tenant isolation is the platform's first non-negotiable.

| Severity     | Examples                                                                                                       | Fix target             |
| ------------ | -------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **Critical** | Credential exfiltration by the SDK · remote code execution from an API response · authentication bypass        | **14 days**            |
| **High**     | API key written to logs or error output · TLS verification disabled or bypassable · cross-tenant data access   | **30 days**            |
| **Medium**   | Token leakage to a third party via redirect or proxy handling · credential retained past its intended lifetime | **90 days**            |
| **Low**      | Limited information disclosure · missing hardening with a demonstrated, minor attack path                      | Next scheduled release |

---

## Scope

### In scope

| Area                         | What we want to hear about                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Credential handling**      | API keys or tokens written to logs, exceptions, stack traces, crash dumps, telemetry, or disk · credentials sent to the wrong host · tokens surviving longer than intended |
| **Transport security**       | TLS verification disabled or bypassable · downgrade to plain HTTP · certificate or hostname checks skipped · proxy handling that leaks credentials                         |
| **Response handling**        | Deserialising an API response in a way that enables code execution, prototype pollution, XXE, or entity expansion                                                          |
| **Redirects and retries**    | Following a redirect to another host with the `Authorization` header still attached · retries replaying a credential elsewhere                                             |
| **Insecure defaults**        | Any default that is unsafe unless the caller knows to change it — verification off, secrets logged, credentials cached to disk                                             |
| **Dependencies**             | A vulnerable transitive dependency **with a reachable path through SDK code** — please include the call path                                                               |
| **Supply chain**             | Compromise of the build or publish pipeline · a published artefact that does not match this source · impersonated packages                                                 |
| **The ATLAS service itself** | Anything in the hosted platform — cross-tenant access, IDOR, authentication or MFA bypass, prompt injection, privacy leaks. Report it here and we will route it            |

### Impersonated packages

Since we publish nothing to any registry, **any package on any registry — npm, PyPI, Maven Central or
another — claiming to be an ATLAS SDK is not ours.** Ours are attached to this repository's GitHub
Releases and nowhere else. Our names will be `@devatlasframework/sdk` on npm and
`devatlasframework-sdk` on PyPI, and neither holds a package yet; PyPI's `atlas-sdk`, among others,
belongs to an unrelated project. If you find one — a typosquat, a name-squat, or a package impersonating
this project — report it through the advisory link above **and** to the registry's own abuse team.
Do not install it to investigate.

### Out of scope

- **Reports with no proof of concept** — scanner or AI-tool output, or a claim that a pattern is
  "insecure" with no demonstrated attack path.
- **Dependency CVEs with no reachable path through SDK code.** Show the call path and it becomes in
  scope.
- **Anything requiring an already-compromised host** — an attacker who can read your process memory,
  environment, or filesystem does not need an SDK bug.
- Misuse by the calling application: hard-coding a key in client-side code, committing a `.env`,
  logging the credential yourself, or shipping a server-scoped key to a browser.
- Findings that apply only to our non-Production environments, which are internal, hold no real user
  data, and are not hardened to Production standards.
- Copyright and abuse complaints about content hosted on the platform — those go through the
  takedown process described in the ATLAS API documentation, not through this policy.
- Social engineering, phishing, or physical attacks against the maintainer or any third party.

---

## Testing Rules and Safe Harbour

Test the SDKs against **your own** ATLAS organisation, or against a local ATLAS stack. When testing,
you must not:

- Access, modify, download, or retain data belonging to anyone but yourself. **If you achieve access
  to another organisation's data, stop immediately** — do not enumerate, do not pivot, and do not
  quantify the blast radius. One record proving it is exactly the right amount of evidence.
- Run automated scanners, fuzzers, or credential-stuffing tools against the hosted service.
- Perform denial-of-service, load, or stress testing, or anything that degrades the service for
  others.
- Use a credential you discovered, or attempt to widen access with it.
- Social-engineer, phish, or physically target any person.

**Safe harbour.** If you make a good-faith effort to follow this policy, we will treat your research
as authorised, will not pursue legal action or ask a platform to act against you, and will work with
you to fix the issue quickly. If a third party brings action over research that followed this policy,
we will make that authorisation clear. Good faith is judged by conduct: report promptly, keep it
private until disclosure, and take only the access you need to prove the point.

---

## Disclosure

We practise **coordinated disclosure**.

- We publish a GitHub Security Advisory within **10 business days of the fix being released**, and
  request a CVE where one is warranted.
- Our default embargo is **90 days from acknowledgement**. If we need longer, we will tell you why
  and agree a new date with you rather than let it lapse silently.
- If an issue is being actively exploited, we fix and disclose as fast as we can, embargo
  notwithstanding.
- **You will be credited by name or handle** unless you ask us not to — tell us how you would like
  to be named.
- Please do not publish before the advisory goes out. If you have a hard publication deadline, say
  so in your first message and we will work to it.

---

## What is in place

What the SDKs themselves do to keep your credential where it belongs, and what guards this
repository. Every control is a row below, and each row names the code, the test or the CI step that
holds it. `scripts/security/check-security-claims.mjs` reads the table in CI and fails a built row
whose evidence does not exist. Paths are from this repository's root.

<!-- claims:start -->

| Control                                                                                                                                                                                            | Status | Evidence                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Transport.** Both SDKs refuse a base address that is not `https`; plain `http` is accepted only for a loopback address                                                                           | built  | `typescript/src/transport.ts#must use https` `typescript/test/unit/transport.test.ts#refuses plain http anywhere but a loopback address` `python/src/devatlasframework/sdk/_transport.py#must use https` `python/tests/unit/test_transport.py#test_refuses_plain_http_anywhere_but_a_loopback_address`                                           |
| **Transport.** A base address carrying a user name, a query or the server path is refused before anything is sent                                                                                  | built  | `typescript/test/unit/transport.test.ts#refuses an address that already ends in the server path, a query, or a user name` `python/tests/unit/test_transport.py#test_refuses_the_server_path_a_query_a_fragment_or_a_user_name`                                                                                                                   |
| **TLS.** The Python SDK verifies the certificate and host name with the platform's default context unless you pass a context of your own, and refuses an extra HTTPS handler that could replace it | built  | `python/src/devatlasframework/sdk/_transport.py#ssl.create_default_context()` `python/src/devatlasframework/sdk/_transport.py#handlers must not include an HTTPS handler`                                                                                                                                                                        |
| **Redirects.** Neither SDK follows a redirect, so the `Authorization` header only ever goes to the address you configured; the Python SDK refuses a handler that would follow one                  | built  | `typescript/src/transport.ts#redirect: 'manual'` `typescript/test/unit/transport.test.ts#is never followed, so the key never reaches another address` `python/tests/unit/test_transport.py#test_is_never_followed_so_the_key_never_reaches_another_address` `python/tests/unit/test_transport.py#test_handler_that_follows_redirects_is_refused` |
| **Credentials.** An error never carries the key, in its message, its cause or anything else on it, and a key a header cannot carry is refused without being repeated                               | built  | `typescript/src/transport.ts#function safeCause` `typescript/test/unit/transport.test.ts#never carries the credential, in the message or anywhere on the error` `python/tests/unit/test_transport.py#test_never_carries_the_credential` `python/tests/unit/test_transport.py#test_a_credential_a_header_cannot_carry_without_repeating_it`       |
| **Credentials.** The TypeScript client keeps the key in a private field, so printing or serialising the client does not show it                                                                    | built  | `typescript/src/client.ts#readonly #apiKey`                                                                                                                                                                                                                                                                                                      |
| **Webhooks.** A delivery is verified by HMAC compared in constant time, inside a 300-second window, and a changed byte, an old delivery or the wrong secret is refused                             | built  | `typescript/src/webhooks.ts#timingSafeEqual` `typescript/test/unit/webhooks.test.ts#is refused once it is older than the window` `python/src/devatlasframework/sdk/_webhooks.py#hmac.compare_digest` `python/tests/unit/test_webhooks.py#test_is_refused_with_one_byte_of_the_body_changed`                                                      |
| **Dependencies.** Neither SDK has a runtime dependency; for Python, CI fails the build if one appears                                                                                              | built  | `python/scripts/check_promises.py#No runtime dependencies` `typescript/package.json`                                                                                                                                                                                                                                                             |
| **Build.** The Python package is built against hashed build constraints                                                                                                                            | built  | `python/build-constraints.txt` `.github/workflows/ci.yml#--require-hashes`                                                                                                                                                                                                                                                                       |
| **Contract.** Every SDK is generated from the vendored contract its stamp names, and CI fails a copy that no longer matches                                                                        | built  | `tools/verify-contract.mjs` `.github/workflows/ci.yml#node tools/verify-contract.mjs`                                                                                                                                                                                                                                                            |
| **Supply chain.** Every workflow action is pinned by commit SHA                                                                                                                                    | built  | `scripts/ci/check-action-pins.mjs` `.github/workflows/ci.yml#node scripts/ci/check-action-pins.mjs`                                                                                                                                                                                                                                              |
| **Supply chain.** Dependabot proposes updates for the actions, both npm trees and the Python lockfile                                                                                              | built  | `.github/dependabot.yml`                                                                                                                                                                                                                                                                                                                         |
| **Secrets.** gitleaks scans every pull request, and a pre-commit hook scans locally; the one allowed finding is pinned by fingerprint, never by value                                              | built  | `.github/workflows/ci.yml#gitleaks/gitleaks-action` `.githooks/pre-commit` `.gitleaksignore`                                                                                                                                                                                                                                                     |
| **This table.** CI fails a built row here whose evidence does not exist                                                                                                                            | built  | `scripts/security/check-security-claims.mjs#export function check` `.github/workflows/ci.yml#check-security-claims.mjs SECURITY.md`                                                                                                                                                                                                              |

<!-- claims:end -->

What the table does not say:

- **The TypeScript SDK sets no TLS option of its own.** It calls Node's built-in `fetch`, which
  verifies certificates unless the process itself is told not to (`NODE_TLS_REJECT_UNAUTHORIZED=0`
  turns that off for everything in it, and is yours to never set).
- **Neither SDK writes logs.** Neither package calls a logger or the console; what reaches your logs
  is what your own code writes, which is why _Using the SDKs Safely_ below says never to log the
  request headers.
- **A release is assembled by hand.** The maintainer builds the package, attaches it to a GitHub
  Release and writes its sha256 into the notes; no workflow publishes, and nothing signs the file.
- **Required checks.** `gitleaks`, `contract` and both SDKs' jobs block a merge. `action-pins` runs on
  every pull request and is written to be required; adding it to the branch ruleset is the
  maintainer's act.
- **The service behind the SDKs** is covered by the `atlas` policy, which this repository's advisory
  link reaches. Nothing here is owed to a later plan step: every row above is built.

---

## Using the SDKs Safely

Not vulnerabilities — just the things that most often go wrong on the caller's side:

- **Keep API keys server-side.** These SDKs are for server and backend use. An ATLAS API key in
  browser JavaScript or a mobile binary is readable by anyone who wants it.
- **Load credentials from the environment or a secret manager**, never from source. Add `.env` to
  `.gitignore` and scan your own history.
- **Never log the client's request headers** wholesale — that is where the credential lives.
- **Pin and verify.** Use a lockfile, enable your ecosystem's audit tooling, and check the package
  name character by character before your first install. A release's notes carry the package's
  sha256: check the file you downloaded against it.
- **Rotate a key the moment you suspect exposure**, and prefer the narrowest scope that works.

---

## Related

- **API documentation and the OpenAPI description:** [`atlas-docs`](https://github.com/devatlasframework/atlas-docs)
- **The platform itself** (private): `atlas`, `atlas-infra` — report issues in either through this
  repository's advisory link.
