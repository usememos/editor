import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  // Spread single tests, not whole files, over workers and CI shards: fuzz.spec alone is about a quarter of the run.
  fullyParallel: true,
  use: {
    baseURL: 'http://localhost:5179',
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' }, testIgnore: /perf\.spec\.ts/ },
    // A class on every theme key (see playground/main.ts) must change no
    // behavior. The editor never reads class names, so the specs that cover
    // every block type, copy and paste, and random editing are enough.
    {
      name: 'themed',
      use: {
        browserName: 'chromium',
        storageState: { cookies: [{ name: 'mbe-themed', value: '1', domain: 'localhost', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] },
      },
      testMatch: /(playground|clipboard|fuzz)\.spec\.ts/,
    },
    // Every browser test also runs in Firefox and WebKit. CI installs both.
    { name: 'firefox', use: { browserName: 'firefox' }, testIgnore: /perf\.spec\.ts/ },
    { name: 'webkit', use: { browserName: 'webkit' }, testIgnore: /perf\.spec\.ts/ },
    // Timing gates. Run alone (npm run test:perf) so other tests do not skew them.
    { name: 'perf', use: { browserName: 'chromium' }, testMatch: /perf\.spec\.ts/ },
  ],
  // The playground, built and served as static files. Each test opens a new
  // page, and the dev server's 55 module requests made that load about half
  // of each test's time; the build loads in 7. It is built on every run, so
  // it never serves old code. `npm run dev` uses another port.
  webServer: {
    command:
      'npx vite build --config playground/vite.config.ts --logLevel warn && npx vite preview --config playground/vite.config.ts --port 5179 --strictPort',
    url: 'http://localhost:5179',
    reuseExistingServer: true,
  },
});
