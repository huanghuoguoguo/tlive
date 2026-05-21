import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  entry: [
    'src/providers/claude-setup-wizard.ts',
    'src/channels/feishu/adapter.ts',
  ],
  project: ['src/**/*.ts'],
  // Barrel files with unused re-exports — these are dead code themselves (tracked in docs/code-health-audit.md)
  // Ignore them so they don't flood the report with 30+ re-export warnings
  ignore: [
    'src/ui/index.ts',
    'src/channels/index.ts',
    'src/channels/*/index.ts',
  ],
  // Only ignore type exports used in the same file (interface/type definitions).
  // Function/const exports used only in the same file ARE flagged.
  ignoreExportsUsedInFile: { interface: true, type: true },
};

export default config;
