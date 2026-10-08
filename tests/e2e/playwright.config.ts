import { defineConfig } from '@playwright/test'

const port = Number(process.env.E2E_PORT || 3223)

/** Owner office walk-through with stubbed office API. Screenshots go to output/ (not in Git). */
export default defineConfig({
  testDir: '.',
  testMatch: /office\.spec\.ts$/,
  outputDir: '../../output/playwright/stream-c/results',
  timeout: 120000,
  expect: { timeout: 15000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    reducedMotion: 'reduce',
  },
  webServer: {
    command: `npx nuxt dev --host 127.0.0.1 --port ${port}`,
    cwd: '../..',
    url: `http://127.0.0.1:${port}/office/login`,
    reuseExistingServer: true,
    timeout: 180000,
  },
})
