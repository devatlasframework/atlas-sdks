// Copies the ATLAS API contract into contract/openapi.yaml, byte for byte, and writes the stamp
// that names where it came from.
//
// Until a release mirrors a contract to atlas-docs, the SDKs are generated from the contract at a
// named commit of the private atlas monorepo. That puts a contract in this public repository before
// the release that publishes it. It is acceptable for one reason, and this script is where the
// reason is checked: the copy must describe exactly the operations the published mirror does. So
// nothing unreleased becomes public here except wording, error codes and declarations about
// operations that are public already. A contract that adds or removes an operation is refused.
//
// Run it locally, where both repositories are checked out. It never runs in CI: CI cannot see the
// private monorepo, which is why the stamp records a checksum that CI can check instead.
//
//   node tools/vendor-contract.mjs --from ../atlas --ref <commit> --mirror ../atlas-docs
//   node tools/vendor-contract.mjs --from ../atlas-docs --ref origin/develop --file api/openapi.yaml
//   node tools/vendor-contract.mjs --from ../atlas --working-tree --mirror ../atlas-docs
//
// The second form vendors the published mirror itself, which is what the release does. The third
// reads an uncommitted contract from disk, for working on an SDK and a contract change together.
// Its stamp names no commit, and verify-contract.mjs refuses a stamp that names no commit, so a
// working-tree copy can never pass CI.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { CONTRACT, STAMP, accessShape, operationsOf, parseContract, sha256, stampField } from './lib.mjs';

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const value = process.argv[at + 1];
  if (!value || value.startsWith('--')) fail(`--${name} needs a value`);
  return value;
}

function fail(message, code = 1) {
  console.error(`vendor-contract: ${message}`);
  process.exit(code);
}

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { maxBuffer: 64 * 1024 * 1024 });
}

const from = arg('from');
const workingTree = process.argv.includes('--working-tree');
const ref = workingTree ? undefined : arg('ref');
if (!from || (!ref && !workingTree)) {
  fail('usage: --from <repo> (--ref <commit> | --working-tree) [--file <path>] [--mirror <atlas-docs>]');
}

const fromRepo = resolve(from);
const fromName = basename(fromRepo);
const file = arg('file', fromName === 'atlas-docs' ? 'api/openapi.yaml' : 'packages/api-spec/openapi.yaml');
let sha;
let date;
let bytes;
if (workingTree) {
  sha = 'working-tree';
  date = new Date().toISOString().slice(0, 10);
  // Normalised to LF: those are the bytes git commits under `text=auto`, whatever autocrlf did to
  // this checkout, so the checksum is the one the committed copy will have.
  bytes = Buffer.from(readFileSync(join(fromRepo, file), 'utf8').replace(/\r\n/g, '\n'), 'utf8');
} else {
  sha = git(fromRepo, 'rev-parse', '--verify', `${ref}^{commit}`).toString().trim();
  date = git(fromRepo, 'log', '-1', '--format=%cs', sha).toString().trim();
  // `git show` prints the blob as stored, so these are the committed (LF) bytes whatever this
  // machine's autocrlf does to a working copy.
  bytes = git(fromRepo, 'show', `${sha}:${file}`);
}
const doc = parseContract(bytes.toString('utf8'));
const version = doc.info?.version;
if (!version) fail(`${file} at ${sha} has no info.version`);

let compared;
if (fromName === 'atlas-docs') {
  compared = 'none: this copy is the published mirror itself';
} else {
  const mirror = arg('mirror');
  if (!mirror) {
    fail('vendoring from the monorepo needs --mirror <atlas-docs>, to check the operations are all public');
  }
  const mirrorRepo = resolve(mirror);
  const mirrorRef = arg('mirror-ref', 'origin/develop');
  const mirrorSha = git(mirrorRepo, 'rev-parse', '--verify', `${mirrorRef}^{commit}`).toString().trim();
  const mirrorDoc = parseContract(git(mirrorRepo, 'show', `${mirrorSha}:api/openapi.yaml`).toString('utf8'));
  const mirrorVersion = stampField(git(mirrorRepo, 'show', `${mirrorSha}:api/MIRROR.md`).toString('utf8'), 'Contract version');

  // Not just the operation list: who can reach each operation, with which permission, every
  // permission a scheme publishes and every webhook event. A contract that opens one more operation
  // to a key would describe the same operations and still publish a capability nobody has released.
  const here = accessShape(doc);
  const published = accessShape(mirrorDoc);
  const unpublished = [...here].filter((op) => !published.has(op));
  const withdrawn = [...published].filter((op) => !here.has(op));
  if (unpublished.length || withdrawn.length) {
    for (const line of unpublished) console.error(`  not in the published mirror: ${line}`);
    for (const line of withdrawn) console.error(`  published, and absent here: ${line}`);
    fail(
      `contract ${version} at ${sha.slice(0, 12)} exposes a different surface from the published ` +
        `mirror (${mirrorVersion} at atlas-docs ${mirrorRef}). Vendoring it would publish an unreleased ` +
        'surface in this public repository. Wait for the release that mirrors it.',
      2,
    );
  }
  compared = `atlas-docs \`${mirrorRef}\`, contract \`${mirrorVersion}\`: the same ${operationsOf(doc).length} operations, reachable with the same permissions, and the same webhook events`;
}

const digest = sha256(bytes);
writeFileSync(CONTRACT, bytes);
writeFileSync(
  STAMP,
  [
    '# Contract stamp',
    '',
    'Written by `tools/vendor-contract.mjs` - do not edit by hand. `openapi.yaml` beside this file is a',
    'byte-for-byte copy of the ATLAS API contract at the commit below. Every SDK in this repository is',
    'generated from it, through `surface.json`, and the `contract` check fails if either file stops',
    'matching what this stamp names.',
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Contract version | \`${version}\` |`,
    `| Source repository | \`${fromName}\` |`,
    `| Source commit | \`${sha}\` |`,
    `| Source commit date | \`${date}\` |`,
    `| \`contract/openapi.yaml\` sha256 | \`${digest}\` |`,
    `| Operations compared with | ${compared} |`,
    '',
  ].join('\n'),
);
console.log(`vendor-contract: contract ${version} from ${fromName}@${sha.slice(0, 12)} (${date}), sha256 ${digest}.`);
console.log('Now run: node tools/derive-surface.mjs');
