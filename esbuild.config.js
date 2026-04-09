import { build } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';

const isWatch = process.argv.includes('--watch');

// Read version from package.json for build-time injection
const packageJson = JSON.parse(readFileSync('package.json', 'utf-8'));

mkdirSync('dist/channels', { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: [
    '@anthropic-ai/*',
    'grammy',
    '@grammyjs/*',
    '@larksuiteoapi/*',
    'node-telegram-bot-api',
    'socks-proxy-agent',
    'https-proxy-agent',
    'undici',
    'ws',
  ],
  sourcemap: true,
  define: {
    'process.env.npm_package_version': JSON.stringify(packageJson.version),
  },
  ...(isWatch ? { watch: true } : {}),
};

// Build main + adapters separately for lazy loading
await Promise.all([
  build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.mjs' }),
  build({ ...common, entryPoints: ['src/channels/telegram.ts'], outfile: 'dist/channels/telegram.mjs' }),
  build({ ...common, entryPoints: ['src/channels/feishu.ts'], outfile: 'dist/channels/feishu.mjs' }),
  build({ ...common, entryPoints: ['src/channels/qqbot.ts'], outfile: 'dist/channels/qqbot.mjs' }),
  build({ ...common, entryPoints: ['src/setup-wizard.ts'], outfile: 'dist/setup.mjs' }),
]);
