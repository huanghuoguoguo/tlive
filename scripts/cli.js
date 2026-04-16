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
const TLIVE_HOME = join(homedir(), '.tlive');
const RUNTIME_DIR = join(TLIVE_HOME, 'runtime');
const LOG_DIR = join(TLIVE_HOME, 'logs');
const BRIDGE_PID = join(RUNTIME_DIR, 'bridge.pid');
const BRIDGE_ENTRY = join(PACKAGE_ROOT, 'dist', 'main.mjs');
const CONFIG_FILE = join(TLIVE_HOME, 'config.env');
const UPGRADE_RESULT_FILE = join(RUNTIME_DIR, 'upgrade-result.json');

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

function toReleaseTag(version) {
  const normalized = normalizeRequestedVersion(version);
  if (!normalized) {
    throw new Error('Release version is required');
  }
  return `v${normalized}`;
}

function getReleaseDownloadUrl(version) {
  const tag = toReleaseTag(version);
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

async function upgradeFromRelease(version) {
  mkdirSync(TLIVE_HOME, { recursive: true });
  const tempRoot = mkdtempSync(join(TLIVE_HOME, 'upgrade-'));
  const tag = toReleaseTag(version);
  const tarball = join(tempRoot, `tlive-${tag}.tar.gz`);
  const stagedDir = join(tempRoot, 'app');
  const backupDir = `${PACKAGE_ROOT}-backup-${Date.now()}`;
  let movedCurrentInstall = false;

  try {
    console.log('Downloading release package...');
    await downloadFile(getReleaseDownloadUrl(version), tarball);

    console.log('Extracting package...');
    mkdirSync(stagedDir, { recursive: true });
    execSync(`tar xzf "${tarball}" -C "${stagedDir}"`, { stdio: 'inherit' });

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

async function waitForProcessExit(pid, timeoutMs = 15000) {
  if (!Number.isFinite(pid) || pid <= 0) return;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessRunning(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for process ${pid} to exit`);
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

/** Read bridge.pid and return PID if alive, else null */
function getBridgePid() {
  if (!existsSync(BRIDGE_PID)) return null;
  try {
    const pid = parseInt(readFileSync(BRIDGE_PID, 'utf-8').trim(), 10);
    if (isNaN(pid)) return null;
    return isProcessRunning(pid) ? pid : null;
  } catch { return null; }
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
    return;
  }

  if (!existsSync(BRIDGE_ENTRY)) {
    console.error('ERROR: Bridge not built.');
    console.error(`Build: cd ${join(PACKAGE_ROOT, 'bridge')} && npm install && npm run build`);
    process.exit(1);
  }

  const config = loadConfigEnv();
  const runtime = process.env.TL_RUNTIME || config.TL_RUNTIME || 'claude';

  console.log(`Starting Bridge (runtime: ${runtime})...`);

  const env = {
    ...process.env,
    ...config,
    TL_RUNTIME: runtime,
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

}

function daemonStop() {
  const pid = getBridgePid();
  if (pid) {
    console.log(`Stopping Bridge (PID ${pid})...`);
    try { process.kill(pid); } catch {}
    try { unlinkSync(BRIDGE_PID); } catch {}
    console.log('Bridge stopped.');
  } else {
    console.log('Bridge is not running.');
    // Clean up stale pid file
    try { unlinkSync(BRIDGE_PID); } catch {}
  }
}

async function daemonStatus() {
  console.log('=== TLive Status ===');

  const config = loadConfigEnv();
  const runtime = process.env.TL_RUNTIME || config.TL_RUNTIME || 'claude';
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
    console.log(`Bridge:       running (PID ${pid}, runtime: ${runtime})`);
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
  if (bindings && Object.keys(bindings).length > 0) {
    console.log('');
    console.log('=== Active Sessions ===');
    for (const [key, binding] of Object.entries(bindings)) {
      const { channelType, chatId, cwd, createdAt } = binding;
      const channelIcon = channelType === 'telegram' ? '📱' : channelType === 'feishu' ? '🚀' : channelType === 'qqbot' ? '💬' : '❓';
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

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

async function runDoctor() {
  console.log('=== TLive Doctor ===\n');

  // Dependencies
  console.log('Dependencies:');

  console.log(`  node:    ${process.version}`);

  const checkCmd = (name) => {
    try {
      const r = spawnSync(isWindows ? 'where' : 'which', [name], { encoding: 'utf-8', timeout: 5000 });
      return r.status === 0;
    } catch { return false; }
  };

  const gitVersion = (() => {
    try {
      const r = spawnSync('git', ['--version'], { encoding: 'utf-8', timeout: 5000 });
      return r.status === 0 ? r.stdout.trim().split('\n')[0] : null;
    } catch { return null; }
  })();

  console.log(checkCmd('curl') ? '  curl:    OK' : '  curl:    NOT FOUND (optional)');
  console.log(checkCmd('jq') ? '  jq:      OK' : '  jq:      NOT FOUND (optional)');
  console.log(gitVersion ? `  git:     ${gitVersion}` : '  git:     NOT FOUND');

  console.log('');

  // Config
  console.log('Config:');
  if (existsSync(CONFIG_FILE)) {
    console.log('  config.env: OK');
    const config = loadConfigEnv();
    console.log(config.TL_TOKEN ? '  TL_TOKEN: set' : '  TL_TOKEN: NOT SET');
    console.log(config.TL_TG_BOT_TOKEN ? '  Telegram: configured' : '  Telegram: not configured');
    console.log(config.TL_FS_APP_ID ? '  Feishu:   configured' : '  Feishu:   not configured');
    console.log(config.TL_QQ_APP_ID ? '  QQ Bot:   configured' : '  QQ Bot:   not configured');
  } else {
    console.log("  config.env: NOT FOUND (run 'tlive setup')");
  }

  console.log('');

  // Processes
  console.log('Processes:');
  const bridgePid = getBridgePid();
  console.log(bridgePid ? `  Bridge:   running (PID ${bridgePid})` : '  Bridge:   not running');

  // Show active sessions count
  const bindingsFile = join(TLIVE_HOME, 'data', 'bindings.json');
  try {
    const bindings = JSON.parse(readFileSync(bindingsFile, 'utf-8'));
    const count = Object.keys(bindings).length;
    console.log(count > 0 ? `  Sessions: ${count} active` : '  Sessions: none');
  } catch {
    console.log('  Sessions: (no data)');
  }

  console.log('');

  console.log('\n=== Done ===');
}

const HELP_TEXT = `TLive — Terminal live monitoring + IM bridge for AI coding tools

Usage:
  tlive <subcommand>         Manage TLive services

Setup (one-time):
  tlive setup                Configure IM platforms (Telegram/Feishu/QQ Bot)
  tlive install skills       Install /tlive skill to Claude Code

Service Management:
  tlive start [--runtime R]  Start IM Bridge (R: claude|codex, default: claude)
  tlive stop                 Stop IM Bridge daemon
  tlive status               Show Bridge status
  tlive logs [N]             Show last N log lines (default: 50)
  tlive doctor               Run diagnostic checks
  tlive upgrade [version]    Upgrade to latest or specified version
  tlive version              Show version info

IM Commands (in Telegram/Feishu/QQ Bot):
  /new                       New conversation
  /runtime claude|codex      Switch AI provider
  /perm on|off               Permission prompts
  /stop                      Interrupt execution
  /sessions                  List recent sessions
  /session <n>               Switch to session
  /help                      Show all commands

In Claude Code (AI-guided):
  /tlive                     Start Bridge (with pre-checks)
  /tlive setup               Interactive setup wizard
  /tlive reconfigure         Modify specific config fields
  /tlive doctor              Diagnose issues + suggest fixes
`;

const NODE_COMMANDS = new Set(['setup', 'start', 'stop', 'status', 'logs', 'hooks', 'doctor', 'version', 'update', 'upgrade']);
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
    const setupEntry = join(PACKAGE_ROOT, 'bridge', 'dist', 'setup.mjs');
    if (existsSync(setupEntry)) {
      const r = spawnSync(process.execPath, [setupEntry], { stdio: 'inherit' });
      if (r.status) process.exit(r.status);
    } else {
      console.error('Setup wizard not found. Reinstall from GitHub Release or rebuild this fork from source.');
    }
    break;
  }

  case 'start': {
    // Parse --runtime flag
    const rtIdx = args.indexOf('--runtime');
    if (rtIdx !== -1 && args[rtIdx + 1]) {
      const rt = args[rtIdx + 1].toLowerCase();
      if (['claude', 'codex'].includes(rt)) {
        process.env.TL_RUNTIME = rt;
        console.log(`Runtime: ${rt}`);
      } else {
        console.error(`Unknown runtime: ${rt}. Use: claude | codex`);
        process.exit(1);
      }
    }
    daemonStart();
    break;
  }

  case 'stop':
    daemonStop();
    break;

  case 'status':
    await daemonStatus();
    break;

  case 'logs':
    daemonLogs(parseInt(args[0], 10) || 50);
    break;

  case 'hooks': {
    const hooksSub = args[0];
    const pauseFile = join(TLIVE_HOME, 'hooks-paused');
    if (hooksSub === 'pause') {
      mkdirSync(TLIVE_HOME, { recursive: true });
      writeFileSync(pauseFile, '');
      console.log('Hooks paused — all permissions auto-allowed, no notifications.');
    } else if (hooksSub === 'resume') {
      try { unlinkSync(pauseFile); } catch {}
      console.log('Hooks resumed — permissions forwarded to IM.');
    } else {
      const paused = existsSync(pauseFile);
      console.log(`Hooks: ${paused ? '⏸ paused (auto-allow)' : '▶ active'}`);
    }
    break;
  }

  case 'doctor':
    await runDoctor();
    break;

  case 'version': {
    const ver = getVersion();
    console.log(`tlive          ${ver}`);
    console.log(`node           ${process.version}`);
    // Check for updates
    try {
      const resp = await fetch('https://api.github.com/repos/huanghuoguoguo/tlive/releases/latest', {
        headers: { 'Accept': 'application/vnd.github.v3+json' },
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const data = await resp.json();
        const latest = data.tag_name?.replace(/^v/, '') || data.name?.replace(/^v/, '');
        if (latest && latest !== ver) {
          console.log(`\nUpdate available: ${ver} → ${latest}`);
          console.log('Run: tlive update');
        } else {
          console.log('\nUp to date.');
        }
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
    console.log(`Current version: ${current}`);

    // Check latest version from GitHub
    let latest = requestedVersion;
    if (!latest) {
      try {
        const resp = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
          headers: { 'Accept': 'application/vnd.github.v3+json' },
          signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok) {
          throw new Error(`GitHub API returned ${resp.status}`);
        }
        const data = await resp.json();
        latest = normalizeRequestedVersion(data.tag_name || data.name);
        if (!latest) {
          throw new Error('Latest version not found in release metadata');
        }
      } catch (e) {
        const errorMsg = 'Failed to check latest version. Are you online?';
        console.error(errorMsg);
        writeUpgradeResult({ success: false, version: current, previousVersion: fromVersion, error: errorMsg });
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
        writeUpgradeResult({ success: false, version: current, previousVersion: fromVersion, error: errorMsg });
        process.exit(1);
      } else {
        const parentPid = Number.parseInt(process.env.TLIVE_UPGRADE_PARENT_PID || '', 10);
        if (Number.isFinite(parentPid) && parentPid > 0) {
          console.log(`Waiting for running bridge (PID ${parentPid}) to exit...`);
          await waitForProcessExit(parentPid);
        }
        console.log('Upgrading from GitHub Release package...');
        const backupDir = await upgradeFromRelease(latest);
        console.log(`\nNew version installed at: ${PACKAGE_ROOT}`);
        console.log(`Previous version backed up at: ${backupDir}`);
      }

      console.log(`\n✅ Upgraded to ${latest}.`);
      console.log('\nChangelog: https://github.com/huanghuoguoguo/tlive/releases');

      // Write success result for bridge to notify user
      writeUpgradeResult({ success: true, version: latest, previousVersion: fromVersion });

      if (bridgeWasRunning) {
        console.log('\nRestarting bridge...');
        if (getBridgePid()) {
          daemonStop();
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        daemonStart();
      }
    } catch (err) {
      const errorMsg = err.message || err;
      console.error(`Upgrade failed: ${errorMsg}`);
      writeUpgradeResult({ success: false, version: current, previousVersion: fromVersion, error: errorMsg });
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
      const refsDir = join(PACKAGE_ROOT, 'references');
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
      console.log('  tlive install skills [--codex]  Install /tlive skill');
    }
    break;
  }

  default: {
    // Check for typos of known commands before failing
    const known = ['setup', 'start', 'stop', 'status', 'logs', 'hooks', 'doctor', 'install', 'help', 'version', 'update', 'upgrade'];
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
