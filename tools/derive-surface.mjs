// Derives contract/surface.json - the part of the ATLAS API contract the SDKs cover - from
// contract/openapi.yaml. The rule, in the one place it is written:
//
//   An SDK covers every operation whose `security` admits a developer credential, plus the
//   operation that a developer credential's scheme names in `x-atlas-issued-by`.
//
// A developer credential is a scheme that publishes the permissions it can be granted
// (`x-atlas-scopes`): an API key, and a delegated pass. A signed-in person's own session publishes
// none, because no application is ever given one, and an operation only a session can call is not
// something an SDK should offer.
//
// No list of operations exists anywhere in this repository. When the contract lets a key reach one
// more operation, this output changes, and each SDK's binding test turns red until the SDK covers it.
//
//   node tools/derive-surface.mjs          # write contract/surface.json
//   node tools/derive-surface.mjs --check  # exit 1 if contract/surface.json is not current

import { readFileSync, writeFileSync } from 'node:fs';
import { SURFACE, operationsOf, readContract, sha256 } from './lib.mjs';

function fail(message) {
  console.error(`derive-surface: ${message}`);
  process.exit(1);
}

// RFC 9110 section 9.2.2: repeating one of these has the same effect as sending it once.
const IDEMPOTENT_METHODS = new Set(['get', 'head', 'options', 'put', 'delete']);

const { bytes, doc } = readContract();
const components = doc.components ?? {};
const schemes = components.securitySchemes ?? {};

const developerSchemes = Object.entries(schemes)
  .filter(([, scheme]) => scheme['x-atlas-scopes'] && typeof scheme['x-atlas-scopes'] === 'object')
  .map(([name]) => name);
if (developerSchemes.length === 0) {
  fail('no security scheme publishes x-atlas-scopes, so nothing identifies a developer credential');
}

const operations = operationsOf(doc);

// operationId -> the scheme whose credential it issues
const issuers = new Map();
for (const name of developerSchemes) {
  const named = schemes[name]['x-atlas-issued-by'];
  if (named === undefined) continue;
  const matches = operations.filter((op) => op.operationId === named);
  if (matches.length !== 1) {
    fail(`${name} names ${named} as the operation that issues it, and ${matches.length} operations carry that id`);
  }
  if (!Array.isArray(matches[0].node.security) || matches[0].node.security.length !== 0) {
    fail(`${named} issues ${name} and declares a credential of its own; an application calling it holds none yet`);
  }
  issuers.set(named, name);
}

function resolveRef(ref) {
  const match = /^#\/components\/([^/]+)\/(.+)$/.exec(ref);
  if (!match) fail(`a $ref this tool cannot follow: ${ref}`);
  const [, kind, raw] = match;
  const name = raw.replace(/~1/g, '/').replace(/~0/g, '~');
  const target = components[kind]?.[name];
  if (target === undefined) fail(`${ref} points at nothing`);
  return { kind, name, target };
}

const deref = (node) => (node && typeof node.$ref === 'string' ? resolveRef(node.$ref).target : node);

const surface = [];
for (const op of operations) {
  const security = op.node.security ?? doc.security ?? [];
  const admitted = security.filter((requirement) =>
    Object.keys(requirement).some((scheme) => developerSchemes.includes(scheme)),
  );
  const issues = issuers.get(op.operationId);
  if (admitted.length === 0 && issues === undefined) continue;

  for (const requirement of admitted) {
    const together = Object.keys(requirement);
    if (together.some((scheme) => !developerSchemes.includes(scheme))) {
      fail(
        `${op.method.toUpperCase()} ${op.path} requires ${together.join(' AND ')} together, and an SDK ` +
          'holds no session to send beside its own credential',
      );
    }
  }

  const parameters = [...(op.item.parameters ?? []), ...(op.node.parameters ?? [])].map(deref);
  const idempotencyKey = parameters.some(
    (parameter) => parameter.in === 'header' && parameter.name.toLowerCase() === 'idempotency-key',
  );
  const retry = IDEMPOTENT_METHODS.has(op.method)
    ? 'repeatable'
    : idempotencyKey
      ? 'repeatable-with-key'
      : 'once';

  const scopes = {};
  for (const requirement of admitted) Object.assign(scopes, requirement);

  surface.push({
    op,
    security: admitted,
    entry: {
      operationId: op.operationId,
      method: op.method.toUpperCase(),
      path: op.path,
      credentials: Object.keys(scopes),
      scopes,
      ...(issues ? { issues } : {}),
      idempotencyKey,
      retry,
    },
  });
}

