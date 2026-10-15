import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

// Read version from package.json for build-time injection
const packageJson = JSON.parse(readFileSync('package.json', 'utf-8'));

// Build fingerprint. Baked into the bundle so a running bridge (or a bare
// dist/main.mjs copied somewhere) can always be traced back to the exact
// commit it came from. Without this, "which build is actually deployed?" is
// unanswerable — the install directory name and its package.json say nothing
// about where its dist/ was built.
function gitOutput(args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

const buildSha = gitOutput(['rev-parse', '--short=9', 'HEAD']);
const buildBranch = gitOutput(['rev-parse', '--abbrev-ref', 'HEAD']);
const buildTime = new Date().toISOString();

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: [
    '@anthropic-ai/*',
    '@earendil-works/*',
    '@larksuiteoapi/*',
    '@mariozechner/*',
    '@silvia-odwyer/*',
    'undici',
    'ws',
    'better-sqlite3',
  ],
  sourcemap: true,
  define: {
    'process.env.npm_package_version': JSON.stringify(packageJson.version),
    'process.env.TLIVE_BUILD_SHA': JSON.stringify(buildSha),
    'process.env.TLIVE_BUILD_BRANCH': JSON.stringify(buildBranch),
    'process.env.TLIVE_BUILD_TIME': JSON.stringify(buildTime),
  },
};

const entryPoints = [
  { entry: 'src/server/main.ts', outfile: 'dist/main.mjs' },
  { entry: 'src/client/main.ts', outfile: 'dist/client.mjs' },
  { entry: 'src/client/providers/claude-setup-wizard.ts', outfile: 'dist/setup.mjs' },
];

// Build all entry points
await Promise.all(
  entryPoints.map(({ entry, outfile }) => build({ ...common, entryPoints: [entry], outfile })),
);

const fingerprint = buildSha ? `${buildSha}${buildBranch ? ` @ ${buildBranch}` : ''}` : 'no-git';
console.log(`Built v${packageJson.version} (${fingerprint}) at ${buildTime}`);
