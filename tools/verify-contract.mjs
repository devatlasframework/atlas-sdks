// Checks that contract/openapi.yaml is the contract its stamp names, and that the derived surface
// was derived from it.
//
// WHAT IT CANNOT DO: it cannot see the repository the contract was copied from, so it cannot prove
// these bytes are the ones that commit holds. vendor-contract.mjs reads them with `git show` where
// both repositories are visible. This check keeps the copy honest after it lands: a hand edit to
// the contract, or a surface derived from something else, fails here.
//
//   node tools/verify-contract.mjs

import { existsSync, readFileSync } from 'node:fs';
import { CONTRACT, STAMP, SURFACE, parseContract, sha256, stampField } from './lib.mjs';

const problems = [];

for (const path of [CONTRACT, STAMP, SURFACE]) {
  if (!existsSync(path)) {
    console.error(`verify-contract: ${path} is missing. Every SDK here is generated from these three files.`);
    process.exit(1);
  }
}

const stamp = readFileSync(STAMP, 'utf8');
const version = stampField(stamp, 'Contract version');
const commit = stampField(stamp, 'Source commit');
const expected = stampField(stamp, '`contract/openapi.yaml` sha256');
for (const [label, value] of [
  ['Contract version', version],
  ['Source commit', commit],
  ['`contract/openapi.yaml` sha256', expected],
]) {
  if (!value) problems.push(`the stamp has no "${label}" row`);
}

if (commit && !/^[0-9a-f]{40}$/.test(commit)) {
  problems.push(
    `the stamp's source commit is "${commit}". A contract vendored from a working tree names no ` +
      'commit, so nobody can say which contract these SDKs describe. Vendor it again with --ref.',
  );
}

const bytes = readFileSync(CONTRACT);
const actual = sha256(bytes);
if (expected && actual !== expected) {
  problems.push(
    `contract/openapi.yaml sha256 is ${actual}, and the stamp says ${expected}. Never edit the ` +
      'contract here: change it in atlas and vendor it again.',
  );
}

const declared = parseContract(bytes.toString('utf8')).info?.version;
if (declared !== version) {
  problems.push(`contract/openapi.yaml says info.version ${declared ?? 'absent'}, and the stamp says ${version}`);
}

const derivedFrom = JSON.parse(readFileSync(SURFACE, 'utf8'))['x-atlas-derived']?.from;
if (derivedFrom?.sha256 !== actual || derivedFrom?.version !== declared) {
  problems.push(
    `contract/surface.json was derived from ${derivedFrom?.version ?? '?'} (${derivedFrom?.sha256 ?? '?'}), ` +
      `not from this contract. Run: node tools/derive-surface.mjs`,
  );
}

if (problems.length) {
  for (const problem of problems) console.error(`verify-contract: ${problem}`);
  process.exit(1);
}
console.log(`verify-contract: contract ${version} at ${commit.slice(0, 12)} - the copy, its stamp and the derived surface agree.`);
