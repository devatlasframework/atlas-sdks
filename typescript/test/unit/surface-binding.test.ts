import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KeyClient, PassClient } from '../../src/client.js';
import { CONTRACT, DEVELOPER_SCHEMES, ERROR_CODES, OPERATIONS } from '../../src/generated/surface.js';
import { SDK_VERSION } from '../../src/version.js';

// The SDK covers exactly what the contract lets a developer's credential call, and this file is
// what holds it there - in both directions, the way the API holds its own allow-lists to the
// contract. The operation list is never written down: it is derived from the contract's security
// arrays, so a new key-reachable operation turns this red until a method exists, and a removed one
// turns it red until the method goes.

type Operation = (typeof OPERATIONS)[keyof typeof OPERATIONS];
const entries = Object.entries(OPERATIONS) as [string, Operation][];
const admitting = (scheme: string) =>
  entries
    .filter(([, op]) => (op.credentials as readonly string[]).includes(scheme))
    .map(([id]) => id)
    .sort();

/** The operation methods a client class carries: functions on its prototype, nothing else. */
function methodsOf(type: { prototype: object }): string[] {
  return Object.getOwnPropertyNames(type.prototype)
    .filter((name) => name !== 'constructor')
    .filter((name) => typeof Object.getOwnPropertyDescriptor(type.prototype, name)?.value === 'function')
    .sort();
}

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('the surface this SDK covers', () => {
  it('has a client for each developer credential the contract defines, and no other', () => {
    expect([...DEVELOPER_SCHEMES].sort()).toEqual(['apiKeyAuth', 'delegatedPassAuth']);
  });

  it('gives a key client exactly the operations that admit an API key', () => {
    expect(methodsOf(KeyClient)).toEqual(admitting('apiKeyAuth'));
    expect(methodsOf(KeyClient)).toHaveLength(9);
  });

  it('gives a pass client exactly the operations that admit a delegated pass', () => {
    expect(methodsOf(PassClient)).toEqual(admitting('delegatedPassAuth'));
    expect(methodsOf(PassClient)).toHaveLength(3);
  });

  it('obtains a pass through the one operation the contract names as its issuer', () => {
    const issuers = entries.filter(([, op]) => 'issues' in op);
    expect(issuers.map(([id, op]) => [id, (op as { issues: string }).issues])).toEqual([
      ['exchangeDelegatedToken', 'delegatedPassAuth'],
    ]);
    expect(read('../../src/delegated.ts')).toContain(`'exchangeDelegatedToken'`);
  });

  it('covers ten operations, and every one is reachable from some part of the SDK', () => {
    const reachable = new Set([...methodsOf(KeyClient), ...methodsOf(PassClient), 'exchangeDelegatedToken']);
    expect([...reachable].sort()).toEqual(entries.map(([id]) => id).sort());
    expect(entries).toHaveLength(10);
  });
});

describe('the retry class of each operation', () => {
  it('comes from the contract, and the three the SDK must never repeat blindly are classed so', () => {
    for (const [id, op] of entries) {
      expect(['repeatable', 'repeatable-with-key', 'once'], id).toContain(op.retry);
    }
    // present counts every call; the token leg treats a replayed refresh token as theft.
    expect(OPERATIONS.presentForEndUser.retry).toBe('once');
    expect(OPERATIONS.exchangeDelegatedToken.retry).toBe('once');
    // The one operation that declares a repeat guard.
    expect(entries.filter(([, op]) => op.idempotencyKey).map(([id]) => id)).toEqual(['linkEndUser']);
    expect(OPERATIONS.linkEndUser.retry).toBe('repeatable-with-key');
  });
});

describe('the error codes the SDK branches on', () => {
  it('are all documented by the contract', () => {
    const sources = readdirSync(new URL('../../src/', import.meta.url)).filter((name) =>
      name.endsWith('.ts'),
    );
    const used = new Set(
      sources.flatMap((name) => read(`../../src/${name}`).match(/ATLAS-[A-Z]+-\d{3}/g) ?? []),
    );
    expect(used.size).toBeGreaterThan(0);
    for (const code of used) expect(ERROR_CODES as readonly string[], code).toContain(code);
  });
});

describe('the contract this build was generated from', () => {
  it('is the one the stamp names, byte for byte', () => {
    const stamp = read('../../../contract/SOURCE.md');
    // The value is the first backticked span AFTER the label: a label can carry backticks of its own.
    const field = (label: string) =>
      stamp
        .split(/\r?\n/)
        .find((line) => line.startsWith(`| ${label} | `))
        ?.slice(`| ${label} | `.length)
        .match(/^`([^`]*)`/)?.[1];
    const bytes = readFileSync(new URL('../../../contract/openapi.yaml', import.meta.url));

    expect(CONTRACT.version).toBe(field('Contract version'));
    expect(CONTRACT.sha256).toBe(field('`contract/openapi.yaml` sha256'));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(CONTRACT.sha256);
  });

  it("has a version of its own, and so does this SDK: the package version is the SDK's", () => {
    const manifest = JSON.parse(read('../../package.json')) as { version: string };
    expect(manifest.version).toBe(SDK_VERSION);
  });
});
