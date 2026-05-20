import { build } from 'esbuild';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';

// Read version from package.json for build-time injection
const packageJson = JSON.parse(readFileSync('package.json', 'utf-8'));

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: [
    '@anthropic-ai/*',
    '@larksuiteoapi/*',
    'undici',
  ],
  sourcemap: true,
  define: {
    'process.env.npm_package_version': JSON.stringify(packageJson.version),
  },
};

const entryPoints = [
  { entry: 'src/main.ts', outfile: 'dist/main.mjs' },
  { entry: 'src/setup-wizard.ts', outfile: 'dist/setup.mjs' },
];

// Build all entry points
await Promise.all(
  entryPoints.map(({ entry, outfile }) =>
    build({ ...common, entryPoints: [entry], outfile })
  )
);
