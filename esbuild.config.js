import { build } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';

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
};

const entryPoints = [
  { entry: 'src/main.ts', outfile: 'dist/main.mjs' },
  { entry: 'src/channels/telegram.ts', outfile: 'dist/channels/telegram.mjs' },
  { entry: 'src/channels/feishu.ts', outfile: 'dist/channels/feishu.mjs' },
  { entry: 'src/channels/qqbot.ts', outfile: 'dist/channels/qqbot.mjs' },
  { entry: 'src/setup-wizard.ts', outfile: 'dist/setup.mjs' },
];

// Build all entry points
await Promise.all(
  entryPoints.map(({ entry, outfile }) =>
    build({ ...common, entryPoints: [entry], outfile })
  )
);
