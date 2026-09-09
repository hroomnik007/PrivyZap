import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.{test,spec}.ts'],
    // index.ts validates these on import and calls process.exit(1) if absent;
    // NODE_ENV=test additionally prevents app.listen()/cron from starting.
    // The DB is mocked in integration tests, so DATABASE_URL is never dialed.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://test:test@localhost:5432/mintradar_test',
      ALLOWED_ORIGINS: 'https://mintradar.org,http://localhost:5173',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'dist/'],
    },
  },
})
