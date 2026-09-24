import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    testTimeout: 15000,
    hookTimeout: 15000,
    fileParallelism: false,
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL || 'postgres://farm:test@127.0.0.1:55432/farm_test',
      OWNER_PASSWORD: 'test-owner-password-at-least-20',
      SESSION_SECRET: 'test-session-secret-at-least-forty-characters-long',
      APP_ORIGIN: 'http://localhost:3210',
      MODEL_PROVIDER: 'demo',
      SEARCH_PROVIDER: 'demo',
      PAYMENT_MODE: 'sandbox',
      SECURE_COOKIE: 'false',
      AUTONOMY_ENABLED: 'false',
    },
  },
})
