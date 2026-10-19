#!/usr/bin/env node
// EVERY CONTROL SECURITY.md CLAIMS NAMES WHAT HOLDS IT, AND THAT THING EXISTS (J4 criterion 14).
//
// A security policy that claims a control the code does not have is worse than one that says nothing:
// a reporter and a reviewer both read it as true. J4 found two such claims in this repository's own
// policy (the stale version table, J4-F36, and controls described in the present tense that were
// owed to later steps). So the claims live in one table, between the markers below, and each row
// names its evidence: a path, optionally with `#symbol` that must occur in that file. A row that
// names no evidence fails. So does a path that does not exist, or a symbol the file does not contain.
// A control that is OWED rather than built says so in its status column (`owed: J8`), names the step
// that owes it, and needs no evidence, because the honest claim is that it does not exist yet.
//
//   <!-- claims:start -->
//   | Control | Status | Evidence |
//   | --- | --- | --- |
//   | Sessions end on their next request | built | `apps/api/src/.../SessionLivenessFilter.java#class SessionLivenessFilter` |
//   | HSTS on Production | owed: J8 | — |
//   <!-- claims:end -->
//
// Usage: node scripts/security/check-security-claims.mjs [SECURITY.md] [--self-test]
// Same script in all four repositories; each checks its own SECURITY.md against its own tree.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const START = '<!-- claims:start -->';
const END = '<!-- claims:end -->';

/** The statuses a row may carry. "owed" must name the step that owes it. */
const STATUS = /^(built|owed: [A-Z]\d+[a-z0-9-]*)$/;

/** Every backticked span in a cell. */
function spans(cell) {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

/**
 * Checks one policy's text against a tree, returning the problems (empty when every claim holds).
 *
 * @param {string} text the SECURITY.md source
 * @param {string} root the repository root that evidence paths are relative to
 */
export function check(text, root) {
  const problems = [];
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start < 0 || end < start) {
    return [`no claims table: the policy must carry ${START} … ${END}`];
  }
  const rows = text
    .slice(start + START.length, end)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'))
    .slice(2); // the header and its rule
  if (rows.length === 0) {
    problems.push('the claims table is empty');
  }
  for (const row of rows) {
    const cells = row
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim());
    if (cells.length !== 3) {
      problems.push(`not three cells: ${row}`);
      continue;
    }
    const [control, status, evidence] = cells;
    if (!control) problems.push(`a row names no control: ${row}`);
    if (!STATUS.test(status)) {
      problems.push(`"${control}": status "${status}" is neither "built" nor "owed: <step>"`);
      continue;
    }
    const named = spans(evidence);
    if (status.startsWith('owed')) {
      continue;
    }
    if (named.length === 0) {
      problems.push(`"${control}" is claimed as built and names no evidence`);
      continue;
    }
    for (const item of named) {
      const hash = item.indexOf('#');
      const path = hash < 0 ? item : item.slice(0, hash);
      const symbol = hash < 0 ? null : item.slice(hash + 1);
      const full = resolve(root, path);
      if (!existsSync(full)) {
        problems.push(`"${control}": evidence ${path} does not exist`);
        continue;
      }
      if (symbol !== null) {
        if (statSync(full).isDirectory()) {
          problems.push(`"${control}": ${path} is a directory, so #${symbol} cannot be checked`);
        } else if (!readFileSync(full, 'utf8').includes(symbol)) {
          problems.push(`"${control}": ${path} does not contain "${symbol}"`);
        }
      }
    }
  }
  return problems;
}

function selfTest() {
  // `fileURLToPath`, not `URL.pathname`: the pathname keeps `%20` for a space (and every other escape),
  // so a checkout under a path with one resolved to a root that does not exist, and the self-test
  // failed its "a held claim passes" case for a reason that had nothing to do with the claims.
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const table = (rows) =>
    `x\n${START}\n| Control | Status | Evidence |\n| --- | --- | --- |\n${rows}\n${END}\n`;
  const cases = [
    [
      'a held claim passes',
      table(
        '| This script | built | `scripts/security/check-security-claims.mjs#export function check` |',
      ),
      0,
    ],
    ['an owed claim needs no evidence', table('| HSTS | owed: J8 | — |'), 0],
    ['a built claim with no evidence fails', table('| Magic | built | the code |'), 1],
    ['a missing path fails', table('| Ghost | built | `no/such/file.java` |'), 1],
    // Joined at run time: written whole, the symbol would occur in this very file and the case would pass.
    [
      'a missing symbol fails',
      table(
        '| Wrong | built | `scripts/security/check-security-claims.mjs#class No' + 'SuchThing` |',
      ),
      1,
    ],
    [
      'an unknown status fails',
      table('| Soon | planned | `scripts/security/check-security-claims.mjs` |'),
      1,
    ],
    ['no table fails', 'no markers here', 1],
  ];
  let failed = 0;
  for (const [name, text, expected] of cases) {
    const got = check(text, root).length;
    const ok = expected === 0 ? got === 0 : got > 0;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
    if (!ok) failed++;
  }
  if (failed) {
    console.error(`${failed} self-test case(s) failed`);
    process.exit(1);
  }
  console.log('self-test passed');
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  selfTest();
} else {
  const file = resolve(args[0] ?? 'SECURITY.md');
  const problems = check(readFileSync(file, 'utf8'), dirname(file));
  if (problems.length) {
    for (const problem of problems) console.error(`claim not held: ${problem}`);
    process.exit(1);
  }
  console.log(`every claim in ${file} names evidence that exists`);
}
