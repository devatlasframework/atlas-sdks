---
description: Format, lint, secret-scan, and quick-test the changed files before committing
---

Run the pre-commit quality pass over the changed files (staged + unstaged).

1. Determine changed files via `git status --porcelain`.
2. For each affected app/package, run its formatter and linter if configured
   (web / ai-worker: prettier + eslint · api: spotless/checkstyle · ingestion: ruff format +
   ruff check + mypy). Where tooling isn't set up yet, skip gracefully with a note.
3. Secret-scan the changed files: private keys, cloud access keys, provider secret keys,
   tokens, passwords, connection strings with embedded credentials. Report file:line for
   anything suspicious.
4. Run the quick tests scoped to the changed modules.
5. Fix what can be fixed automatically, then summarise: ✅ passed · 🔧 fixed · ❌ needs
   attention.

Never conclude "ready to commit" while any secret finding or failing test remains.
