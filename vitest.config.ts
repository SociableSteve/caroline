import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    // Tests that assert on logging pass their own stream and level.
    env: { CAROLINE_LOG_LEVEL: 'silent' },
    projects: [
      {
        extends: true,
        test: {
          name: 'server',
          environment: 'node',
          include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['web/**/*.test.tsx', 'web/**/*.test.ts'],
          setupFiles: ['web/test-setup.ts'],
        },
      },
    ],
  },
})
