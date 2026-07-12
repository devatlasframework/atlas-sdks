---
description: Fill the ATLAS MR template from the branch diff
argument-hint: [optional - target branch, default develop]
---

Write the merge-request description for this branch against the target (`$ARGUMENTS` if
given, else `develop`). Base it on the full branch diff and commit list, not just the latest
commit.

**Title:** same convention as a commit — `type(scope): summary`.

**Body**, using the fixed ATLAS template:

- **What** — the change in 2–4 sentences
- **Why** — the problem/ticket it solves (link `ATLAS-###`)
- **How to test** — numbered steps a reviewer can actually follow, including test commands
- **Screenshots** — list the screens to capture (UI changes only; placeholder otherwise)
- **Risk / rollback** — blast radius, migration notes, how to revert safely
- **Ticket** — `ATLAS-###`
