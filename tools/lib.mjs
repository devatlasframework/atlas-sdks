// Shared by the contract tools. Everything here reads the contract; nothing here decides what an
// SDK covers - that rule lives in derive-surface.mjs, in one place.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CONTRACT = join(ROOT, 'contract', 'openapi.yaml');
export const STAMP = join(ROOT, 'contract', 'SOURCE.md');
export const SURFACE = join(ROOT, 'contract', 'surface.json');

export const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The contract as a plain object. `uniqueKeys` stays on (the default): a duplicated key is a
 * broken contract, and a parser that kept the last one would generate from half of it.
 */
export function parseContract(text) {
  return parse(text, { uniqueKeys: true });
}

export function readContract(path = CONTRACT) {
  const bytes = readFileSync(path);
  return { bytes, doc: parseContract(bytes.toString('utf8')) };
}

/** Every operation, in file order, with the path item it sits in. */
export function operationsOf(doc) {
  const operations = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of METHODS) {
      if (item[method]) {
        operations.push({ method, path, operationId: item[method].operationId, node: item[method], item });
      }
    }
  }
  return operations;
}

/**
 * Who can reach what, independent of what the schemes are called: for every operation, the
 * permissions each of its security requirements names (a signed-in session's own default is left
 * out, since no SDK holds one), plus every permission any scheme publishes and every webhook event.
 * Two contracts with the same access shape expose the same capabilities to a developer, whatever
 * their wording. A scheme rename (`oauth2` became `delegatedPassAuth`) leaves it unchanged; a
 * newly key-reachable operation, a new permission or a new event changes it.
 */
export function accessShape(doc) {
  const session = new Set((doc.security ?? []).flatMap((requirement) => Object.keys(requirement)));
  const operations = operationsOf(doc).map((op) => {
    const requirements = (op.node.security ?? doc.security ?? [])
      .map((requirement) => {
        const schemes = Object.keys(requirement);
        if (schemes.length === 0) return 'anyone';
        if (schemes.every((scheme) => session.has(scheme))) return null;
        return schemes
          .filter((scheme) => !session.has(scheme))
          .map((scheme) => [...(requirement[scheme] ?? [])].sort().join('+') || 'no-scope')
          .join('&');
      })
      .filter((requirement) => requirement !== null)
      .sort();
    return `${op.method.toUpperCase()} ${op.path} (${op.operationId}) <- ${requirements.join(' | ') || 'session only'}`;
  });
  const scopes = new Set();
  for (const [name, scheme] of Object.entries(doc.components?.securitySchemes ?? {})) {
    if (session.has(name)) continue;
    for (const scope of Object.keys(scheme['x-atlas-scopes'] ?? {})) scopes.add(scope);
    for (const flow of Object.values(scheme.flows ?? {})) {
      for (const scope of Object.keys(flow.scopes ?? {})) scopes.add(scope);
    }
  }
  return new Set([
    ...operations,
    ...[...scopes].map((scope) => `permission ${scope}`),
    ...Object.keys(doc.webhooks ?? {}).map((event) => `webhook ${event}`),
  ]);
}

/** One field of a stamp table (`| Label | \`value\` |`), or undefined when the row is missing. */
export function stampField(stampText, label) {
  const row = stampText.split(/\r?\n/).find((line) => line.startsWith(`| ${label} | `));
  return row?.slice(`| ${label} | `.length).match(/^`([^`]*)`/)?.[1];
}
