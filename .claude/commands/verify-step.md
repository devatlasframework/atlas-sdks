---
description: Live acceptance verification of the current step before its PR merges — plan the checks, run them yourself, fix process issues on the go, and cleanly separate implementation bugs from verification-process problems
argument-hint: <plan step id, e.g. B8 — optional; derived from the branch if omitted>
---

Verify that step `$ARGUMENTS` (or the step behind the current `feature/ATLAS-…` branch, when
empty) works **100% as its plan entry promises**, against a real running stack, before the PR
merges. This is not a substitute for tests or CI — it is the live proof of the step's
**Acceptance** and **Verify** lines, executed end to end.

**You run every command yourself** through your tools and show the user each command, its
actual output, the expected result, and PASS/FAIL — the user watches a structured run, they do
not copy-paste. (Only if the user explicitly asks for manual instructions instead: the
instructions must be fully self-contained — absolute paths only, every required env var
listed with where its value comes from, and the preflight checks below included as steps —
because the user may run them from any terminal, at any cwd, elevated or not.)

## 1. Resolve scope

- Identify the step: from `$ARGUMENTS`, else from the branch name's ticket → the GitHub issue
  → its `Implements plan step <id>` line. Read the step's block in
  `atlas/docs/IMPLEMENTATION_PLAN.md` (workspace-root relative) — quote its **Acceptance** and
  **Verify** lines; they are the contract being proven.
- Read the branch diff (`git diff develop...HEAD --stat` + the key files) so the checks cover
  what was _actually built_, including review-driven behaviour (e.g. byte-identical error
  bodies), not just the plan's minimum.
- Target environment: **the branch build, locally, against the compose stack**
  (`atlas-infra/compose/docker-compose.yml`). Never verify a pre-merge branch against Dev —
  Dev runs `develop`. (Dev smoke happens after merge, separately.)

## 2. Plan the verification (present before executing)

Produce a numbered checklist covering every Acceptance/Verify clause plus the security
behaviours the diff claims (fail-closed paths, negative cases, no-leak comparisons). For each
check: **what it proves · the exact command · the expected result**. Show the plan to the user,
then execute without waiting unless they object.

## 3. Preflight — kill the known process traps BEFORE booting anything

Do these checks first; each has bitten a real verification run:

1. **Absolute paths only.** Build every command around `D:\Personal\ATLAS\…` (or the actual
   workspace root — derive it once and reuse). Never emit a `..\..\..`-relative path: shells
   change cwd between calls and users open new terminals.
2. **Env-var inventory.** Grep the target app for its fail-closed boot requirements before
   first launch (api: `grep -rn "getenv\|@Value\|fails closed\|IllegalStateException"` over
   `config`/`application.properties`, plus `atlas-infra/compose/.env.example`). Set every one
   (`ATLAS_JWT_SECRET`, `ATLAS_MFA_ENCRYPTION_KEY`, `SPRING_DATASOURCE_*`, …) in the launch
   environment up front — source dev values from `atlas-infra/compose/.env` **without ever
   printing a secret value** (read → assign; on PowerShell:
   `$env:X = (Get-Content <abs>\.env | Select-String '^X=').ToString().Split('=',2)[1]`).
   A missing key must never surface as a mid-run boot crash.
3. **Port ownership.** For every host port the run relies on (5432, 6379, 8080, 1025…), check
   who owns it before use: `Get-NetTCPConnection -LocalPort <p> -State Listen` → owning
   process. Known trap: the native Windows service **`postgresql-x64-18`** binds 5432 at boot
   and shadows compose's postgres — host-run apps then fail with
   `password authentication failed for user "atlas"` while in-container psql works. Fix
   before booting the app: elevated `Stop-Service postgresql-x64-18` +
   `docker compose … restart postgres` (remind the user to `Start-Service` afterwards), or map
   an alternate host port and point the datasource URL at it.
4. **Stack state, not stack presence.** `up -d` reporting "Running" is not proof: containers
   may predate `.env` (postgres credentials fix at first volume init). Prove each backing
   service works — `docker compose exec postgres psql -U atlas -d atlas -c "SELECT 1"`,
   `… exec redis redis-cli ping` — before launching the app, so infrastructure failures can
   never masquerade as implementation failures.
5. **Shell fit.** Commands for the user's terminal are PowerShell (`curl.exe`, not the `curl`
   alias; no `&&` on 5.1). Your own tool commands run where they run — don't mix syntaxes.
   Windows curl is schannel: private-CA HTTPS needs `--ssl-revoke-best-effort` (or `-k` for
   local smoke).

## 4. Execute, one check at a time

For each check show a compact block: **the command as actually run → the actual result → the
expected result → PASS / FAIL**. Keep a running scoreboard. Create smoke data with obviously
disposable names (`b8smoke@example.com`) and remember everything created for cleanup.

## 5. Triage every failure — process vs implementation (the point of this command)

Classify **before** touching anything:

- **VERIFICATION-PROCESS issue** — the environment, tooling, or the check itself is wrong:
  app won't boot, connection refused, auth to _infrastructure_ fails, path/command not found,
  wrong port, stale container, malformed test command. The implementation is not in question.
  → Fix it, log the fix in the report, and **re-run the same check**. If the fix is a durable
  machine/process lesson, note it for this file or the memory notes.
- **IMPLEMENTATION issue** — the stack is provably healthy (preflight passed, the request
  reached the app) but observed behaviour contradicts the step's Acceptance/Verify lines or
  the governing spec: wrong status, wrong body, data leak, missing side effect. → Do **not**
  hot-patch code mid-verification and do not re-run hoping. Record the evidence (request,
  actual, expected, governing spec line), continue the remaining independent checks, and
  report it as a **merge blocker** to fix through the normal loop (fix → tests → review →
  re-verify).
- **Ambiguous** → investigate (app logs, DB state, a control request against a known-good
  endpoint) until it is one or the other. Never mark PASS on a hunch, never blame the
  implementation while any preflight item is unproven.

## 6. Complete — report and restore

- **Scoreboard:** every check with command · expected · actual · PASS/FAIL.
- **Acceptance mapping:** each Acceptance/Verify clause → the check(s) that proved it.
- **Process issues fixed en route** (so the next run is cleaner) and **implementation issues
  found** (merge blockers), listed separately — never blended.
- **Verdict:** "safe to merge" only when every implementation-relevant check passed; otherwise
  "do not merge until <blockers>".
- **Restore the machine:** delete smoke users/orgs/files, remove any port-override files,
  remind about anything the user must undo themselves (e.g. restart a stopped native
  service). Leave the running api/compose stack up only if the user says so.

Never conclude "verified" while any check is unrun, any failure is unclassified, or cleanup
is owed.
