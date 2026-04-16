import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Exclude worktrees and other non-source directories
    exclude: [
      'node_modules',
      '.claude/worktrees/**',
      'dist/**',
    ],
  },
  coverage: {
    provider: 'v8',
    reporter: ['text', 'json-summary', 'html', 'lcov'],
    include: ['src/**/*.ts'],
    exclude: ['src/__tests__/**', 'dist/**', 'src/main.ts'],
    thresholds: {
      // Overall project thresholds
      statements: 60,
      branches: 45,
      functions: 55,
      lines: 60,
      // Per-file thresholds for auto-fail
      perFile: true,
      '**/src/providers/**': { statements: 25, branches: 20 },
      '**/src/channels/**': { statements: 40, branches: 30 },
      '**/src/utils/**': { statements: 70, branches: 60 },
      '**/src/markdown/**': { statements: 90, branches: 80 },
      '**/src/permissions/**': { statements: 80, branches: 70 },
    },
  },
});