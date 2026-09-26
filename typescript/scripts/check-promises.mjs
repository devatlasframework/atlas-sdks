// Holds the public README's TypeScript promises to what this package actually is: "TS strict, ESM"
// and "Node 22+". Each promise is checked against the file that makes it true, so a README that
// keeps promising something the package stopped doing fails here instead of misleading somebody.
//
//   node scripts/check-promises.mjs   (after `npm run build`)

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(here, path), 'utf8');
const problems = [];

const readme = read('../README.md');
for (const promise of ['TS strict', 'ESM', 'Node 22+']) {
  if (!readme.includes(promise)) {
    problems.push(`the README no longer says "${promise}" - update this check with it, never silently`);
  }
}

// TS strict
const tsconfig = JSON.parse(read('tsconfig.json'));
if (tsconfig.compilerOptions?.strict !== true) problems.push('tsconfig.json is not "strict": true');

// ESM, and only ESM
const manifest = JSON.parse(read('package.json'));
if (manifest.type !== 'module') problems.push('package.json is not "type": "module"');
const conditions = Object.keys(manifest.exports?.['.'] ?? {});
if (conditions.join(',') !== 'types,import') {
  problems.push(
    `package.json exports "${conditions.join(', ')}"; an ESM-only package exports "types" and "import"`,
  );
}
if (manifest.main !== undefined)
  problems.push('package.json has a "main": a CommonJS entry point this package does not ship');
const emitted = readdirSync(join(here, 'dist')).filter((name) => name.endsWith('.js'));
if (emitted.length === 0) problems.push('dist/ holds no JavaScript: run `npm run build` first');
for (const name of emitted) {
  if (/\brequire\(|\bmodule\.exports\b/.test(read(`dist/${name}`))) problems.push(`dist/${name} is CommonJS`);
}

// Node 22+
if (manifest.engines?.node !== '>=22')
  problems.push(`package.json engines.node is "${manifest.engines?.node}", not ">=22"`);

// One version, and it is the SDK's
const declared = /export const SDK_VERSION = '([^']+)'/.exec(read('src/version.ts'))?.[1];
if (declared !== manifest.version) {
  problems.push(
    `src/version.ts says ${declared} and package.json says ${manifest.version}: a package version means one thing`,
  );
}

// The licence travels with the package
if (read('LICENSE') !== read('../LICENSE'))
  problems.push("typescript/LICENSE is not the repository's LICENSE");

if (problems.length) {
  for (const problem of problems) console.error(`check-promises: ${problem}`);
  process.exit(1);
}
console.log(
  `check-promises: TS strict, ESM only, Node >=22, version ${manifest.version} - as the README says.`,
);
