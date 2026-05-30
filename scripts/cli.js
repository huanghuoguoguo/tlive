#!/usr/bin/env node
// TLive CLI entry point
import { execSync, spawn, spawnSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, chmodSync, openSync, closeSync, copyFileSync, statSync, readSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const [,, command, ...args] = process.argv;

const PACKAGE_ROOT = join(__dirname, '..');
const isWindows = process.platform === 'win32';
const REPO = 'huanghuoguoguo/tlive';
const TLIVE_HOME = process.env.TLIVE_HOME?.trim() || join(homedir(), '.tlive');
const RUNTIME_DIR = join(TLIVE_HOME, 'runtime');
const LOG_DIR = join(TLIVE_HOME, 'logs');
const BRIDGE_PID = join(RUNTIME_DIR, 'bridge.pid');
const CLIENT_PID = join(RUNTIME_DIR, 'client.pid');
const BRIDGE_ENTRY = join(PACKAGE_ROOT, 'dist', 'main.mjs');
const CLIENT_ENTRY = join(PACKAGE_ROOT, 'dist', 'client.mjs');
const CONFIG_FILE = join(TLIVE_HOME, 'config.env');
const SERVER_CONFIG_FILE = join(TLIVE_HOME, 'server.env');
const CLIENT_CONFIG_FILE = join(TLIVE_HOME, 'client.env');
const UPGRADE_RESULT_FILE = join(RUNTIME_DIR, 'upgrade-result.json');
const STATUS_FILE = join(RUNTIME_DIR, 'status.json');
const RELEASE_BASE_URL = process.env.TLIVE_RELEASE_BASE_URL?.trim();
const RELEASE_TARBALL_PATH = process.env.TLIVE_RELEASE_TARBALL_PATH?.trim();

function getVersion() {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8')).version;
  } catch { return 'unknown'; }
}

/** Write upgrade result for bridge to notify user after restart */
function writeUpgradeResult(result) {
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true });
    writeFileSync(UPGRADE_RESULT_FILE, JSON.stringify({
      ...result,
      chatId: process.env.TLIVE_UPGRADE_CHAT_ID,
      channelType: process.env.TLIVE_UPGRADE_CHANNEL_TYPE,
      timestamp: new Date().toISOString(),
    }, null, 2));
  } catch {
    // Non-fatal — don't block upgrade
  }
}

function normalizeRequestedVersion(version) {
  if (!version) return null;
  const trimmed = String(version).trim();
  if (!trimmed) return null;
  return trimmed.replace(/^v/i, '');
}

function isPrereleaseVersion(version) {
  return Boolean(normalizeRequestedVersion(version)?.includes('-'));
}

function parseVersion(version) {
  const [core, prerelease = ''] = normalizeRequestedVersion(version)?.split('-', 2) || ['0.0.0', ''];
  const [major = 0, minor = 0, patch = 0] = core.split('.').map((part) => Number.parseInt(part, 10) || 0);
  return { major, minor, patch, prerelease: prerelease ? prerelease.split('.') : [] };
}

