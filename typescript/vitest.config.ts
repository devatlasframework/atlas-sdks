import { defineConfig } from 'vitest/config';

// The unit suite: no network egress. Every test that needs HTTP talks to a real server on a
// loopback socket, so the SDK is exercised through the platform's own fetch and nothing is mocked
// at the module level. The live suite, which calls a deployed API, has its own config.
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    typecheck: { enabled: true, include: ['test/unit/**/*.test-d.ts'], tsconfig: './tsconfig.json' },
  },
});
