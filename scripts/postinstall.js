#!/usr/bin/env node
// Downloads precompiled tlive binary for current platform
import { createWriteStream, chmodSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform, arch } from 'node:os';
import { get } from 'node:https';
import { execSync } from 'node:child_process';

const GITHUB_REPO = 'tlive/tlive';
const BIN_DIR = join(homedir(), '.tlive', 'bin');

const PLATFORM_MAP = { linux: 'linux', darwin: 'darwin', win32: 'windows' };
const ARCH_MAP = { x64: 'amd64', arm64: 'arm64' };

async function getLatestVersion() {
  try {
    const result = execSync(
      `curl -sf https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      { encoding: 'utf-8', timeout: 10000 }
    );
    const data = JSON.parse(result);
    return data.tag_name || 'latest';
  } catch {
    return 'latest';
  }
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    get(url, (res) => {
      // Follow redirects
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', reject);
  });
}

async function main() {
  const os = PLATFORM_MAP[platform()];
  const cpu = ARCH_MAP[arch()];

  if (!os || !cpu) {
    console.warn(`Unsupported platform: ${platform()}-${arch()}. Skipping binary download.`);
    console.warn('You can build from source: cd core && go build -o tlive ./cmd/tlive/');
    return;
  }

  const ext = os === 'windows' ? '.exe' : '';
  const binaryName = `tlive${ext}`;
  const dest = join(BIN_DIR, binaryName);

  if (existsSync(dest)) {
    console.log(`tlive already exists at ${dest}`);
    return;
  }

  mkdirSync(BIN_DIR, { recursive: true });

  const version = await getLatestVersion();
  const url = `https://github.com/${GITHUB_REPO}/releases/download/${version}/tlive-${os}-${cpu}${ext}`;

  console.log(`Downloading tlive for ${os}-${cpu}...`);
  console.log(`  URL: ${url}`);

  try {
    await download(url, dest);
    if (os !== 'windows') {
      chmodSync(dest, 0o755);
    }
    console.log(`tlive installed to ${dest}`);
  } catch (err) {
    console.warn(`Failed to download tlive: ${err.message}`);
    console.warn('You can build from source: cd core && go build -o tlive ./cmd/tlive/');
    console.warn(`Then copy the binary to ${dest}`);
  }
}

main().catch(console.error);