function comparePrerelease(aParts, bParts) {
  if (!aParts.length && !bParts.length) return 0;
  if (!aParts.length) return 1;
  if (!bParts.length) return -1;
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const a = aParts[i];
    const b = bParts[i];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNum = /^\d+$/.test(a) ? Number.parseInt(a, 10) : null;
    const bNum = /^\d+$/.test(b) ? Number.parseInt(b, 10) : null;
    if (aNum !== null && bNum !== null && aNum !== bNum) return aNum - bNum;
    if (aNum !== null && bNum === null) return -1;
    if (aNum === null && bNum !== null) return 1;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

function compareVersions(a, b) {
  const aVersion = parseVersion(a);
  const bVersion = parseVersion(b);
  if (aVersion.major !== bVersion.major) return aVersion.major - bVersion.major;
  if (aVersion.minor !== bVersion.minor) return aVersion.minor - bVersion.minor;
  if (aVersion.patch !== bVersion.patch) return aVersion.patch - bVersion.patch;
  return comparePrerelease(aVersion.prerelease, bVersion.prerelease);
}

function releaseVersion(release) {
  return normalizeRequestedVersion(release?.tag_name || release?.name);
}

function selectUpdateRelease(current, releases) {
  const currentIsPrerelease = isPrereleaseVersion(current);
  return releases
    .filter((release) => !release?.draft)
    .filter((release) => {
      const version = releaseVersion(release);
      if (!version) return false;
      if (!currentIsPrerelease && release.prerelease) return false;
      return compareVersions(current, version) < 0;
    })
    .sort((a, b) => compareVersions(releaseVersion(b), releaseVersion(a)))[0] || null;
}

async function fetchLatestReleaseForChannel(current) {
  const currentIsPrerelease = isPrereleaseVersion(current);
  const url = currentIsPrerelease
    ? `https://api.github.com/repos/${REPO}/releases?per_page=30`
    : `https://api.github.com/repos/${REPO}/releases/latest`;
  const resp = await fetch(url, {
    headers: { 'Accept': 'application/vnd.github.v3+json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) {
    throw new Error(`GitHub API returned ${resp.status}`);
  }
  const data = await resp.json();
  if (!currentIsPrerelease) return data;
  return selectUpdateRelease(current, data) || { tag_name: `v${current}`, name: `v${current}` };
}

function toReleaseTag(version) {
  const normalized = normalizeRequestedVersion(version);
  if (!normalized) {
    throw new Error('Release version is required');
  }
  return `v${normalized}`;
}

function getReleaseDownloadUrl(version) {
  const tag = toReleaseTag(version);
  if (RELEASE_BASE_URL) {
    return `${RELEASE_BASE_URL.replace(/\/$/, '')}/${tag}/tlive-${tag}.tar.gz`;
  }
  return `https://github.com/${REPO}/releases/download/${tag}/tlive-${tag}.tar.gz`;
}

function getManualInstallCommand(version = null, platform = process.platform) {
  const normalizedVersion = normalizeRequestedVersion(version);
  if (platform === 'win32') {
    const versionArg = normalizedVersion ? ` '${normalizedVersion}'` : '';
    return `powershell -NoProfile -ExecutionPolicy Bypass -Command "$tmp = Join-Path $env:TEMP 'tlive-install.ps1'; Invoke-WebRequest 'https://raw.githubusercontent.com/${REPO}/main/install.ps1' -UseBasicParsing -OutFile $tmp; & $tmp${versionArg}"`;
  }

  return normalizedVersion
    ? `curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash -s -- v${normalizedVersion}`
    : `curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash`;
}

async function downloadFile(url, dest) {
  const resp = await fetch(url, {
    headers: { 'Accept': 'application/octet-stream' },
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) {
    throw new Error(`Failed to download release package (${resp.status} ${resp.statusText})`);
  }
  writeFileSync(dest, Buffer.from(await resp.arrayBuffer()));
}

function installProductionDeps(appDir) {
  try {
    execSync('npm ci --production --ignore-scripts', { stdio: 'inherit', cwd: appDir });
  } catch {
    execSync('npm install --production --ignore-scripts', { stdio: 'inherit', cwd: appDir });
  }
}

function runPostinstall(appDir) {
  const postinstallScript = join(appDir, 'scripts', 'postinstall.js');
  if (!existsSync(postinstallScript)) return;
  execSync(`${process.execPath} scripts/postinstall.js`, { stdio: 'inherit', cwd: appDir });
}

function restoreBackup(backupDir) {
  if (!backupDir || !existsSync(backupDir)) {
    throw new Error('No backup install available for rollback');
  }

  if (existsSync(PACKAGE_ROOT)) {
    const failedDir = `${PACKAGE_ROOT}-failed-${Date.now()}`;
    renameSync(PACKAGE_ROOT, failedDir);
    console.warn(`Moved failed install to: ${failedDir}`);
  }

  renameSync(backupDir, PACKAGE_ROOT);
}

async function upgradeFromRelease(version) {
  mkdirSync(TLIVE_HOME, { recursive: true });
  const tempRoot = mkdtempSync(join(TLIVE_HOME, 'upgrade-'));
  const tag = toReleaseTag(version);
  const tarball = join(tempRoot, `tlive-${tag}.tar.gz`);
  const stagedDir = join(tempRoot, 'app');
  const backupDir = `${PACKAGE_ROOT}-backup-${Date.now()}`;
  let movedCurrentInstall = false;

  try {
    if (RELEASE_TARBALL_PATH) {
      console.log('Using local release package...');
      copyFileSync(RELEASE_TARBALL_PATH, tarball);
    } else {
      console.log('Downloading release package...');
      await downloadFile(getReleaseDownloadUrl(version), tarball);
    }

    console.log('Extracting package...');
    mkdirSync(stagedDir, { recursive: true });
    const tarResult = spawnSync('tar', ['xzf', tarball, '-C', stagedDir], { stdio: 'inherit' });
    if (tarResult.status !== 0) {
      throw new Error('Failed to extract release package. Make sure tar is available in PATH.');
    }

    console.log('Installing production dependencies...');
    installProductionDeps(stagedDir);

    console.log('Refreshing bundled docs...');
    runPostinstall(stagedDir);

    if (existsSync(PACKAGE_ROOT)) {
      renameSync(PACKAGE_ROOT, backupDir);
      movedCurrentInstall = true;
    }
    renameSync(stagedDir, PACKAGE_ROOT);
    rmSync(tempRoot, { recursive: true, force: true });

    return backupDir;
  } catch (err) {
    if (movedCurrentInstall && !existsSync(PACKAGE_ROOT) && existsSync(backupDir)) {
      try {
        renameSync(backupDir, PACKAGE_ROOT);
      } catch {}
    }
    rmSync(tempRoot, { recursive: true, force: true });
    throw err;
  }
}

async function waitForProcessExit(pid, timeoutMs = 30000) {
  if (!Number.isFinite(pid) || pid <= 0) return;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessRunning(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for process ${pid} to exit`);
}

async function terminateProcess(pid, label = 'process', timeoutMs = 30000) {
  if (!Number.isFinite(pid) || pid <= 0 || !isProcessRunning(pid)) return;

  console.log(`Stopping ${label} (PID ${pid})...`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch {}

  try {
    await waitForProcessExit(pid, timeoutMs);
    return;
  } catch {
    console.warn(`${label} did not exit after SIGTERM; forcing shutdown...`);
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
  await waitForProcessExit(pid, 10000);
}

function readStatusFile() {
  try {
    return JSON.parse(readFileSync(STATUS_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

async function waitForBridgeHealthy(expectedVersion, startedAfterMs, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const pid = getBridgePid();
    if (!pid) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }

    const status = readStatusFile();
    const statusReadyAt = status?.readyAt ? Date.parse(status.readyAt) : 0;
    const statusIsFresh = Number.isFinite(statusReadyAt) && statusReadyAt >= startedAfterMs - 1000;
    const pidMatches = Number(status?.pid) === pid;
    const versionMatches = !expectedVersion || status?.version === expectedVersion;
    const hasFeishu = Array.isArray(status?.channels) && status.channels.includes('feishu');
    if (statusIsFresh && pidMatches && versionMatches && hasFeishu) {
      return { pid, status };
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Bridge did not become healthy within ${timeoutMs / 1000}s`);
}

async function stopBridgeIfRunning(timeoutMs = 30000) {
  const pid = getBridgePid();
  if (!pid) {
    try { unlinkSync(BRIDGE_PID); } catch {}
    return false;
  }

  await terminateProcess(pid, 'Bridge', timeoutMs);
  try { unlinkSync(BRIDGE_PID); } catch {}
  return true;
}

async function stopLocalClientIfRunning(timeoutMs = 30000) {
  const pid = getLocalClientPid();
  if (!pid) {
    try { unlinkSync(CLIENT_PID); } catch {}
    return false;
  }

  await terminateProcess(pid, 'Local client', timeoutMs);
  try { unlinkSync(CLIENT_PID); } catch {}
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse env files (KEY=VALUE lines, supports quotes). */
function readEnvFile(file) {
  const env = {};
  if (!existsSync(file)) return env;
  const content = readFileSync(file, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const raw = trimmed.startsWith('export ') ? trimmed.slice(7) : trimmed;
    const eq = raw.indexOf('=');
    if (eq === -1) continue;
    const key = raw.slice(0, eq).trim();
    let val = raw.slice(eq + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

function isServerConfigKey(key) {
  return key === 'TL_TOKEN' ||
    key === 'TL_LOCALE' ||
    key === 'TL_ENABLED_CHANNELS' ||
    key === 'TL_PORT' ||
    key === 'TL_DONE_BUTTONS' ||
    key === 'TL_LOCAL_CLIENT_DISABLED' ||
    key === 'TL_SERVER_STANDALONE' ||
    key === 'TL_REMOTE_TOKEN' ||
    key === 'TL_REMOTE_HEARTBEAT_MS' ||
    key === 'TL_REMOTE_CLIENT_TIMEOUT_MS' ||
    key === 'TL_DEBUG_EVENTS' ||
    key.startsWith('TL_FS_') ||
    key.startsWith('TL_MCP_') ||
    key.startsWith('TL_REMOTE_SERVER_') ||
    key.startsWith('TL_WEBHOOK_') ||
    key.startsWith('TL_COST_');
}

function isClientConfigKey(key) {
  return key === 'TL_PROVIDER' ||
    key === 'TL_AGENT_SETTINGS' ||
    key === 'TL_DEFAULT_WORKDIR' ||
    key === 'TL_DEFAULT_MODEL' ||
    key === 'TL_REMOTE_TOKEN' ||
    key === 'TL_REMOTE_SERVER_URL' ||
    key === 'TL_REMOTE_RECONNECT_MS' ||
    key === 'TL_REMOTE_WORKSPACES' ||
    key === 'TL_CLAUDE_TMPDIR' ||
    key === 'TL_MCP_URL' ||
    key === 'TL_DEBUG_EVENTS' ||
    key.startsWith('TL_REMOTE_CLIENT_') ||
    key.startsWith('TL_CODEX_') ||
    key.startsWith('CTI_') ||
    key === 'HTTP_PROXY' ||
    key === 'HTTPS_PROXY' ||
    key === 'ALL_PROXY' ||
    key === 'NO_PROXY' ||
    !key.startsWith('TL_');
}

function migratedEnvForProfile(profile, legacyEnv) {
  const isKeyForProfile = profile === 'server' ? isServerConfigKey : isClientConfigKey;
  return Object.fromEntries(Object.entries(legacyEnv).filter(([key]) => isKeyForProfile(key)));
}

function serializeEnvFile(env, source) {
  const lines = [
    `# Migrated from ${source}.`,
    '# Edit this role-specific file; runtime no longer reads config.env.',
  ];
  for (const [key, value] of Object.entries(env)) {
    lines.push(`${key}=${value}`);
  }
  return `${lines.join('\n')}\n`;
}

function migrateLegacyConfigEnv() {
  if (!existsSync(CONFIG_FILE)) return;
  const legacyEnv = readEnvFile(CONFIG_FILE);
  for (const [profile, target] of [
    ['server', SERVER_CONFIG_FILE],
    ['client', CLIENT_CONFIG_FILE],
  ]) {
    if (existsSync(target)) continue;
    try {
      writeFileSync(target, serializeEnvFile(migratedEnvForProfile(profile, legacyEnv), CONFIG_FILE), {
        flag: 'wx',
        mode: 0o600,
      });
    } catch {
      // Another process may have created the file.
    }
  }
}

function loadConfigEnv(profile = 'server') {
  migrateLegacyConfigEnv();
  if (profile === 'client') return readEnvFile(CLIENT_CONFIG_FILE);
  return readEnvFile(SERVER_CONFIG_FILE);
}

function applyDefaultWorkdir(env) {
  if (env.TL_DEFAULT_WORKDIR) return env;
  return { ...env, TL_DEFAULT_WORKDIR: process.cwd() };
}

/** Check whether a PID is alive */
function isProcessRunning(pid) {
  try { process.kill(pid, 0); return true; } catch (e) {
    // EPERM = process exists but no permission (treat as running)
    if (e.code === 'EPERM') return true;
    return false;
  }
}

function findBridgePidFromProcessList() {
  if (isWindows) {
    try {
      const escapedEntry = BRIDGE_ENTRY.replace(/'/g, "''");
      const script = [
        `$target = '${escapedEntry}'`,
        'Get-CimInstance Win32_Process',
        `| Where-Object { $_.ProcessId -ne ${process.pid} -and $_.CommandLine -and $_.CommandLine.Contains($target) }`,
        '| Select-Object -First 1 -ExpandProperty ProcessId',
      ].join(' ');
      const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
        encoding: 'utf-8',
        timeout: 5000,
      });
      if (result.status !== 0) return null;
      const pid = Number.parseInt(result.stdout.trim().split(/\s+/)[0] || '', 10);
      return Number.isFinite(pid) && pid > 0 && isProcessRunning(pid) ? pid : null;
    } catch {
      return null;
    }
  }

  try {
    const result = spawnSync('ps', ['-eo', 'pid=,args='], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    if (result.status !== 0) return null;
    for (const line of result.stdout.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) continue;
      const pid = Number.parseInt(match[1], 10);
      const commandLine = match[2];
      if (pid === process.pid) continue;
      if (!commandLine.includes(BRIDGE_ENTRY)) continue;
      if (isProcessRunning(pid)) return pid;
    }
  } catch {}

  return null;
}

/** Read bridge.pid and return PID if alive, else null */
function getBridgePid() {
  try {
    if (existsSync(BRIDGE_PID)) {
      const pid = parseInt(readFileSync(BRIDGE_PID, 'utf-8').trim(), 10);
      if (!Number.isNaN(pid) && isProcessRunning(pid)) return pid;
    }
  } catch {}

  const status = readStatusFile();
  const statusPid = Number(status?.pid);
  if (!status?.exitedAt && Number.isFinite(statusPid) && statusPid > 0 && isProcessRunning(statusPid)) {
    ensureDirs();
    writeFileSync(BRIDGE_PID, String(statusPid));
    return statusPid;
  }

  const discoveredPid = findBridgePidFromProcessList();
  if (discoveredPid) {
    ensureDirs();
    writeFileSync(BRIDGE_PID, String(discoveredPid));
    return discoveredPid;
  }

  try { unlinkSync(BRIDGE_PID); } catch {}
  return null;
}

function getLocalClientPid() {
  try {
    if (existsSync(CLIENT_PID)) {
      const pid = parseInt(readFileSync(CLIENT_PID, 'utf-8').trim(), 10);
      if (!Number.isNaN(pid) && isProcessRunning(pid)) return pid;
    }
  } catch {}

  try { unlinkSync(CLIENT_PID); } catch {}
  return null;
}

/** Ensure runtime and log directories exist */
function ensureDirs() {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Daemon functions
// ---------------------------------------------------------------------------

function normalizeHttpPath(path, fallback = '/tlive') {
  const trimmed = String(path || '').trim();
  if (!trimmed) return fallback;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function localRemoteServerUrl(config) {
  const port = config.TL_REMOTE_SERVER_PORT || '8787';
  const path = normalizeHttpPath(config.TL_REMOTE_SERVER_PATH, '/tlive');
  return `ws://127.0.0.1:${port}${path}`;
}

function spawnClientDaemon(args = [], envOverrides = {}, label = 'Client', clientConfig = loadConfigEnv('client')) {
  ensureDirs();

  const existing = getLocalClientPid();
  if (existing) {
    console.log(`${label} is already running (PID ${existing})`);
    return existing;
  }

  if (!existsSync(CLIENT_ENTRY)) {
    throw new Error(`Client worker not built: ${CLIENT_ENTRY}`);
  }

  const env = applyDefaultWorkdir({
    ...clientConfig,
    ...process.env,
    ...envOverrides,
  });

  const child = spawn(process.execPath, [CLIENT_ENTRY, ...args], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env,
  });

  writeFileSync(CLIENT_PID, String(child.pid));
  child.unref();

  console.log(`${label} started (PID ${child.pid})`);
  return child.pid;
}

function startConfiguredClient(clientConfig = loadConfigEnv('client')) {
  return spawnClientDaemon([], {}, 'Client', clientConfig);
}

function startLocalClient(clientConfig = loadConfigEnv('client'), serverConfig = loadConfigEnv('server')) {
  return spawnClientDaemon(
    ['--name', 'local'],
    {
      TL_REMOTE_TOKEN:
        process.env.TL_REMOTE_TOKEN ||
        clientConfig.TL_REMOTE_TOKEN ||
        serverConfig.TL_REMOTE_TOKEN ||
        serverConfig.TL_TOKEN,
      TL_REMOTE_SERVER_URL: localRemoteServerUrl(serverConfig),
    },
    'Local client',
    clientConfig,
  );
}

function daemonStart(options = {}) {
  ensureDirs();
  const serverConfig = loadConfigEnv('server');
  const clientConfig = loadConfigEnv('client');

  const existing = getBridgePid();
  if (existing) {
    console.log(`Bridge is already running (PID ${existing})`);
    if (!options.standalone) {
      startLocalClient(clientConfig, serverConfig);
    }
    return existing;
  }

  if (!existsSync(BRIDGE_ENTRY)) {
    throw new Error(`Bridge not built: ${BRIDGE_ENTRY}`);
  }

  console.log('Starting Bridge...');

  const env = {
    ...serverConfig,
    ...process.env,
    ...(options.standalone ? { TL_SERVER_STANDALONE: 'true' } : {}),
  };

  const child = spawn(process.execPath, [BRIDGE_ENTRY], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env,
  });

  writeFileSync(BRIDGE_PID, String(child.pid));
  child.unref();

  console.log(`Bridge started (PID ${child.pid})`);

  if (!options.standalone) {
    startLocalClient(clientConfig, serverConfig);
  } else {
    console.log('Standalone mode: local client not started.');
  }

  return child.pid;
}

async function daemonStop() {
  const stoppedClient = await stopLocalClientIfRunning();
  const stoppedBridge = await stopBridgeIfRunning();
  if (stoppedBridge) {
    console.log('Bridge stopped.');
  } else {
    console.log('Bridge is not running.');
  }
  if (stoppedClient) {
    console.log('Local client stopped.');
  }
}

async function daemonRestart(options = {}) {
  const wasClientRunning = await stopLocalClientIfRunning();
  const wasBridgeRunning = await stopBridgeIfRunning();
  if (wasBridgeRunning) {
    console.log('Bridge stopped.');
  } else {
    console.log('Bridge is not running; starting it now.');
  }
  if (wasClientRunning) {
    console.log('Local client stopped.');
  }

  const startedAfterMs = Date.now();
  daemonStart(options);
  const health = await waitForBridgeHealthy(getVersion(), startedAfterMs, 30000);
  console.log(`Bridge healthy (PID ${health.pid}, version ${health.status.version})`);
}

async function daemonStatus() {
  console.log('=== TLive Status ===');

  const pid = getBridgePid();

  // Read status.json for bridge details
  const statusFile = join(RUNTIME_DIR, 'status.json');
  let statusData = null;
  try {
    statusData = JSON.parse(readFileSync(statusFile, 'utf-8'));
  } catch { /* ignore */ }

  // Read bindings.json for active sessions
  const bindingsFile = join(TLIVE_HOME, 'data', 'bindings.json');
  let bindings = null;
  try {
    bindings = JSON.parse(readFileSync(bindingsFile, 'utf-8'));
  } catch { /* ignore */ }

  if (pid) {
    const version = statusData?.version || 'unknown';
    const startedAt = statusData?.startedAt;
    const uptime = startedAt ? formatUptime(new Date(startedAt)) : 'unknown';
    const channels = statusData?.channels || [];
    console.log(`Bridge:       running (PID ${pid})`);
    console.log(`Version:      ${version}`);
    console.log(`Uptime:       ${uptime}`);
    console.log(`Channels:     ${channels.join(', ') || 'none'}`);
    const clientPid = getLocalClientPid();
    console.log(`Local client: ${clientPid ? `running (PID ${clientPid})` : 'not running'}`);
  } else {
    console.log('Bridge:       not running');
    if (statusData?.exitedAt) {
      console.log(`Last exit:    ${statusData.exitedAt} (${statusData.exitReason || 'unknown'})`);
    }
    return; // No need to show sessions if not running
  }

  // Show active sessions from bindings
  const supportedChannels = new Set(statusData?.channels?.length ? statusData.channels : ['feishu']);
  const activeBindings = bindings
    ? Object.entries(bindings).filter(([, binding]) => supportedChannels.has(binding.channelType))
    : [];

  if (activeBindings.length > 0) {
    console.log('');
    console.log('=== Active Sessions ===');
    for (const [key, binding] of activeBindings) {
      const { channelType, chatId, cwd, createdAt } = binding;
      const channelIcon = channelType === 'feishu' ? '🚀' : '•';
      const workdir = cwd ? ` (${cwd})` : '';
      const age = createdAt ? formatAge(new Date(createdAt)) : 'unknown';
      console.log(`${channelIcon} ${channelType}:${chatId.slice(-8)}${workdir} — ${age}`);
    }
  } else {
    console.log('');
    console.log('Sessions:     none');
  }
}

function formatUptime(startDate) {
  const now = new Date();
  const diffMs = now - startDate;
  const hours = Math.floor(diffMs / 3600000);
  const minutes = Math.floor((diffMs % 3600000) / 60000);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

function formatAge(date) {
  const now = new Date();
  const diffMs = now - date;
  const days = Math.floor(diffMs / 86400000);
  const hours = Math.floor((diffMs % 86400000) / 3600000);
  if (days > 0) {
    return `${days}d ${hours}h ago`;
  }
  if (hours > 0) {
    return `${hours}h ago`;
  }
  const minutes = Math.floor(diffMs / 60000);
  return `${minutes}m ago`;
}

function daemonLogs(n = 50) {
  const logFile = getDailyLogPath('bridge');
  console.log(`=== Bridge (last ${n} lines) ===`);
  if (!existsSync(logFile)) {
    console.log('(no log file)');
    return;
  }
  try {
    const size = statSync(logFile).size;
    // Read at most last 128KB to avoid OOM on huge logs
    const MAX_READ = 128 * 1024;
    let content;
    if (size > MAX_READ) {
      const fd = openSync(logFile, 'r');
      const buf = Buffer.alloc(MAX_READ);
      readSync(fd, buf, 0, MAX_READ, size - MAX_READ);
      closeSync(fd);
      content = buf.toString('utf-8');
      // Drop first partial line
      const firstNewline = content.indexOf('\n');
      if (firstNewline !== -1) content = content.slice(firstNewline + 1);
    } else {
      content = readFileSync(logFile, 'utf-8');
    }
    const lines = content.trimEnd().split('\n').slice(-n);
    console.log(lines.join('\n'));
  } catch {
    console.log('(no log file)');
  }
}

function getDailyLogPath(baseName, date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return join(LOG_DIR, `${baseName}-${year}-${month}-${day}.log`);
}

const HELP_TEXT = `TLive — Terminal live monitoring + IM bridge for AI coding tools

Usage:
  tlive <subcommand>         Manage TLive services

Setup (one-time):
  tlive setup                Configure Feishu/Lark

Service Management:
  tlive start                Start server and local worker client
  tlive server               Start server and local worker client
  tlive server --standalone  Start only the server control plane
  tlive client [options]     Run a remote worker client in the foreground
  tlive client --daemon      Run a remote worker client in the background
  tlive client restart       Restart the background remote worker client
  tlive upgrade --client     Upgrade only the remote worker client install
  tlive stop                 Stop IM Bridge daemon
  tlive restart              Restart IM Bridge daemon
  tlive status               Show Bridge status
  tlive logs [N]             Show last N log lines (default: 50)
  tlive upgrade [version]    Upgrade to latest or specified version
  tlive upgrade --standalone Upgrade and restart only the server control plane
  tlive version              Show version info

IM Commands (in Feishu/Lark):
  /tlive                     Open TLive workbench
  /home                      Open TLive workbench
  /stop                      Interrupt execution
  Other / commands           Passed through to the active agent

MCP:
  Endpoint: /mcp on the TLive server
  Tools:    tlive_send_file, tlive_send_image, tlive_status
`;

const NODE_COMMANDS = new Set(['setup', 'start', 'server', 'client', 'stop', 'restart', 'status', 'logs', 'version', 'update', 'upgrade']);
const CORE_COMMANDS = new Set(['install']);

function run(cmd, opts = {}) {
  try {
    execSync(cmd, { stdio: 'inherit', ...opts });
  } catch (err) {
    process.exit(err.status || 1);
  }
}

function showHelp() {
  console.log(HELP_TEXT);
}

// No command or help flags
if (!command || command === '--help' || command === '-h' || command === 'help') {
  showHelp();
  process.exit(0);
}

// Version flags
if (command === '--version' || command === '-v' || command === '-V') {
  console.log(getVersion());
  process.exit(0);
}

switch (command) {
  case 'setup': {
    const setupEntry = join(PACKAGE_ROOT, 'dist', 'setup.mjs');
    if (existsSync(setupEntry)) {
      const r = spawnSync(process.execPath, [setupEntry], { stdio: 'inherit' });
      if (r.status) process.exit(r.status);
    } else {
      console.error('Setup wizard not found. Reinstall from GitHub Release or rebuild this fork from source.');
    }
    break;
  }

  case 'start':
  case 'server': {
    if (args.includes('--runtime')) {
      console.error('Runtime selection has been removed. Configure TL_PROVIDER=claude or codex.');
      process.exit(1);
    }
    const standalone = args.includes('--standalone');
    try {
      daemonStart({ standalone });
    } catch (err) {
      console.error(`Failed to start bridge: ${err.message || err}`);
      process.exit(1);
    }
    break;
  }

  case 'client': {
    const subcommand = args[0];
    if (subcommand === '--daemon' || subcommand === 'start') {
      try {
        startConfiguredClient();
      } catch (err) {
        console.error(`Failed to start client: ${err.message || err}`);
        process.exit(1);
      }
      break;
    }
    if (subcommand === 'restart') {
      try {
        const stopped = await stopLocalClientIfRunning();
        if (stopped) console.log('Client stopped.');
        startConfiguredClient();
      } catch (err) {
        console.error(`Failed to restart client: ${err.message || err}`);
        process.exit(1);
      }
      break;
    }
    if (subcommand === 'stop') {
      const stopped = await stopLocalClientIfRunning();
      console.log(stopped ? 'Client stopped.' : 'Client is not running.');
      break;
    }
    if (subcommand === 'status') {
      const pid = getLocalClientPid();
      console.log(pid ? `Client: running (PID ${pid})` : 'Client: not running');
      break;
    }
    if (subcommand === 'upgrade') {
      const r = spawnSync(process.execPath, [join(PACKAGE_ROOT, 'scripts', 'cli.js'), 'upgrade', '--client', ...args.slice(1)], {
        stdio: 'inherit',
        env: process.env,
      });
      if (r.status) process.exit(r.status);
      break;
    }
    if (!existsSync(CLIENT_ENTRY)) {
      console.error(`Client worker not built: ${CLIENT_ENTRY}`);
      process.exit(1);
    }
    const env = {
      ...loadConfigEnv('client'),
      ...process.env,
    };
    const r = spawnSync(process.execPath, [CLIENT_ENTRY, ...args], {
      stdio: 'inherit',
      env: applyDefaultWorkdir(env),
    });
    if (r.status) process.exit(r.status);
    break;
  }

  case 'stop':
    await daemonStop();
    break;

  case 'restart':
    try {
      await daemonRestart({ standalone: args.includes('--standalone') });
    } catch (err) {
      console.error(`Failed to restart bridge: ${err.message || err}`);
      process.exit(1);
    }
    break;

  case 'status':
    await daemonStatus();
    break;

  case 'logs':
    daemonLogs(parseInt(args[0], 10) || 50);
    break;

  case 'version': {
    const ver = getVersion();
    console.log(`tlive          ${ver}`);
    console.log(`node           ${process.version}`);
    // Check for updates
    try {
      const data = await fetchLatestReleaseForChannel(ver);
      const latest = releaseVersion(data);
      if (latest && compareVersions(ver, latest) < 0) {
        console.log(`\nUpdate available: ${ver} → ${latest}`);
        console.log('Run: tlive update');
      } else {
        console.log('\nUp to date.');
      }
    } catch {}
    break;
  }

  case 'update':
  case 'upgrade': {
    const current = getVersion();
    const fromVersion = process.env.TLIVE_UPGRADE_FROM_VERSION || current;
    const upgradeStandalone = args.includes('--standalone');
    const upgradeClientOnly = args.includes('--client');
    const requestedVersion = normalizeRequestedVersion(args.find((arg) => !arg.startsWith('--')));
    const parentPid = Number.parseInt(process.env.TLIVE_UPGRADE_PARENT_PID || '', 10);
    const bridgeWasRunning = !upgradeClientOnly && (Boolean(getBridgePid()) || Boolean(parentPid));
    const clientWasRunning =
      upgradeClientOnly && (Boolean(getLocalClientPid()) || Boolean(parentPid));
    const shouldNotifyUpgrade = bridgeWasRunning || Boolean(process.env.TLIVE_UPGRADE_CHAT_ID);
    console.log(`Current version: ${current}`);

    // Check latest version from GitHub
    let latest = requestedVersion;
    if (!latest) {
      try {
        const data = await fetchLatestReleaseForChannel(current);
        latest = releaseVersion(data);
        if (!latest) {
          throw new Error('Latest version not found in release metadata');
        }
      } catch (e) {
        const errorMsg = 'Failed to check latest version. Are you online?';
        console.error(errorMsg);
        if (shouldNotifyUpgrade) {
          writeUpgradeResult({ success: false, version: current, previousVersion: fromVersion, error: errorMsg });
        }
        process.exit(1);
      }
    }

    if (latest === current) {
      console.log('\n✅ Already up to date.');
      break;
    }

    console.log(`${requestedVersion ? 'Target' : 'Latest'} version: ${latest}`);
    console.log('\nUpgrading from GitHub...');

    // Check if installed via git clone
    const gitDir = join(PACKAGE_ROOT, '.git');
    const isGitInstall = existsSync(gitDir);

    try {
      if (isGitInstall) {
        const errorMsg = 'This tlive command is running from a git checkout. Auto-upgrade uses GitHub Release packages and will not overwrite a working tree.';
        console.error('\n' + errorMsg);
        console.error(`Update this checkout manually with git, or install the packaged build with:`);
        console.error(`  ${getManualInstallCommand()}`);
        if (shouldNotifyUpgrade) {
          writeUpgradeResult({ success: false, version: current, previousVersion: fromVersion, error: errorMsg });
        }
        process.exit(1);
      } else if (upgradeClientOnly) {
        if (Number.isFinite(parentPid) && parentPid > 0) {
          console.log(`Waiting for running client (PID ${parentPid}) to exit...`);
          try {
            await waitForProcessExit(parentPid, 60000);
          } catch {
            await terminateProcess(parentPid, 'parent client', 10000);
          }
        } else if (getLocalClientPid()) {
          await stopLocalClientIfRunning(30000);
        }

        console.log('Upgrading client from GitHub Release package...');
        const backupDir = await upgradeFromRelease(latest);
        console.log(`\nNew version installed at: ${PACKAGE_ROOT}`);
        console.log(`Previous version backed up at: ${backupDir}`);

        if (clientWasRunning) {
          try {
            startConfiguredClient();
          } catch (startErr) {
            restoreBackup(backupDir);
            throw new Error(`Client upgrade rolled back because the new client failed to start: ${startErr.message || startErr}`);
          }
        }
      } else {
        if (Number.isFinite(parentPid) && parentPid > 0) {
          console.log(`Waiting for running bridge (PID ${parentPid}) to exit...`);
          try {
            await waitForProcessExit(parentPid, 60000);
          } catch {
            await terminateProcess(parentPid, 'parent bridge', 10000);
          }
        }

        if (bridgeWasRunning) {
          await stopLocalClientIfRunning(30000);
        }

        if (getBridgePid()) {
          await stopBridgeIfRunning(30000);
        }

        console.log('Upgrading from GitHub Release package...');
        const backupDir = await upgradeFromRelease(latest);
        console.log(`\nNew version installed at: ${PACKAGE_ROOT}`);
        console.log(`Previous version backed up at: ${backupDir}`);

        if (bridgeWasRunning) {
          console.log('\nRestarting bridge...');
          if (shouldNotifyUpgrade) {
            writeUpgradeResult({ success: true, version: latest, previousVersion: fromVersion });
          }
          const startedAfterMs = Date.now();
          try {
            daemonStart({ standalone: upgradeStandalone });
            const health = await waitForBridgeHealthy(latest, startedAfterMs, 30000);
            console.log(`Bridge healthy (PID ${health.pid}, version ${health.status.version})`);
          } catch (startErr) {
            const startErrorMsg = startErr.message || String(startErr);
            console.error(`New bridge failed to start: ${startErrorMsg}`);
            if (shouldNotifyUpgrade) {
              writeUpgradeResult({
                success: false,
                version: latest,
                previousVersion: fromVersion,
                error: `New bridge failed to start after upgrade: ${startErrorMsg}. Rolled back to v${fromVersion}.`,
              });
            }

            await stopBridgeIfRunning(10000);
            await stopLocalClientIfRunning(10000);
            restoreBackup(backupDir);
            throw new Error(`Upgrade rolled back because the new bridge failed to start: ${startErrorMsg}`);
          }
        } else if (shouldNotifyUpgrade) {
          writeUpgradeResult({ success: true, version: latest, previousVersion: fromVersion });
        }
      }

      console.log(`\n✅ Upgraded to ${latest}.`);
      console.log('\nChangelog: https://github.com/huanghuoguoguo/tlive/releases');
    } catch (err) {
      const errorMsg = err.message || err;
      console.error(`Upgrade failed: ${errorMsg}`);
      if (shouldNotifyUpgrade) {
        writeUpgradeResult({ success: false, version: current, previousVersion: fromVersion, error: errorMsg });
      }
      if (bridgeWasRunning && !getBridgePid() && existsSync(BRIDGE_ENTRY)) {
        try {
          const restartStartedAt = Date.now();
          daemonStart({ standalone: upgradeStandalone });
          await waitForBridgeHealthy(getVersion(), restartStartedAt, 30000);
          console.error('Previous bridge restarted after failed upgrade.');
        } catch (restartErr) {
          console.error(`Failed to restart bridge after failed upgrade: ${restartErr.message || restartErr}`);
        }
      }
      process.exit(1);
    }
    break;
  }

  case 'install': {
    const sub = args[0];
    if (sub === 'skills') {
      console.error('`tlive install skills` has been removed. Use the TLive MCP server instead:');
      console.error('TLive SDK sessions load TLive MCP tools automatically.');
      process.exit(1);
    } else {
      console.log('Usage:');
      console.log('  tlive start           Start the TLive server with HTTP MCP enabled');
      console.log('TLive SDK sessions load TLive MCP tools automatically.');
    }
    break;
  }

  default: {
    // Check for typos of known commands before failing
    const known = ['setup', 'start', 'server', 'client', 'stop', 'restart', 'status', 'logs', 'install', 'help', 'version', 'update', 'upgrade'];
    const similar = known.find(k => {
      if (Math.abs(k.length - command.length) > 2) return false;
      let diff = 0;
      for (let i = 0; i < Math.max(k.length, command.length); i++) {
        if (k[i] !== command[i]) diff++;
      }
      return diff <= 2 && diff > 0;
    });
    if (similar) {
      console.error(`Unknown command: ${command}`);
      console.error(`Did you mean: tlive ${similar}?`);
      process.exit(1);
    }
    console.error(`Unknown command: ${command}`);
    console.error('Run `tlive --help` to see available subcommands.');
    process.exit(1);
  }
}
