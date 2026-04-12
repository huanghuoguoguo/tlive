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
    reporter: ['text', 'json-summary', 'html'],
    include: ['src/**/*.ts'],
    exclude: ['src/__tests__/**', 'dist/**'],
  },
});
