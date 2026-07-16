---
description: Start an implementation-plan step the right way — resolve the target repo, file the ticket, branch off fresh develop, then plan
argument-hint: <plan step id, e.g. A2 or B1>
---

You are starting **plan step `$ARGUMENTS`** from the ATLAS implementation plan. Do the
**front-half of the workflow deterministically first** — this exists because a cold session
handed "implement step X" tends to skip the ticket/branch/plan gate and can start on a stale or
wrong branch (that is exactly what happened on ATLAS-21). Follow these steps in order; **stop
and ask the user** at the first thing that isn't clean. Do not write any implementation code
until step 6.

Sessions normally open at the **ATLAS workspace root** — the folder holding the five repos
side by side plus the specs (`docs/`). This command resolves which repo the step targets and
does all git work **inside that repo's directory**.

If `$ARGUMENTS` is empty, ask the user which step id to start, then continue.

## 1. Locate the plan step

Read the implementation plan and extract the block for id `$ARGUMENTS`:

- From the workspace root it is `atlas/docs/IMPLEMENTATION_PLAN.md`.
- (Inside the `atlas` repo it is `docs/IMPLEMENTATION_PLAN.md`; inside a sibling repo it is
  `../atlas/docs/IMPLEMENTATION_PLAN.md`.)

If the step id is not found, **stop** and tell the user. Quote the step's **Title**, **Repo**,
**What**, **Governing**, **Depends on**, **Acceptance**, and **Verify** back so both of you
agree on scope. If it is a release step (`REL`), follow `CONTRIBUTING.md` stages 6–8 instead of
this command.

## 2. Resolve the target repo (the ATLAS-21 failure)

Work out the step's target repo from its **Repo** field and map it to a git repo: anything like
`atlas`, `atlas/api`, `atlas/web`, `atlas/ingestion`, `atlas (…)` → the **`atlas`** monorepo;
`atlas-infra` / `atlas-sdks` / `atlas-docs` / `atlas-research` → that sibling repo. From here
on, run every git/build/test command **inside that repo's directory** (cd into it, or
`git -C <repo> …`) — never at the workspace root, which is not a git repository. Check:

- The target directory exists and is the right clone: `git -C <repo> remote get-url origin`
  names `devatlasframework/<repo>`. If not, **stop** and tell the user.
- If this session was opened **inside** one specific repo and it is _not_ the target, **stop**:
  tell the user to reopen at the workspace root (preferred) and re-run
  `/start-step $ARGUMENTS`. Do not work on a repo from a session rooted in a different one.

(A step may touch a companion repo too — e.g. an `atlas` feature with a small `atlas-infra`
change; handle that as a companion PR per `CONTRIBUTING.md`, but branch in the primary repo
first.)

## 3. Clean, fresh develop (in the target repo)

- `git status` must be clean and the repo must not already be on a `feature/`, `bugfix/`,
  `docs/`, or `chore/` branch. If the tree is dirty or a work branch is checked out, **stop**
  and ask how to proceed (don't stash or clobber without consent).
- `git fetch origin`, `git checkout develop`, `git pull` — start from the latest develop.

## 4. Check dependencies

If the step lists `Depends on:` prior steps, confirm those are merged (their PRs closed / their
work present on develop). If a dependency looks unmet, **flag it** to the user before continuing.

## 5. File the ticket, then branch

- Create the GitHub issue on **`devatlasframework/atlas`** (tickets always live on `atlas`, even
  when the work lands in a sibling repo — see the CONTRIBUTING cross-repo note). Title = the
  step's title; body = the step block plus a line `Implements plan step $ARGUMENTS`; pick a
  fitting label (`feature`/`infra`/`documentation`/`research`). Capture the issue number `N`.
- Cut the branch off develop: `<type>/ATLAS-<N>-<slug>` where `<type>` maps from the step
  (feat→`feature`, docs→`docs`, chore→`chore`, fix→`bugfix`) and `<slug>` is a short kebab-case
  of the title. Confirm you are on it.

## 6. Hand off to implementation

Now enter **plan mode** and propose the implementation for the step (files, approach, how you'll
verify the acceptance criteria live), citing the step's **Governing** spec sections. After the
user approves the plan, implement it and run the rest of the documented flow: `/write-tests` ·
`/pre-commit-check` · independent review (the `reviewer` / `security-reviewer` agents, or the
built-in `/code-review` if the agents aren't in this repo) · `/commit-message` · **wait for the
user's commit approval** · `/mr-description` · open the PR · merge on green CI + user approval ·
Dev smoke. The Definition of Done and gates are in `CONTRIBUTING.md`.

**Summary to print before step 6:** the resolved step, the created issue (`ATLAS-<N>`), and the
branch name — so the user can confirm the front-half is correct before any code is written.
