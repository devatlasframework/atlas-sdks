import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPERATIONS } from '../../src/generated/surface.js';
import { VERSIONS } from '../../src/version.js';
import { exercised, results, run, setCurrent, spec, transcript } from './scenarios.js';

// The live suite: ../scenarios/live.json, executed against a deployed API. Configuration comes from
// the environment, or from typescript/.env.live (never committed). Credentials are only ever sent
// to ATLAS_BASE_URL, and none appears in the transcript this writes to live-results/.
//
//   NODE_EXTRA_CA_CERTS=<your CA, if the API's certificate is not publicly trusted> npm run test:live

const envFile = new URL('../../.env.live', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);
const missing = Object.keys(spec.requires).filter((name) => !process.env[name]);

describe('the live scenarios', () => {
  beforeAll(() => {
    if (missing.length > 0) {
      throw new Error(
        `the live suite needs ${missing.join(', ')} - see scenarios/live.json. It fails rather than skips: ` +
          'a live run that never reached the API would prove nothing.',
      );
    }
  });

  for (const scenario of spec.scenarios) {
    it(scenario.id, async () => {
      const implementation = run[scenario.id];
      if (!implementation) throw new Error(`this runner does not implement the scenario "${scenario.id}"`);
      setCurrent(scenario.id);
      await implementation();
      const seen = [...(exercised.get(scenario.id) ?? [])];
      for (const operation of scenario.operations)
        expect(seen, `${scenario.id} calls ${operation}`).toContain(operation);
    });
  }

  it('called every operation this SDK covers, on the deployed API', () => {
    const called = new Set([...exercised.values()].flatMap((seen) => [...seen]));
    expect([...called].sort()).toEqual(Object.keys(OPERATIONS).sort());
    expect(transcript.length, 'responses received').toBeGreaterThan(0);
  });

  afterAll(() => {
    const report = {
      ranAt: new Date().toISOString(),
      versions: VERSIONS,
      results,
      responses: transcript.length,
      transcript,
    };
    mkdirSync(new URL('../../live-results/', import.meta.url), { recursive: true });
    const file = new URL(
      `../../live-results/run-${report.ranAt.replace(/[:.]/g, '-')}.json`,
      import.meta.url,
    );
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    console.log(
      `\n  live results: ${JSON.stringify({ versions: VERSIONS, responses: transcript.length, results }, null, 2)}\n`,
    );
  });
});
