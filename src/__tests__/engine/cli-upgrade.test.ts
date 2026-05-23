import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

function writePackage(root: string, version: string): void {
  const packageJson = { name: 'tlive-test-app', version, type: 'module', dependencies: {} };
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(packageJson, null, 2),
  );
  writeFileSync(
    join(root, 'package-lock.json'),
    JSON.stringify(
      {
        name: packageJson.name,
        version,
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': packageJson,
        },
      },
      null,
      2,
    ),
  );
}

function copyCli(root: string): void {
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'cli.js'), readFileSync(resolve('scripts/cli.js'), 'utf-8'));
}

function writeBridgeEntry(root: string, version: string): void {
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist', 'main.mjs'), `
import { mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.TLIVE_HOME;
const runtime = join(home, 'runtime');
mkdirSync(runtime, { recursive: true });
writeFileSync(join(runtime, 'status.json'), JSON.stringify({
  pid: process.pid,
  startedAt: new Date().toISOString(),
  readyAt: new Date().toISOString(),
  channels: ['feishu'],
  version: '${version}'
}, null, 2));

process.on('SIGTERM', () => {
  try {
    const pidFile = join(runtime, 'bridge.pid');
    if (readFileSync(pidFile, 'utf-8').trim() === String(process.pid)) unlinkSync(pidFile);
  } catch {}
  process.exit(0);
});
setInterval(() => {}, 1000);
`);
}

function writeClientEntry(root: string): void {
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist', 'client.mjs'), `
import { mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.TLIVE_HOME;
const runtime = join(home, 'runtime');
mkdirSync(runtime, { recursive: true });
writeFileSync(join(runtime, 'client-status.json'), JSON.stringify({
  pid: process.pid,
  startedAt: new Date().toISOString(),
  serverUrl: process.env.TL_REMOTE_SERVER_URL,
}, null, 2));

process.on('SIGTERM', () => {
  try {
    const pidFile = join(runtime, 'client.pid');
    if (readFileSync(pidFile, 'utf-8').trim() === String(process.pid)) unlinkSync(pidFile);
  } catch {}
  process.exit(0);
});
setInterval(() => {}, 1000);
`);
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('CLI upgrade flow', () => {
  let tmpRoot: string;
  const processesToKill: number[] = [];

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'tlive-cli-upgrade-'));
  });

  afterEach(async () => {
    for (const pid of processesToKill.splice(0)) {
      if (isRunning(pid)) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('stops the old bridge, installs the release package, starts the new bridge, and writes success result', async () => {
    const tliveHome = join(tmpRoot, 'home');
    const runtimeDir = join(tliveHome, 'runtime');
    const appDir = join(tmpRoot, 'app');
    const releaseDir = join(tmpRoot, 'release-app');
    const tarball = join(tmpRoot, 'tlive-v0.13.5.tar.gz');
    mkdirSync(runtimeDir, { recursive: true });
    mkdirSync(appDir, { recursive: true });
    mkdirSync(releaseDir, { recursive: true });

    writePackage(appDir, '0.13.4');
    copyCli(appDir);
    writeBridgeEntry(appDir, '0.13.4');
    writeClientEntry(appDir);

    writePackage(releaseDir, '0.13.5');
    copyCli(releaseDir);
    writeBridgeEntry(releaseDir, '0.13.5');
    writeClientEntry(releaseDir);
    execFileSync('tar', ['czf', tarball, '-C', releaseDir, '.']);

    const baseEnv = {
      ...process.env,
      TLIVE_HOME: tliveHome,
      TLIVE_RELEASE_TARBALL_PATH: tarball,
    };
    const startResult = spawnSync(process.execPath, [join(appDir, 'scripts', 'cli.js'), 'start'], {
      encoding: 'utf-8',
      timeout: 10000,
      env: baseEnv,
    });
    expect(startResult.status, `${startResult.stdout}\n${startResult.stderr}`).toBe(0);
    const oldPid = Number(readFileSync(join(runtimeDir, 'bridge.pid'), 'utf-8'));
    const oldClientPid = Number(readFileSync(join(runtimeDir, 'client.pid'), 'utf-8'));
    processesToKill.push(oldPid);
    processesToKill.push(oldClientPid);

    const result = spawnSync(process.execPath, [join(appDir, 'scripts', 'cli.js'), 'upgrade', '0.13.5'], {
      encoding: 'utf-8',
      timeout: 90000,
      env: baseEnv,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf-8')).version).toBe('0.13.5');
    expect(readdirSync(tmpRoot).some(name => name.startsWith('app-backup-'))).toBe(true);
    expect(isRunning(oldPid)).toBe(false);
    expect(isRunning(oldClientPid)).toBe(false);

    const status = JSON.parse(readFileSync(join(runtimeDir, 'status.json'), 'utf-8'));
    expect(status.version).toBe('0.13.5');
    expect(status.channels).toEqual(['feishu']);
    expect(status.readyAt).toBeTruthy();
    processesToKill.push(status.pid);
    processesToKill.push(Number(readFileSync(join(runtimeDir, 'client.pid'), 'utf-8')));

    const upgradeResult = JSON.parse(readFileSync(join(runtimeDir, 'upgrade-result.json'), 'utf-8'));
    expect(upgradeResult).toMatchObject({
      success: true,
      version: '0.13.5',
      previousVersion: '0.13.4',
    });
  });

  it('restarts the bridge daemon', async () => {
    const tliveHome = join(tmpRoot, 'home');
    const runtimeDir = join(tliveHome, 'runtime');
    const appDir = join(tmpRoot, 'app');
    mkdirSync(runtimeDir, { recursive: true });
    mkdirSync(appDir, { recursive: true });

    writePackage(appDir, '0.13.6');
    copyCli(appDir);
    writeBridgeEntry(appDir, '0.13.6');
    writeClientEntry(appDir);

    const baseEnv = {
      ...process.env,
      TLIVE_HOME: tliveHome,
    };
    const startResult = spawnSync(process.execPath, [join(appDir, 'scripts', 'cli.js'), 'start'], {
      encoding: 'utf-8',
      timeout: 10000,
      env: baseEnv,
    });
    expect(startResult.status, `${startResult.stdout}\n${startResult.stderr}`).toBe(0);
    const oldPid = Number(readFileSync(join(runtimeDir, 'bridge.pid'), 'utf-8'));
    const oldClientPid = Number(readFileSync(join(runtimeDir, 'client.pid'), 'utf-8'));
    processesToKill.push(oldPid);
    processesToKill.push(oldClientPid);
    unlinkSync(join(runtimeDir, 'bridge.pid'));

    const result = spawnSync(process.execPath, [join(appDir, 'scripts', 'cli.js'), 'restart'], {
      encoding: 'utf-8',
      timeout: 45000,
      env: baseEnv,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('Bridge stopped.');
    expect(result.stdout).toContain('Local client stopped.');
    expect(result.stdout).toContain('Bridge healthy');
    expect(isRunning(oldPid)).toBe(false);
    expect(isRunning(oldClientPid)).toBe(false);

    const status = JSON.parse(readFileSync(join(runtimeDir, 'status.json'), 'utf-8'));
    expect(status.version).toBe('0.13.6');
    expect(status.channels).toEqual(['feishu']);
    expect(status.pid).not.toBe(oldPid);
    expect(isRunning(status.pid)).toBe(true);
    processesToKill.push(status.pid);
    processesToKill.push(Number(readFileSync(join(runtimeDir, 'client.pid'), 'utf-8')));
  });

  it('keeps upgrade restart standalone when requested', async () => {
    const tliveHome = join(tmpRoot, 'home');
    const runtimeDir = join(tliveHome, 'runtime');
    const appDir = join(tmpRoot, 'app');
    const releaseDir = join(tmpRoot, 'release-app');
    const tarball = join(tmpRoot, 'tlive-v0.13.8.tar.gz');
    mkdirSync(runtimeDir, { recursive: true });
    mkdirSync(appDir, { recursive: true });
    mkdirSync(releaseDir, { recursive: true });

    writePackage(appDir, '0.13.7');
    copyCli(appDir);
    writeBridgeEntry(appDir, '0.13.7');
    writeClientEntry(appDir);

    writePackage(releaseDir, '0.13.8');
    copyCli(releaseDir);
    writeBridgeEntry(releaseDir, '0.13.8');
    writeClientEntry(releaseDir);
    execFileSync('tar', ['czf', tarball, '-C', releaseDir, '.']);

    const baseEnv = {
      ...process.env,
      TLIVE_HOME: tliveHome,
      TLIVE_RELEASE_TARBALL_PATH: tarball,
    };
    const startResult = spawnSync(
      process.execPath,
      [join(appDir, 'scripts', 'cli.js'), 'start', '--standalone'],
      {
        encoding: 'utf-8',
        timeout: 10000,
        env: baseEnv,
      },
    );
    expect(startResult.status, `${startResult.stdout}\n${startResult.stderr}`).toBe(0);
    const oldPid = Number(readFileSync(join(runtimeDir, 'bridge.pid'), 'utf-8'));
    processesToKill.push(oldPid);
    expect(existsSync(join(runtimeDir, 'client.pid'))).toBe(false);

    const result = spawnSync(
      process.execPath,
      [join(appDir, 'scripts', 'cli.js'), 'upgrade', '--standalone', '0.13.8'],
      {
        encoding: 'utf-8',
        timeout: 90000,
        env: baseEnv,
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(isRunning(oldPid)).toBe(false);
    expect(existsSync(join(runtimeDir, 'client.pid'))).toBe(false);

    const status = JSON.parse(readFileSync(join(runtimeDir, 'status.json'), 'utf-8'));
    expect(status.version).toBe('0.13.8');
    expect(isRunning(status.pid)).toBe(true);
    processesToKill.push(status.pid);
  });
});
