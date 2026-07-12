---
description: Write a Conventional Commit message from the staged diff
---

Write the commit message for the staged diff (`git diff --staged`).

- Format: `type(scope): summary` — types `feat|fix|docs|refactor|test|chore|perf|build|ci`;
  scope = module/app touched (e.g. `profiling`, `web`, `billing`); summary imperative,
  ≤ 72 chars, no trailing period.
- Body (wrapped at 72): the **why**, not a list of edits. Note breaking changes with
  `BREAKING CHANGE:`. Reference the ticket (`ATLAS-###`) when known.
- If the staged diff mixes unrelated concerns, say so and propose how to split it instead of
  writing one blurry message.

Output the final message in a code block first; commit with it only after I confirm.
