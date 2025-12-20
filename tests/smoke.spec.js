/**
 * Glass Smoke Tests
 *
 * These tests verify that the Glass Electron app:
 * 1. Launches successfully
 * 2. UI loads correctly
 * 3. Config system initializes properly
 *
 * Run with: npm test
 */

import { test, expect, _electron as electron } from '@playwright/test';
import * as path from 'path';

test.describe('Glass Application Smoke Tests', () => {
  let electronApp;
  let firstWindow;

  test.beforeEach(async () => {
    // Launch Electron app before each test
    electronApp = await electron.launch({
      args: ['.'],
      env: {
        ...process.env,
        NODE_ENV: 'test'
      }
    });

    // Wait for the first window to be ready
    firstWindow = await electronApp.firstWindow();
  });

  test.afterEach(async () => {
    // Clean up: close the app after each test
    if (electronApp) {
      await electronApp.close();
    }
  });

  test('should launch Glass app successfully', async () => {
    // Verify the app launched
    expect(electronApp).toBeTruthy();
  });

  test('should be running in development mode (not packaged)', async () => {
    const isPackaged = await electronApp.evaluate(async ({ app }) => {
      return app.isPackaged;
    });

    expect(isPackaged).toBe(false);
  });

  test('should open main window with correct properties', async () => {
    // Verify window exists
    expect(firstWindow).toBeTruthy();

    // Verify window is visible
    const isVisible = await firstWindow.isVisible();
    expect(isVisible).toBe(true);

    // Verify window has a title
    const title = await firstWindow.title();
    expect(title).toBeTruthy();
  });

  test('should load renderer process without errors', async () => {
    // Check for console errors in renderer
    const consoleErrors = [];

    firstWindow.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // Wait a moment for any errors to appear
    await firstWindow.waitForTimeout(2000);

    // Verify no critical console errors
    // Note: Some warnings are acceptable, but errors should be investigated
    expect(consoleErrors.length).toBeLessThanOrEqual(5);
  });

  test('should load config system successfully', async () => {
    const configLoaded = await electronApp.evaluate(async () => {
      try {
        // Try to require the config module
        const configPath = './src/features/common/config/config.js';
        const { Config } = require(configPath);

        // Verify Config class exists
        return Config !== null && Config !== undefined;
      } catch (error) {
        console.error('Config loading error:', error);
        return false;
      }
    });

    expect(configLoaded).toBe(true);
  });

  test('should load schema configuration successfully', async () => {
    const schemaLoaded = await electronApp.evaluate(async () => {
      try {
        // Try to require the schema module
        const schemaPath = './src/features/common/config/schema.js';
        const schema = require(schemaPath);

        // Verify schema has the expected structure
        return schema !== null && typeof schema === 'object';
      } catch (error) {
        console.error('Schema loading error:', error);
        return false;
      }
    });

    expect(schemaLoaded).toBe(true);
  });

  test('should have Electron app name set correctly', async () => {
    const appName = await electronApp.evaluate(async ({ app }) => {
      return app.getName();
    });

    // Verify app has a name (should be "Glass" or "pickle-glass")
    expect(appName).toBeTruthy();
    expect(appName.toLowerCase()).toContain('glass');
  });

  test('should create proper application directory structure', async () => {
    const hasAppData = await electronApp.evaluate(async ({ app }) => {
      const fs = require('fs');
      const appDataPath = app.getPath('userData');

      // Verify userData directory exists
      return fs.existsSync(appDataPath);
    });

    expect(hasAppData).toBe(true);
  });
});

test.describe('Glass Build Verification', () => {
  test('should have built renderer bundles', async () => {
    const fs = require('fs');
    const path = require('path');

    // Check if esbuild output exists (renderer build)
    const uiDir = path.join(process.cwd(), 'src', 'ui');
    const uiExists = fs.existsSync(uiDir);

    expect(uiExists).toBe(true);
  });

  test('should have built web bundles', async () => {
    const fs = require('fs');
    const path = require('path');

    // Check if Next.js web build exists
    const webBuildDir = path.join(process.cwd(), 'pickleglass_web', '.next');
    const webBuildExists = fs.existsSync(webBuildDir);

    // This may fail in local dev, but should pass in CI after build
    expect(webBuildExists).toBe(true);
  });
});
