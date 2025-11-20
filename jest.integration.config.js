/**
 * Jest configuration for integration tests
 * These tests use real Redis and BullMQ workers, so we use forceExit
 */
const baseConfig = require('./jest.config.js');

module.exports = {
  ...baseConfig,
  testMatch: ['**/tests/integration/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'], // Remove the integration exclusion
  forceExit: true,
  testTimeout: 60000,
};
