import { build } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';

// Read version from package.json for build-time injection
const packageJson = JSON.parse(readFileSync('package.json', 'utf-8'));

mkdirSync('dist/platforms', { recursive: true });

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
};

const entryPoints = [
  { entry: 'src/main.ts', outfile: 'dist/main.mjs' },
  { entry: 'src/platforms/telegram/adapter.ts', outfile: 'dist/platforms/telegram.mjs' },
  { entry: 'src/platforms/feishu/adapter.ts', outfile: 'dist/platforms/feishu.mjs' },
  { entry: 'src/platforms/qqbot/adapter.ts', outfile: 'dist/platforms/qqbot.mjs' },
  { entry: 'src/setup-wizard.ts', outfile: 'dist/setup.mjs' },
];

// Build all entry points
await Promise.all(
  entryPoints.map(({ entry, outfile }) =>
    build({ ...common, entryPoints: [entry], outfile })
  )
);
