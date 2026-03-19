#!/usr/bin/env node
// postinstall: download Go Core binary + copy hook scripts to ~/.tlive/bin/
import { createWriteStream, chmodSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform, arch } from 'node:os';
import { get } from 'node:https';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
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

function copyHookScripts() {
  mkdirSync(BIN_DIR, { recursive: true });

  const scripts = ['hook-handler.sh', 'notify-handler.sh'];
  for (const script of scripts) {
    const src = join(__dirname, script);
    const dest = join(BIN_DIR, script);
    if (existsSync(src)) {
      copyFileSync(src, dest);
      chmodSync(dest, 0o755);
    }
  }
  console.log(`Hook scripts installed to ${BIN_DIR}`);
}

async function downloadGoBinary() {
  const os = PLATFORM_MAP[platform()];
  const cpu = ARCH_MAP[arch()];

  if (!os || !cpu) {
    console.warn(`Unsupported platform: ${platform()}-${arch()}. Skipping binary download.`);
    console.warn('You can build from source: cd core && go build -o tlive ./cmd/tlive/');
    return;
  }

  const ext = os === 'windows' ? '.exe' : '';
  const binaryName = `tlive-core${ext}`;
  const dest = join(BIN_DIR, binaryName);

  if (existsSync(dest)) {
    console.log(`tlive-core already exists at ${dest}`);
    return;
  }

  mkdirSync(BIN_DIR, { recursive: true });

  const version = await getLatestVersion();
  const url = `https://github.com/${GITHUB_REPO}/releases/download/${version}/tlive-${os}-${cpu}${ext}`;

  console.log(`Downloading tlive-core for ${os}-${cpu}...`);

  try {
    await download(url, dest);
    if (os !== 'windows') {
      chmodSync(dest, 0o755);
    }
    console.log(`tlive-core installed to ${dest}`);
  } catch (err) {
    console.warn(`Failed to download tlive-core: ${err.message}`);
    console.warn('You can build from source: cd core && go build -o tlive-core ./cmd/tlive/');
    console.warn(`Then copy the binary to ${dest}`);
  }
}

async function main() {
  console.log('Setting up TLive...');
  copyHookScripts();
  await downloadGoBinary();
  console.log('TLive setup complete.');
}

main().catch(console.error);
