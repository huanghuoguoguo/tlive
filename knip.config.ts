import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  // Scripts are standalone entrypoints (invoked by shell, not imported by src/)
  // Plus explicit esbuild entry points
  entry: [
    'scripts/hook-handler.mjs',
    'scripts/notify-handler.mjs',
    'scripts/stop-handler.mjs',
    'scripts/statusline.mjs',
    'src/main.ts',
    'src/setup-wizard.ts',
    'src/platforms/telegram/adapter.ts',
    'src/platforms/feishu/adapter.ts',
    'src/platforms/qqbot/adapter.ts',
  ],
  project: ['src/**/*.ts'],
  // Ignore barrel re-export files (public API surface)
  ignore: [
    'src/channels/index.ts',
    'src/engine/index.ts',
    'src/formatting/index.ts',
    'src/messages/index.ts',
    'src/ui/index.ts',
    'src/platforms/feishu/index.ts',
    'src/platforms/qqbot/index.ts',
    'src/platforms/telegram/index.ts',
  ],
  // Exported types are API boundaries — keep them even if not imported elsewhere
  ignoreExportsUsedInFile: true,
  ignoreDependencies: [
    '@biomejs/biome',
    '@vitest/coverage-v8',
    'chokidar-cli',
    'nodemon',
  ],
  ignoreBinaries: ['chokidar', 'nodemon', 'tsc', 'biome', 'vitest', 'knip'],
};

export default config;
