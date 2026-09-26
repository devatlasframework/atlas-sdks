import { readFileSync } from 'node:fs';
import openapiTS, { astToString } from 'openapi-typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { KeyClient, type LearnerProfile } from '../../src/client.js';
import { loopback, type Loopback } from './loopback.js';

// The test every generator must pass, whatever the language, judged on what it produces over the
// covered surface - never on a feature list. The profile is a real one: built by the ATLAS scorer
// from a learner answering every dimension, so it carries both sub-dimension shapes. A fixture with
// an empty map, the one input that never builds the union, is how a route once stayed green while
// it failed for every real profile.

const { profile } = JSON.parse(
  readFileSync(new URL('../../../scenarios/fixtures/profile-scored.json', import.meta.url), 'utf8'),
) as { profile: LearnerProfile };

const ORG = '11111111-1111-4111-8111-111111111111';
// A made-up key: it is sent only to the loopback server below.
const TEST_KEY = 'generator-test-key-not-a-credential';
const END_USER = '22222222-2222-4222-8222-222222222222';

let server: Loopback | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('the discriminator, on write', () => {
  it('reaches the wire for every entry of both shapes, with every map key untouched', async () => {
    server = await loopback({ status: 200, body: { endorsements: [] } });
    const atlas = new KeyClient({ baseUrl: server.baseUrl, apiKey: TEST_KEY, orgId: ORG });
    await atlas.presentForEndUser(END_USER, { profile });

    const sent = server.received[0]!.body.toString('utf8');
    expect(sent).toBe(JSON.stringify({ profile }));

    const onTheWire = (JSON.parse(sent) as { profile: LearnerProfile }).profile;
    const shapes = Object.values(onTheWire.subDimensionScores).map((score) => score.structureType);
    expect(shapes).toContain('bipolar');
    expect(shapes).toContain('multi-category');
    expect(shapes.every((shape) => shape === 'bipolar' || shape === 'multi-category')).toBe(true);
    expect(Object.keys(onTheWire.subDimensionScores)).toEqual(Object.keys(profile.subDimensionScores));

    // Map keys are data - sub-dimension codes and category names - and a generator that converts
    // property names must leave them alone.
    expect(Object.keys(onTheWire.categoryScores)).toContain('D3a.Small Group');
    const d1 = onTheWire.subDimensionScores.D1;
    expect(d1?.structureType).toBe('multi-category');
    expect(Object.keys(d1?.structureType === 'multi-category' ? d1.categories : {})).toContain('Read/Write');
  });
});

describe('the discriminator, on read', () => {
  it('returns what the API sent, field for field, including fields this SDK does not know yet', async () => {
    const answer = {
      endorsements: [{ key: 'D2a.Quiet', dimension: 'D2a' }],
      addedInALaterMinor: { kept: true },
    };
    server = await loopback({ status: 200, body: answer });
    const atlas = new KeyClient({ baseUrl: server.baseUrl, apiKey: TEST_KEY, orgId: ORG });
    await expect(atlas.presentForEndUser(END_USER, { profile })).resolves.toEqual(answer);
  });
});

describe('the generated types', () => {
  it('are reproduced byte for byte from the pinned generator, and match what is committed', async () => {
    const surface = JSON.parse(
      readFileSync(new URL('../../../contract/surface.json', import.meta.url), 'utf8'),
    ) as Parameters<typeof openapiTS>[0];
    const once = astToString(await openapiTS(structuredClone(surface)));
    const twice = astToString(await openapiTS(structuredClone(surface)));
    expect(twice).toBe(once);

    const committed = readFileSync(
      new URL('../../src/generated/contract.ts', import.meta.url),
      'utf8',
    ).replace(/\r\n/g, '\n');
    expect(committed.endsWith(once)).toBe(true);
  });
});
