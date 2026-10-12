import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  use: {
    baseURL: 'http://localhost:5179',
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' }, testIgnore: /perf\.spec\.ts/ },
    // The same tests with a class on every theme key (see playground/main.ts).
    {
      name: 'themed',
      use: {
        browserName: 'chromium',
        storageState: { cookies: [{ name: 'mbe-themed', value: '1', domain: 'localhost', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] },
      },
      // theme.spec sets its own themes.
      testIgnore: /(perf|theme)\.spec\.ts/,
    },
    // Only the IME tests run in Firefox and WebKit so far: composition by
    // events, in each engine's DOM. CI installs both browsers.
    { name: 'firefox', use: { browserName: 'firefox' }, testMatch: /ime\.spec\.ts/ },
    { name: 'webkit', use: { browserName: 'webkit' }, testMatch: /ime\.spec\.ts/ },
    // Timing gates. Run alone (npm run test:perf) so other tests do not skew them.
    { name: 'perf', use: { browserName: 'chromium' }, testMatch: /perf\.spec\.ts/ },
  ],
  webServer: {
    command: 'npx vite --config playground/vite.config.ts --port 5179 --strictPort',
    url: 'http://localhost:5179',
    reuseExistingServer: true,
  },
});
