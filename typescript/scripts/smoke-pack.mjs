// Packs the tarball a release attaches, checks what is inside it, installs it into an empty project
// and imports it as ESM - the way somebody installing from a release will. Prints the tarball's
// sha256, which is what release notes carry.
//
//   node scripts/smoke-pack.mjs   (after `npm run build`)

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
// npm's own CLI script, run with this Node: no shell on any platform, so no argument is ever
// re-parsed by one. `npm run` sets npm_execpath, which is why this runs as `npm run smoke:pack`.
const cli = process.env.npm_execpath;
if (!cli) throw new Error('run this as `npm run smoke:pack`, which tells it where npm is');
const npm = (args, cwd) => execFileSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });

const scratch = mkdtempSync(join(tmpdir(), 'atlas-sdk-pack-'));
try {
  const [packed] = JSON.parse(npm(['pack', '--json', '--pack-destination', scratch], here));
  const files = packed.files.map((file) => file.path).sort();
  const unexpected = files.filter((path) => !/^(dist\/|LICENSE$|README\.md$|package\.json$)/.test(path));
  if (unexpected.length) throw new Error(`the tarball carries files it should not: ${unexpected.join(', ')}`);
  if (!files.includes('dist/index.js') || !files.includes('dist/index.d.ts')) {
    throw new Error('the tarball has no dist/index.js and dist/index.d.ts');
  }

  const tarball = join(scratch, packed.filename);
  const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex');

  const project = join(scratch, 'consumer');
  mkdirSync(project);
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify({ name: 'consumer', private: true, type: 'module' }),
  );
  npm(['install', '--no-audit', '--no-fund', tarball], project);
  writeFileSync(
    join(project, 'check.mjs'),
    [
      "import * as sdk from '@devatlasframework/sdk';",
      "for (const name of ['KeyClient', 'PassClient', 'verifyWebhook', 'exchangeCode', 'createPkcePair', 'AtlasApiError']) {",
      "  if (typeof sdk[name] !== 'function') throw new Error(`${name} is not exported`);",
      '}',
      "if (!/^\\d+\\.\\d+\\.\\d+$/.test(sdk.SDK_VERSION) || !/^\\d+\\.\\d+\\.\\d+$/.test(sdk.CONTRACT_VERSION)) throw new Error('versions missing');",
      "let refused = false; try { new sdk.KeyClient({ apiKey: 'x' }); } catch (e) { refused = e instanceof sdk.AtlasConfigurationError; }",
      "if (!refused) throw new Error('a client without a base URL was not refused');",
      'console.log(`imported ${sdk.SDK_VERSION}, generated from contract ${sdk.CONTRACT_VERSION}`);',
    ].join('\n'),
  );
  const imported = execFileSync(process.execPath, ['check.mjs'], { cwd: project, encoding: 'utf8' }).trim();
  console.log(
    `smoke-pack: ${packed.filename} (${files.length} files, sha256 ${digest}) installs; ${imported}.`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