// Everything the surface and the webhooks refer to, followed transitively, in the order the
// contract declares it. Discriminator mappings are followed too: they name schemas by a string
// that is not a `$ref`, and a variant reachable only that way is still a shape an SDK reads.
const kept = new Map();
function walk(node) {
  if (Array.isArray(node)) {
    node.forEach(walk);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const refs = typeof node.$ref === 'string' ? [node.$ref] : [];
  if (node.discriminator?.mapping) refs.push(...Object.values(node.discriminator.mapping));
  for (const ref of refs) {
    const { kind, name, target } = resolveRef(ref);
    if (!kept.has(kind)) kept.set(kind, new Set());
    if (!kept.get(kind).has(name)) {
      kept.get(kind).add(name);
      walk(target);
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key !== '$ref') walk(value);
  }
}

const paths = {};
for (const { op, security } of surface) {
  const item = (paths[op.path] ??= {});
  if (op.item.parameters && !item.parameters) item.parameters = op.item.parameters;
  item[op.method] = { ...op.node, security };
  walk(op.item.parameters ?? []);
  walk(op.node);
}
walk(doc.webhooks ?? {});

const derivedComponents = {};
for (const [kind, entries] of Object.entries(components)) {
  if (kind === 'securitySchemes') {
    derivedComponents.securitySchemes = Object.fromEntries(
      Object.entries(entries).filter(([name]) => developerSchemes.includes(name)),
    );
    continue;
  }
  const names = kept.get(kind);
  if (!names) continue;
  derivedComponents[kind] = Object.fromEntries(Object.entries(entries).filter(([name]) => names.has(name)));
}

const usedTags = new Set(surface.flatMap(({ op }) => op.node.tags ?? []));

const derived = {
  openapi: doc.openapi,
  info: doc.info,
  servers: doc.servers,
  ...(doc.tags ? { tags: doc.tags.filter((tag) => usedTags.has(tag.name)) } : {}),
  'x-atlas-derived': {
    rule:
      'Every operation whose security admits a scheme publishing x-atlas-scopes (a developer ' +
      'credential), plus the operation such a scheme names in x-atlas-issued-by. Security ' +
      'requirements naming only a signed-in session are dropped, and so are the schemes they name.',
    retry:
      'repeatable: an idempotent method (RFC 9110). repeatable-with-key: the operation declares an ' +
      'Idempotency-Key header, and every attempt carries the same key. once: anything else, never ' +
      'retried after a failure that may have reached the server. Every class retries a 429 after ' +
      'its Retry-After, because a throttled request did nothing.',
    from: { version: doc.info.version, sha256: sha256(bytes) },
    developerSchemes,
    operations: surface.map(({ entry }) => entry),
  },
  paths,
  webhooks: doc.webhooks,
  components: derivedComponents,
};

const text = `${JSON.stringify(derived, null, 2)}\n`;
const schemaCount = Object.keys(derivedComponents.schemas ?? {}).length;
const summary =
  `${surface.length} operations (${developerSchemes.join(', ')}), ${schemaCount} schemas, ` +
  `${Object.keys(doc.webhooks ?? {}).length} webhooks, from contract ${doc.info.version}`;

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(SURFACE, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    fail('contract/surface.json is missing. Run: node tools/derive-surface.mjs');
  }
  if (current !== text) {
    fail(`contract/surface.json is not what the contract derives to (${summary}). Run: node tools/derive-surface.mjs`);
  }
  console.log(`derive-surface: current - ${summary}.`);
} else {
  writeFileSync(SURFACE, text);
  console.log(`derive-surface: wrote contract/surface.json - ${summary}.`);
  for (const { entry } of surface) {
    console.log(`  ${entry.method.padEnd(6)} ${entry.path.padEnd(48)} ${entry.operationId.padEnd(24)} ${entry.retry}`);
  }
}
