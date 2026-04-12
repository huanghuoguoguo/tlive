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
});