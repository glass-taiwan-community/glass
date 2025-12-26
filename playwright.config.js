/**
 * Playwright Test Configuration for Glass
 *
 * @see https://playwright.dev/docs/test-configuration
 */

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',

  // Test timeout (2 minutes per test for Electron startup)
  timeout: 120000,

  // Expect timeout for assertions
  expect: {
    timeout: 10000
  },

  // Global timeout for entire test run (15 minutes)
  globalTimeout: 900000,

  // Run tests in fully parallel mode
  fullyParallel: false,

  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: !!process.env.CI,

  // Retry on CI only
  retries: process.env.CI ? 1 : 0,

  // Opt out of parallel tests on CI and limit workers
  workers: process.env.CI ? 1 : undefined,

  // Increase worker teardown timeout for Electron cleanup
  maxFailures: process.env.CI ? 5 : undefined,

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
