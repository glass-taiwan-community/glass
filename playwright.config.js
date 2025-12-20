/**
 * Playwright Test Configuration for Glass
 *
 * @see https://playwright.dev/docs/test-configuration
 */

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',

  // Test timeout (30 seconds per test)
  timeout: 30000,

  // Expect timeout for assertions
  expect: {
    timeout: 5000
  },

  // Run tests in fully parallel mode
  fullyParallel: false,

  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: !!process.env.CI,

  // Retry on CI only
  retries: process.env.CI ? 2 : 0,

  // Opt out of parallel tests on CI
  workers: process.env.CI ? 1 : undefined,

  // Reporter to use
  reporter: process.env.CI
    ? [['html'], ['github']]
    : [['list'], ['html']],

  // Shared settings for all projects
  use: {
    // Base URL for page.goto()
    // baseURL: 'http://localhost:3000',

    // Collect trace when retrying the failed test
    trace: 'on-first-retry',

    // Screenshot on failure
    screenshot: 'only-on-failure',

    // Video on failure
    video: 'retain-on-failure',
  },

  // Configure projects for different scenarios if needed
  projects: [
    {
      name: 'electron',
      testMatch: '**/*.spec.js',
    },
  ],

  // Output folder for test artifacts
  outputDir: 'test-results/',
});
