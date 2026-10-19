#!/usr/bin/env node
/**
 * Every `uses:` in this repository's workflows and composite actions is pinned by a full commit SHA
 * (J4 criterion 12, ATLAS-735; #247).
 *
 * WHY A SHA AND NOT A TAG. A tag is a pointer its owner can move. `actions/checkout@v4` names
 * whatever commit `v4` points at on the day a job runs, so a compromised or careless release is
 * picked up by every run after it with no diff in this repository. A 40-hex commit SHA names bytes;
 * moving it is a reviewed edit here, and Dependabot (`.github/dependabot.yml`, `github-actions`)
 * proposes those edits so the pins do not rot.
 *
 * What is accepted:
 *   - `owner/repo@<40 hex>` and `owner/repo/path@<40 hex>` (a sub-action or a reusable workflow),
 *     followed by a `# vX.Y.Z` comment naming the release the SHA was resolved from, so a reviewer
 *     can read the pin and Dependabot can keep the comment in step;
 *   - `./local/path`, an action in this repository, which the checkout already pins;
 *   - `docker://image@sha256:<64 hex>`.
 * And in workflows, a job `container:` or `services:` image must carry `@sha256:<64 hex>` too
 * (`image: name:tag@sha256:...` — the tag may stay, for the reader).
 *
 * Anything else fails, with the file and line. A check that scanned nothing fails as well: an empty
 * `.github/` here means the script is running in the wrong directory, not that every pin is good.
 *
 * Usage, from the repository root:
 *   node scripts/ci/check-action-pins.mjs           # check this repository
 *   node scripts/ci/check-action-pins.mjs --self-test
 *
 * No dependencies and no network. The same file is carried by atlas, atlas-infra, atlas-sdks and
 * atlas-docs; keep the copies identical.
 */
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const SHA_PIN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[^@\s]+)?@[0-9a-f]{40}$/;
const DOCKER_PIN = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/;
const IMAGE_PIN = /^[^@\s]+@sha256:[0-9a-f]{64}$/;
// A full release (`v4.4.0`), not a moving major (`v4`): the comment exists to say which bytes the
// SHA is, and a major names no bytes.
const VERSION_COMMENT = /#\s*v?\d+\.\d+\.\d+\b/;

/** The files a GitHub Actions run can read a `uses:` from. */
function collect(root) {
  const files = [];
  const workflows = join(root, '.github', 'workflows');
  for (const name of safeList(workflows)) {
    if (/\.ya?ml$/.test(name)) files.push({ path: join(workflows, name), workflow: true });
  }
  const walk = (dir) => {
    for (const name of safeList(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/^action\.ya?ml$/.test(name)) files.push({ path: full, workflow: false });
    }
  };
  walk(join(root, '.github', 'actions'));
  return files;
}

function safeList(dir) {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function unquote(value) {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
    return v.slice(1, -1);
  return v;
}

/** Splits `value # comment` on the first ` #` outside quotes (YAML's comment rule). */
function splitComment(rest) {
  let quote = null;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(rest[i - 1])))
      return [rest.slice(0, i), rest.slice(i)];
  }
  return [rest, ''];
}

/** Returns the problems in one file's text. Pure, so the self-test can drive it. */
function check(text, { workflow }) {
  const problems = [];
  let refs = 0;
  let inContainer = false;
  let containerIndent = -1;
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const at = index + 1;
    if (/^\s*#/.test(line)) return;
    const uses = /^\s*(?:-\s+)?uses:\s*(.*)$/.exec(line);
    if (uses) {
      refs++;
      const [rawValue, comment] = splitComment(uses[1]);
      const value = unquote(rawValue);
      if (value.startsWith('./')) return;
      if (value.startsWith('docker://')) {
        if (!DOCKER_PIN.test(value))
          problems.push({ at, value, why: 'a docker:// action must be pinned by @sha256 digest' });
        return;
      }
      if (!SHA_PIN.test(value)) {
        problems.push({ at, value, why: 'not pinned by a full 40-hex commit SHA' });
        return;
      }
      if (!VERSION_COMMENT.test(comment))
        problems.push({
          at,
          value,
          why: 'SHA pin without a `# vX.Y.Z` comment naming its release',
        });
      return;
    }
    if (!workflow) return;
    // A job `container:` (string or mapping) and `services.<name>.image`.
    const indent = line.search(/\S/);
    if (inContainer && indent >= 0 && indent <= containerIndent) inContainer = false;
    const container = /^\s*container:\s*(.*)$/.exec(line);
    if (container) {
      const [rawValue] = splitComment(container[1]);
      const value = unquote(rawValue);
      if (value) {
        refs++;
        if (!IMAGE_PIN.test(value))
          problems.push({ at, value, why: 'container image not pinned by @sha256 digest' });
      } else {
        inContainer = true;
        containerIndent = indent;
      }
      return;
    }
    if (/^\s*services:\s*$/.test(line)) {
      inContainer = true;
      containerIndent = indent;
      return;
    }
    const image = /^\s*image:\s*(.*)$/.exec(line);
    if (image && inContainer) {
      const [rawValue] = splitComment(image[1]);
      const value = unquote(rawValue);
      refs++;
      if (!IMAGE_PIN.test(value))
        problems.push({ at, value, why: 'container image not pinned by @sha256 digest' });
    }
  });
  return { problems, refs };
}

