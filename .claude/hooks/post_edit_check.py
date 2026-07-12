#!/usr/bin/env python3
"""Claude Code PostToolUse hook: secret-scan a file right after Edit/Write.

Exit 2 reports findings back to Claude so it can remove them immediately; exit 0 = clean.
This is the fast in-session layer; the git pre-commit hook is the backstop.
"""
import json
import re
import sys
from pathlib import Path

PATTERNS = [
    (r"-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----", "private key material"),
    (r"\bAKIA[0-9A-Z]{16}\b", "AWS access key id"),
    (r"\bsk-[A-Za-z0-9_-]{20,}\b", "provider secret key"),
    (r"\bgh[pousr]_[A-Za-z0-9]{20,}\b", "GitHub token"),
    (
        r"(?i)\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*['\"][^'\"\s]{12,}['\"]",
        "hard-coded credential-like literal",
    ),
    (r"(?i)postgres(ql)?://[^/\s:]+:[^@\s]+@", "connection string with embedded password"),
]

SKIP_SUFFIXES = {
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf", ".zip",
    ".jar", ".woff", ".woff2", ".lock", ".svg",
}
# These files legitimately contain the patterns they scan for.
SKIP_NAMES = {"post_edit_check.py", "guard_bash.py", "pre-commit"}


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    file_path = (payload.get("tool_input") or {}).get("file_path", "")
    if not file_path:
        return 0
    path = Path(file_path)
    if (
        not path.is_file()
        or path.suffix.lower() in SKIP_SUFFIXES
        or path.name in SKIP_NAMES
        or path.stat().st_size > 2_000_000
    ):
        return 0
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return 0
    findings = []
    for pattern, label in PATTERNS:
        for match in re.finditer(pattern, text):
            line = text.count("\n", 0, match.start()) + 1
            findings.append(f"  {path.name}:{line} - looks like {label}")
    if findings:
        print(
            "Possible secret in the working tree - replace it with an env-var name:",
            file=sys.stderr,
        )
        print("\n".join(sorted(set(findings))), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
