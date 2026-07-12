#!/usr/bin/env python3
"""Claude Code PreToolUse hook: block obviously dangerous Bash commands.

Reads the tool-call JSON on stdin. Exit 2 blocks the call (stderr is shown to Claude as
feedback); exit 0 allows it. Keep the rule list tight — false positives erode trust.
"""
import json
import re
import sys

RULES = [
    (
        r"git\s+push\b[^\n]*--force(?!-with-lease)",
        "Force-push is blocked. Use --force-with-lease on a feature branch only; "
        "never force-push main or develop.",
    ),
    (
        r"git\s+(commit|push)\b[^\n]*--no-verify",
        "--no-verify bypasses the git hooks (secret scan, commit-msg check). "
        "Fix the underlying issue instead.",
    ),
    (
        r"git\s+reset\s+--hard\s+(origin/)?(main|develop)\b",
        "Hard-resetting onto main/develop discards local work. "
        "Prefer merge/rebase, or confirm with the user first.",
    ),
    (
        r"rm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+(/|~|\$HOME)(\s|$)",
        "Refusing to recursively delete the filesystem root or home directory.",
    ),
    (
        r"curl[^\n|;&]*\|\s*(ba|z)?sh",
        "Piping curl to a shell executes unreviewed remote code. "
        "Download, inspect, then run.",
    ),
]


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0  # never break the session on malformed input
    command = (payload.get("tool_input") or {}).get("command", "")
    if not command:
        return 0
    for pattern, reason in RULES:
        if re.search(pattern, command):
            print(f"Blocked by .claude/hooks/guard_bash.py: {reason}", file=sys.stderr)
            return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
