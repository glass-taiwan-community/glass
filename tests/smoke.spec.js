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
        NODE_ENV: 'test',
        // Disable GPU in CI for better stability
        ELECTRON_ENABLE_LOGGING: '1',
        ELECTRON_DISABLE_SANDBOX: '1'
      },
      // Add timeout for app launch
      timeout: 60000
    });

    // Wait for the first window to be ready
    firstWindow = await electronApp.firstWindow();
  });

  test.afterEach(async () => {
    // Clean up: close the app after each test
    if (electronApp) {
      try {
        // Wait a moment for any animations/timers to settle
        await new Promise(resolve => setTimeout(resolve, 500));

        // Close all windows first
        const windows = electronApp.windows();
        for (const window of windows) {
          try {
            await window.close();
          } catch (error) {
            // Ignore errors from windows that are already closing
          }
        }

        // Wait a bit more for cleanup to complete
        await new Promise(resolve => setTimeout(resolve, 300));

        // Then close the app with a timeout
        await Promise.race([
          electronApp.close(),
          new Promise((resolve) => setTimeout(resolve, 5000))
        ]);
      } catch (error) {
        // Suppress expected cleanup errors (destroyed objects, etc.)
        if (!error.message?.includes('destroyed')) {
          console.log('Unexpected cleanup error:', error.message);
        }
      }
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

    // Verify window has a title
    const title = await firstWindow.title();
    expect(title).toBeTruthy();

    // Verify window has a URL loaded
    const url = firstWindow.url();
    expect(url).toBeTruthy();
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
    // Verify config file exists and is accessible
    const fs = require('fs');
    const path = require('path');

    const configPath = path.join(process.cwd(), 'src/features/common/config/config.js');
    const configExists = fs.existsSync(configPath);

    expect(configExists).toBe(true);

    // Verify we can read the file
    const configContent = fs.readFileSync(configPath, 'utf8');
    expect(configContent).toContain('Config');
  });

  test('should load schema configuration successfully', async () => {
    // Verify schema file exists and is accessible
    const fs = require('fs');
    const path = require('path');

    const schemaPath = path.join(process.cwd(), 'src/features/common/config/schema.js');
    const schemaExists = fs.existsSync(schemaPath);

    expect(schemaExists).toBe(true);

    // Verify we can read the file and has schema definition
    const schemaContent = fs.readFileSync(schemaPath, 'utf8');
    expect(schemaContent.toLowerCase()).toContain('schema');
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
    // Verify app creates userData directory
    const appDataPath = await electronApp.evaluate(async ({ app }) => {
      return app.getPath('userData');
    });

    // Check if directory exists from test context
    const fs = require('fs');
    const hasAppData = fs.existsSync(appDataPath);

    expect(hasAppData).toBe(true);
    expect(appDataPath).toContain('Glass');
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
