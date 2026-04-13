import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  // Scripts are standalone entrypoints (invoked by shell, not imported by src/)
  entry: [
    'src/main.ts',
    'src/setup-wizard.ts',
    'src/platforms/telegram/adapter.ts',
    'src/platforms/feishu/adapter.ts',
    'src/platforms/qqbot/adapter.ts',
  ],
  project: ['src/**/*.ts'],
  // Ignore barrel re-export files (public API surface)
  ignore: [
    'src/engine/index.ts',
    'src/formatting/index.ts',
    'src/messages/index.ts',
    'src/ui/index.ts',
  ],
  // Exported types are API boundaries — keep them even if not imported elsewhere
  ignoreExportsUsedInFile: true,
  // husky is used via npm prepare script, not direct import
  ignoreDependencies: ['husky'],
  // Binaries used via npm scripts or CLI, not direct import
  ignoreBinaries: ['husky', 'knip'],
};

export default config;
