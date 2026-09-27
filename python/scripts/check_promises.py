"""Holds the public promises about the Python SDK to what the package actually is.

The repository README promises Python 3.12+, and README, CLAUDE.md and this SDK's README promise
"fully typed", "ruff" and no runtime dependencies. Each promise is checked against the file or the
built wheel that makes it true, so a README that keeps promising something the package stopped
doing fails here instead of misleading somebody.

  uv build && uv run python scripts/check_promises.py
"""

from __future__ import annotations

import re
import sys
import tomllib
import zipfile
from email.parser import Parser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO = ROOT.parent
problems: list[str] = []


def text(path: Path) -> str:
    return path.read_text(encoding="utf-8").replace("\r\n", "\n")


def promised(path: Path, *phrases: str) -> None:
    content = text(path)
    for phrase in phrases:
        if phrase not in content:
            problems.append(
                f'{path.relative_to(REPO)} no longer says "{phrase}" - update this check with it, '
                "never silently"
            )


# Where each promise is made.
promised(REPO / "README.md", "Python 3.12+")
promised(REPO / "CLAUDE.md", "Python 3.12+, fully typed", "ruff", "no runtime dependencies")
promised(ROOT / "README.md", "Python 3.12", "fully typed", "ruff", "No runtime dependencies")

manifest = tomllib.loads(text(ROOT / "pyproject.toml"))
project = manifest["project"]

# Python 3.12+, and CI runs the oldest version promised.
if project.get("requires-python") != ">=3.12":
    problems.append(f'requires-python is "{project.get("requires-python")}", not ">=3.12"')
matrix = re.search(r"python:\s*\[([^\]]*)\]", text(REPO / ".github" / "workflows" / "ci.yml"))
tested = re.findall(r"'([\d.]+)'", matrix.group(1)) if matrix else []
if "3.12" not in tested:
    problems.append(f"ci.yml tests Python {tested or 'nothing'}, which leaves out 3.12, the oldest")

# Fully typed: strict mypy over everything, and a py.typed marker in the wheel.
if manifest.get("tool", {}).get("mypy", {}).get("strict") is not True:
    problems.append("pyproject.toml does not set [tool.mypy] strict = true")
if "Typing :: Typed" not in project.get("classifiers", []):
    problems.append('the classifiers leave out "Typing :: Typed"')

# Ruff: lint and format are configured, and so they are what CI runs.
if "ruff" not in manifest.get("tool", {}):
    problems.append("pyproject.toml carries no [tool.ruff] configuration")

# No runtime dependencies.
if project.get("dependencies") != []:
    problems.append(f"dependencies is {project.get('dependencies')}, not []")

# Nothing goes to a public registry: PyPI refuses an upload carrying a Private classifier.
if "Private :: Do Not Upload" not in project.get("classifiers", []):
    problems.append('the classifiers leave out "Private :: Do Not Upload"')

# One version, and it is the SDK's.
declared = re.search(
    r'^SDK_VERSION: Final = "([^"]+)"',
    text(ROOT / "src" / "devatlasframework" / "sdk" / "_version.py"),
    re.MULTILINE,
)
version = declared.group(1) if declared else None

# The licence travels with the package.
if text(ROOT / "LICENSE") != text(REPO / "LICENSE"):
    problems.append("python/LICENSE is not the repository's LICENSE")

# And the wheel that was built is what all of this says.
wheels = sorted((ROOT / "dist").glob("*.whl"))
if len(wheels) != 1:
    problems.append(f"dist/ holds {len(wheels)} wheels, not one: run `uv build` in a clean dist/")
else:
    wheel = wheels[0]
    with zipfile.ZipFile(wheel) as archive:
        names = set(archive.namelist())
        metadata_name = next(n for n in names if n.endswith(".dist-info/METADATA"))
        metadata = Parser().parsestr(archive.read(metadata_name).decode("utf-8"))
        licence = next((n for n in names if n.endswith(".dist-info/licenses/LICENSE")), None)
        licence_text = archive.read(licence).decode("utf-8") if licence else ""
    if metadata["Version"] != version:
        problems.append(
            f"_version.py says {version} and the wheel says {metadata['Version']}: a package "
            "version means one thing"
        )
    if metadata.get_all("Requires-Dist"):
        problems.append(f"the wheel requires {metadata.get_all('Requires-Dist')}")
    if metadata["Requires-Python"] != ">=3.12":
        problems.append(f"the wheel requires Python {metadata['Requires-Python']}")
    classifiers = metadata.get_all("Classifier") or []
    for needed in ("Private :: Do Not Upload", "Typing :: Typed"):
        if needed not in classifiers:
            problems.append(f'the wheel leaves out the classifier "{needed}"')
    if "devatlasframework/sdk/py.typed" not in names:
        problems.append("the wheel carries no devatlasframework/sdk/py.typed marker")
    if "devatlasframework/__init__.py" in names:
        problems.append("the wheel makes devatlasframework a regular package, not a namespace")
    if licence_text.replace("\r\n", "\n") != text(REPO / "LICENSE"):
        problems.append("the wheel does not carry the repository's LICENSE")

if problems:
    for problem in problems:
        print(f"check-promises: {problem}", file=sys.stderr)
    sys.exit(1)
print(
    f"check-promises: Python >=3.12 (CI: {', '.join(tested)}), mypy strict, ruff, py.typed, no "
    f"runtime dependencies, not uploadable, version {version} - as the README says."
)
