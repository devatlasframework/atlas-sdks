"""The built wheel installs into a fresh environment, imports, and carries its types.

A package can pass every test in its own checkout and still ship broken: a module left out of the
wheel, a py.typed marker that did not travel, a namespace that became a regular package. So this
installs dist/*.whl, with nothing else, into a new virtual environment, imports it there, and
type-checks two consumers against the installed copy: one that must pass, and one that must fail -
which proves the checker read the package's types rather than treating it as `Any`.

  uv build && uv run python scripts/smoke_wheel.py
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import venv
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

GOOD = """\
from devatlasframework.sdk import AtlasApiError, KeyClient, KeyIdentity, VERSIONS

atlas = KeyClient(base_url="https://api.example.test", api_key="placeholder")
key: KeyIdentity = atlas.describe_key()
org: str = key["orgId"]
print(VERSIONS.sdk, VERSIONS.contract, AtlasApiError.__name__, org)
"""

BAD = """\
from devatlasframework.sdk import KeyClient

atlas = KeyClient(base_url="https://api.example.test", api_key=42)
atlas.present_for_end_user("x", {"profile": "not a profile"})
"""


def run(*command: str, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=cwd, capture_output=True, text=True, check=False)


def main() -> int:
    wheels = sorted((ROOT / "dist").glob("*.whl"))
    if len(wheels) != 1:
        print(f"smoke-wheel: dist/ holds {len(wheels)} wheels, not one", file=sys.stderr)
        return 1
    with tempfile.TemporaryDirectory() as scratch:
        here = Path(scratch)
        venv.create(here / "env", with_pip=True)
        python = here / "env" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")

        installed = run(
            str(python), "-m", "pip", "install", "--no-index", "--no-deps", str(wheels[0])
        )
        if installed.returncode != 0:
            print(f"smoke-wheel: the wheel did not install:\n{installed.stderr}", file=sys.stderr)
            return 1

        imported = run(
            str(python),
            "-c",
            "from devatlasframework.sdk import VERSIONS, KeyClient, verify_webhook\n"
            "print(VERSIONS)",
            cwd=here,
        )
        if imported.returncode != 0:
            print(f"smoke-wheel: the wheel did not import:\n{imported.stderr}", file=sys.stderr)
            return 1

        (here / "good.py").write_text(GOOD, encoding="utf-8")
        (here / "bad.py").write_text(BAD, encoding="utf-8")
        (here / "mypy.ini").write_text("[mypy]\nstrict = True\n", encoding="utf-8")
        mypy = [sys.executable, "-m", "mypy", "--config-file", "mypy.ini"]
        mypy += ["--python-executable", str(python), "--no-incremental"]
        good = run(*mypy, "good.py", cwd=here)
        if good.returncode != 0:
            print(f"smoke-wheel: a correct consumer failed:\n{good.stdout}", file=sys.stderr)
            return 1
        bad = run(*mypy, "bad.py", cwd=here)
        if bad.returncode == 0 or "arg-type" not in bad.stdout:
            print(
                "smoke-wheel: a wrong consumer type-checked, so the installed package's types "
                f"were not read:\n{bad.stdout}",
                file=sys.stderr,
            )
            return 1

    print(f"smoke-wheel: {wheels[0].name} installs alone, imports, and carries its types.")
    print(f"smoke-wheel: {imported.stdout.strip()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
