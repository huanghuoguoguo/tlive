#!/usr/bin/env node
// TLive CLI entry point
import { execSync, spawn, spawnSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, chmodSync, openSync, closeSync, copyFileSync, statSync, readSync, mkdtempSync, renameSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
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
const BRIDGE_ENTRY = join(PACKAGE_ROOT, 'dist', 'main.mjs');
const CONFIG_FILE = join(TLIVE_HOME, 'config.env');
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse ~/.tlive/config.env (KEY=VALUE lines, supports quotes) */
function loadConfigEnv() {
  const env = {};
  if (!existsSync(CONFIG_FILE)) return env;
  const content = readFileSync(CONFIG_FILE, 'utf-8');
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

/** Ensure runtime and log directories exist */
function ensureDirs() {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Daemon functions
// ---------------------------------------------------------------------------

function daemonStart() {
  ensureDirs();

  const existing = getBridgePid();
  if (existing) {
    console.log(`Bridge is already running (PID ${existing})`);
    return existing;
  }

  if (!existsSync(BRIDGE_ENTRY)) {
    throw new Error(`Bridge not built: ${BRIDGE_ENTRY}`);
  }

  const config = loadConfigEnv();

  console.log('Starting Bridge...');

  const env = {
    ...process.env,
    ...config,
    TL_DEFAULT_WORKDIR: process.env.TL_DEFAULT_WORKDIR || process.cwd(),
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

  return child.pid;
}

async function daemonStop() {
  if (await stopBridgeIfRunning()) {
    console.log('Bridge stopped.');
  } else {
    console.log('Bridge is not running.');
  }
}

async function daemonRestart() {
  const wasRunning = await stopBridgeIfRunning();
  if (wasRunning) {
    console.log('Bridge stopped.');
  } else {
    console.log('Bridge is not running; starting it now.');
  }

  const startedAfterMs = Date.now();
  daemonStart();
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
  tlive install skills       Install /tlive skill to Claude Code

Service Management:
  tlive start                Start Feishu/Lark bridge
  tlive stop                 Stop IM Bridge daemon
  tlive restart              Restart IM Bridge daemon
  tlive status               Show Bridge status
  tlive logs [N]             Show last N log lines (default: 50)
  tlive upgrade [version]    Upgrade to latest or specified version
  tlive version              Show version info

IM Commands (in Feishu/Lark):
  /tlive                     Open TLive workbench
  /home                      Open TLive workbench
  /stop                      Interrupt execution
  Other / commands           Passed through to the active agent

In Claude Code (AI-guided):
  /tlive                     Start Bridge (with pre-checks)
  /tlive setup               Interactive setup wizard
  /tlive reconfigure         Modify specific config fields
`;

const NODE_COMMANDS = new Set(['setup', 'start', 'stop', 'restart', 'status', 'logs', 'version', 'update', 'upgrade']);
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

  case 'start': {
    if (args.includes('--runtime')) {
      console.error('Runtime selection has been removed. Configure TL_PROVIDER=claude or codex.');
      process.exit(1);
    }
    try {
      daemonStart();
    } catch (err) {
      console.error(`Failed to start bridge: ${err.message || err}`);
      process.exit(1);
    }
    break;
  }

  case 'stop':
    await daemonStop();
    break;

  case 'restart':
    try {
      await daemonRestart();
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
    const requestedVersion = normalizeRequestedVersion(args[0]);
    const bridgeWasRunning = Boolean(getBridgePid()) || Boolean(process.env.TLIVE_UPGRADE_PARENT_PID);
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
      } else {
        const parentPid = Number.parseInt(process.env.TLIVE_UPGRADE_PARENT_PID || '', 10);
        if (Number.isFinite(parentPid) && parentPid > 0) {
          console.log(`Waiting for running bridge (PID ${parentPid}) to exit...`);
          try {
            await waitForProcessExit(parentPid, 60000);
          } catch {
            await terminateProcess(parentPid, 'parent bridge', 10000);
          }
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
            daemonStart();
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
          daemonStart();
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
      const skillSrc = join(PACKAGE_ROOT, '.claude', 'skills', 'tlive', 'SKILL.md');

      if (!existsSync(skillSrc)) {
        console.error('tlive SKILL.md not found. Reinstall from GitHub Release or rebuild this fork from source.');
        process.exit(1);
      }

      // Install tlive skill (copy SKILL.md to commands/tlive.md for Claude Code)
      const commandsDir = join(homedir(), '.claude', 'commands');
      mkdirSync(commandsDir, { recursive: true });
      const skillDest = join(commandsDir, 'tlive.md');
      copyFileSync(skillSrc, skillDest);
      console.log(`Skill installed: ${skillDest}`);

      // Install all tlive-* skills via symlink
      const bundledSkillsDir = join(PACKAGE_ROOT, '.claude', 'skills');
      const globalSkillsDir = join(homedir(), '.claude', 'skills');
      mkdirSync(globalSkillsDir, { recursive: true });

      for (const retiredSkill of ['tlive-cron']) {
        const retiredSkillDest = join(globalSkillsDir, retiredSkill);
        if (existsSync(retiredSkillDest)) {
          rmSync(retiredSkillDest, { recursive: true, force: true });
          console.log(`Removed retired skill: ${retiredSkillDest}`);
        }
      }

      try {
        const entries = readdirSync(bundledSkillsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || !entry.name.startsWith('tlive-')) continue;
          const skillFolderSrc = join(bundledSkillsDir, entry.name);
          const skillFolderDest = join(globalSkillsDir, entry.name);
          // Remove existing symlink or folder before creating new one
          try { rmSync(skillFolderDest, { recursive: true, force: true }); } catch {}
          try {
            symlinkSync(skillFolderSrc, skillFolderDest);
            console.log(`Skill installed (symlink): ${skillFolderDest}`);
          } catch {
            // Fallback: copy if symlink fails (e.g., on Windows without admin)
            const skillFile = join(skillFolderSrc, 'SKILL.md');
            if (existsSync(skillFile)) {
              mkdirSync(skillFolderDest, { recursive: true });
              copyFileSync(skillFile, join(skillFolderDest, 'SKILL.md'));
              console.log(`Skill installed (copy): ${skillFolderDest}`);
            }
          }
        }
      } catch {
        // bundledSkillsDir doesn't exist or unreadable - skip
      }

      // Sync reference docs to ~/.tlive/docs/
      const docsDir = join(TLIVE_HOME, 'docs');
      mkdirSync(docsDir, { recursive: true });
      const refsDir = join(PACKAGE_ROOT, '.claude', 'skills', 'tlive', 'references');
      for (const doc of ['setup-guides.md', 'token-validation.md', 'troubleshooting.md']) {
        const refSrc = join(refsDir, doc);
        const dest = join(docsDir, doc);
        if (existsSync(refSrc)) {
          copyFileSync(refSrc, dest);
        }
      }
      console.log(`Reference docs synced: ${docsDir}`);

      // Remove legacy TLive hook entries from ~/.claude/settings.json
        const settingsPath = join(homedir(), '.claude', 'settings.json');
        let settings = {};
        if (existsSync(settingsPath)) {
          try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')); } catch {}
        }

        if (!settings.hooks) settings.hooks = {};

        // Remove ALL existing TLive hooks (both .sh and .mjs, any path)
        const isTliveHook = (cmd) =>
          cmd?.includes('hook-handler') || cmd?.includes('notify-handler') || cmd?.includes('stop-handler');

        for (const hookType of Object.keys(settings.hooks)) {
          settings.hooks[hookType] = (settings.hooks[hookType] || []).filter(e => {
            if (isTliveHook(e.command)) return false;
            if (e.hooks) {
              e.hooks = e.hooks.filter(h => !isTliveHook(h.command));
              return e.hooks.length > 0;
            }
            return true;
          });
          if (settings.hooks[hookType].length === 0) delete settings.hooks[hookType];
        }

        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
        console.log(`Removed legacy TLive hook entries from: ${settingsPath}`);
    } else {
      console.log('Usage:');
      console.log('  tlive install skills  Install /tlive skill');
    }
    break;
  }

  default: {
    // Check for typos of known commands before failing
    const known = ['setup', 'start', 'stop', 'restart', 'status', 'logs', 'install', 'help', 'version', 'update', 'upgrade'];
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
