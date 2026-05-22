import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  entry: [
    'src/providers/claude-setup-wizard.ts',
    'src/channels/feishu/adapter.ts',
  ],
  project: ['src/**/*.ts'],
  // Only ignore type exports used in the same file (interface/type definitions).
  // Function/const exports used only in the same file ARE flagged.
  ignoreExportsUsedInFile: { interface: true, type: true },
};

export default config;
