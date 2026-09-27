/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  // *.spec.ts are pure unit tests; *.int-spec.ts run against a real MongoDB replica set.
  testRegex: '.*\\.(spec|int-spec)\\.ts$',
  globalSetup: '<rootDir>/test/support/global-setup.ts',
  globalTeardown: '<rootDir>/test/support/global-teardown.ts',
  testTimeout: 30000,
};