function run(root) {
  const files = collect(root);
  if (files.length === 0) {
    console.error(`check-action-pins: no workflow or action files under ${join(root, '.github')}.`);
    console.error('Run it from the repository root. A check that read nothing has proved nothing.');
    return 1;
  }
  let total = 0;
  const found = [];
  for (const file of files) {
    const { problems, refs } = check(readFileSync(file.path, 'utf8'), file);
    total += refs;
    for (const p of problems) found.push({ file: relative(root, file.path), ...p });
  }
  if (found.length > 0) {
    console.error('Unpinned references (criterion 12: every `uses:` pinned by a full commit SHA):');
    for (const p of found) console.error(`  ${p.file}:${p.at}  ${p.value}  - ${p.why}`);
    console.error(`
Resolve a tag to its commit and pin it, keeping the tag as a comment:
  git ls-remote --tags https://github.com/<owner>/<repo>.git '<tag>' '<tag>^{}'
  uses: <owner>/<repo>@<40-hex sha> # <tag>
(an annotated tag lists two lines; the '^{}' one is the commit). Images: append @sha256:<digest>
from 'docker buildx imagetools inspect <image:tag>'.`);
    return 1;
  }
  console.log(
    `check-action-pins: ${total} references in ${files.length} files, every one pinned by SHA or digest.`,
  );
  return 0;
}

function selfTest() {
  const sha = 'a'.repeat(40);
  const digest = 'b'.repeat(64);
  const cases = [
    [`      - uses: actions/checkout@v4\n`, true, 'a tag pin'],
    [`      - uses: actions/checkout@${sha.slice(1)}  # v4.0.0\n`, true, 'a 39-hex SHA'],
    [`      - uses: actions/checkout@main # v4.0.0\n`, true, 'a branch pin'],
    [`      - uses: actions/checkout@${sha}\n`, true, 'a SHA without its version comment'],
    [`      - uses: actions/checkout@${sha} # v4\n`, true, 'a SHA whose comment names a major'],
    [`      - uses: "actions/checkout@v4" # pinned, honest\n`, true, 'a quoted tag pin'],
    [`      - uses: docker://alpine:3.20\n`, true, 'a docker:// tag'],
    [
      `    container:\n      image: mcr.microsoft.com/playwright:v1.61.1-noble\n`,
      true,
      'a container tag',
    ],
    [`    container: node:22\n`, true, 'a container string tag'],
    [`    services:\n      redis:\n        image: redis:7\n`, true, 'a service tag'],
    [`      - uses: actions/checkout@${sha} # v4.4.0\n`, false, 'a SHA pin'],
    [`      - uses: 'actions/checkout@${sha}' # v4.4.0\n`, false, 'a quoted SHA pin'],
    [`      - uses: github/codeql-action/upload-sarif@${sha} # v3.29.0\n`, false, 'a sub-action'],
    [`    uses: org/repo/.github/workflows/x.yml@${sha} # v1.2.3\n`, false, 'a reusable workflow'],
    [`      - uses: ./.github/actions/use-git-bash\n`, false, 'a local action'],
    [`      - uses: docker://alpine:3.20@sha256:${digest}\n`, false, 'a docker:// digest'],
    [`    container:\n      image: x/y:1.0@sha256:${digest}\n`, false, 'a container digest'],
    [`      # - uses: actions/checkout@v4\n`, false, 'a commented-out line'],
    [`      - run: echo "uses: actions/checkout@v4"\n`, false, 'text inside a run'],
  ];
  let failures = 0;
  for (const [text, shouldFail, label] of cases) {
    const { problems } = check(text, { workflow: true });
    if (problems.length > 0 !== shouldFail) {
      failures++;
      console.error(
        `self-test FAILED: ${label} - expected ${shouldFail ? 'a problem' : 'none'}, got`,
        problems,
      );
    }
  }

  // End to end: a planted tag pin in a scratch repository is refused, its SHA pin is accepted, and
  // an empty `.github/` is refused rather than reported clean.
  const root = mkdtempSync(join(tmpdir(), 'action-pins-'));
  try {
    const silence = console.error;
    console.error = () => {};
    const empty = run(root);
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    mkdirSync(join(root, '.github', 'actions', 'a'), { recursive: true });
    const wf = join(root, '.github', 'workflows', 'ci.yml');
    writeFileSync(
      wf,
      `jobs:\r\n  x:\r\n    steps:\r\n      - uses: actions/checkout@${sha} # v4.4.0\r\n`,
    );
    writeFileSync(
      join(root, '.github', 'actions', 'a', 'action.yml'),
      `runs:\n  using: composite\n  steps:\n    - uses: actions/setup-node@v4\n`,
    );
    const planted = run(root);
    writeFileSync(
      join(root, '.github', 'actions', 'a', 'action.yml'),
      `runs:\n  using: composite\n  steps:\n    - uses: actions/setup-node@${sha} # v4.4.0\n`,
    );
    const log = console.log;
    console.log = () => {};
    const clean = run(root);
    console.log = log;
    console.error = silence;
    if (empty !== 1) (failures++, console.error('self-test FAILED: an empty .github/ passed'));
    if (planted !== 1) (failures++, console.error('self-test FAILED: a planted tag pin passed'));
    if (clean !== 0) (failures++, console.error('self-test FAILED: a fully pinned tree failed'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  if (failures > 0) return 1;
  console.log(
    `check-action-pins self-test: ${cases.length} cases and a planted tag pin, all caught.`,
  );
  return 0;
}

process.exit(process.argv.includes('--self-test') ? selfTest() : run(process.cwd()));
