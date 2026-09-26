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

**No SDK has been released yet.** The TypeScript SDK's source is in this repository, and the Python
SDK's is not written yet. Neither is on npm or PyPI, and neither will be before an ATLAS environment
has a public address: a release will be attached to this repository's GitHub Releases, with its
sha256. This table will be filled in as each ships.

| Version            | Supported          | Notes                                                         |
| ------------------ | ------------------ | ------------------------------------------------------------- |
| `develop`          | :white_check_mark: | Pre-release source — report anything you find here            |
| Releases           | —                  | **None yet.** Nothing bearing the ATLAS name is on a registry |

**When we do release:** each SDK versions independently under SemVer, and **only the most recent
released minor of each SDK receives security fixes**. Pinning an older minor means pinning its
bugs; upgrade to receive fixes.

> **Because nothing is released, any package currently claiming to be an ATLAS SDK is not ours.**
> If you find one, please report it — see _Impersonated packages_ below.

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

Since we have released nothing, **any package on any registry — npm, PyPI, Maven Central or another —
claiming to be an ATLAS SDK is not ours.** If you find one — a typosquat, a name-squat, or a package impersonating
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
