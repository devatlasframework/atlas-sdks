import { defineConfig } from 'vitest/config';

// The live suite: every scenario in ../scenarios/live.json, run in file order against the deployed
// API named by ATLAS_BASE_URL. It is never part of `npm test`, and it fails rather than skips when
// its configuration is missing - a green live run that never opened a socket proves nothing.
export default defineConfig({
  test: {
    include: ['test/live/**/*.test.ts'],
    environment: 'node',
    sequence: { concurrent: false },
    fileParallelism: false,
    testTimeout: 15 * 60 * 1000,
    hookTimeout: 5 * 60 * 1000,
  },
});
