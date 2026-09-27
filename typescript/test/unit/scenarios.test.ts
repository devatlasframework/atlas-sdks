import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OPERATIONS } from '../../src/generated/surface.js';
import { run } from '../live/scenarios.js';

// Every SDK runs scenarios/live.json as written, and this is the check that runs in CI. The live
// suite itself runs where the API does; what CI can hold without a network is that this SDK's
// runner implements exactly the scenarios the file lists - no fewer, so a scenario added for every
// SDK turns this one red until it exists here, and no more, so this suite cannot drift into testing
// something the others do not.

const spec = JSON.parse(readFileSync(new URL('../../../scenarios/live.json', import.meta.url), 'utf8')) as {
  scenarios: { id: string; operations: string[] }[];
};

describe('the live runner', () => {
  it('implements exactly the scenarios live.json lists', () => {
    const listed = spec.scenarios.map((scenario) => scenario.id);
    expect(new Set(listed).size, 'scenario ids are unique').toBe(listed.length);
    expect(Object.keys(run).sort()).toEqual([...listed].sort());
  });

  it('is given scenarios that, together, call every operation this SDK covers', () => {
    const named = new Set(spec.scenarios.flatMap((scenario) => scenario.operations));
    expect([...named].sort()).toEqual(Object.keys(OPERATIONS).sort());
  });
});
