#!/usr/bin/env node
// TermLive CLI entry point
import { execSync, spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const [,, command, ...args] = process.argv;

const SCRIPTS_DIR = __dirname;
const DAEMON_SH = join(SCRIPTS_DIR, 'daemon.sh');
const CORE_BIN = join(homedir(), '.tlive', 'bin', 'tlive-core');
const PACKAGE_ROOT = join(__dirname, '..');

function getVersion() {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8')).version;
  } catch { return 'unknown'; }
}

const HELP_TEXT = `TLive — Terminal live monitoring + IM bridge for AI coding tools

Usage:
  tlive <cmd> [args]         Wrap any command with web terminal
  tlive <subcommand>         Manage TLive services

Web Terminal:
  tlive claude               Wrap Claude Code with web-accessible terminal
  tlive python train.py      Wrap any long-running command
  tlive npm run build        Access from phone browser via QR code

Setup (one-time):
  tlive setup                Configure IM platforms (Telegram/Discord/Feishu)
  tlive install skills       Install /tlive skill + hooks to Claude Code

Service Management:
  tlive start [--runtime R]  Start IM Bridge (R: claude|codex, default: claude)
  tlive stop                 Stop IM Bridge daemon
  tlive status               Show Bridge + Web Terminal status
  tlive logs [N]             Show last N log lines (default: 50)
  tlive doctor               Run diagnostic checks
  tlive update               Update to latest version
  tlive version              Show version info

Hook Control:
  tlive hooks                Show hook approval status
  tlive hooks pause          Auto-allow all, no IM notifications
  tlive hooks resume         Resume IM approval flow

IM Commands (in Telegram/Discord/Feishu):
  /new                       New conversation
  /runtime claude|codex      Switch AI provider
  /perm on|off               Permission prompts
  /effort low|medium|high|max  Thinking depth
  /stop                      Interrupt execution
  /verbose 0|1               Detail level (0=quiet, 1=terminal card)
  /sessions                  List recent sessions
  /session <n>               Switch to session
  /help                      Show all commands

In Claude Code (AI-guided):
  /tlive                     Start Bridge (with pre-checks)
  /tlive setup               Interactive setup wizard
  /tlive reconfigure         Modify specific config fields
  /tlive doctor              Diagnose issues + suggest fixes
`;

// Known subcommands handled by Node.js CLI
const NODE_COMMANDS = new Set(['setup', 'start', 'stop', 'status', 'logs', 'hooks', 'doctor', 'version', 'update']);

// Commands forwarded to Go Core
const CORE_COMMANDS = new Set(['install']);

function run(cmd, opts = {}) {
  try {
    execSync(cmd, { stdio: 'inherit', ...opts });
  } catch (err) {
    process.exit(err.status || 1);
  }
}

function ensureBridgeRunning() {
  const pidFile = join(homedir(), '.tlive', 'runtime', 'bridge.pid');
  if (existsSync(pidFile)) {
    try {
      const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
      process.kill(pid, 0); // check if alive
      return; // already running
    } catch {}
  }
  // Auto-start Bridge in background
  const configFile = join(homedir(), '.tlive', 'config.env');
  if (!existsSync(configFile)) return; // no config, skip
  try {
    execSync(`bash ${DAEMON_SH} start`, {
      stdio: 'ignore',
      env: { ...process.env, TL_DEFAULT_WORKDIR: process.env.TL_DEFAULT_WORKDIR || process.cwd() },
    });
    console.log('  Bridge auto-started in background');
  } catch {}
}

function runCore(coreArgs) {
  if (!existsSync(CORE_BIN)) {
    console.error(`Go Core not found at ${CORE_BIN}`);
    console.error('Run: npm run setup:core');
    process.exit(1);
  }
  // Auto-start Bridge when wrapping a command (not for install/setup/help)
  ensureBridgeRunning();
  const result = spawnSync(CORE_BIN, coreArgs, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
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
      run(`node ${setupEntry}`);
    } else {
      console.error('Setup wizard not found. Try reinstalling: npm install -g tlive');
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
    run(`bash ${DAEMON_SH} start`);
    break;
  }

  case 'stop':
    run(`bash ${DAEMON_SH} stop`);
    break;

  case 'status':
    run(`bash ${DAEMON_SH} status`);
    break;

  case 'logs':
    run(`bash ${DAEMON_SH} logs ${args[0] || '50'}`);
    break;

  case 'hooks': {
    const hooksSub = args[0];
    const pauseFile = join(homedir(), '.tlive', 'hooks-paused');
    if (hooksSub === 'pause') {
      mkdirSync(join(homedir(), '.tlive'), { recursive: true });
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
    run(`bash ${join(SCRIPTS_DIR, 'doctor.sh')}`);
    break;

  case 'version': {
    const ver = getVersion();
    const coreExists = existsSync(CORE_BIN);
    let coreVer = 'not installed';
    if (coreExists) {
      try {
        const vFile = join(homedir(), '.tlive', 'bin', '.core-version');
        coreVer = readFileSync(vFile, 'utf-8').trim();
      } catch { coreVer = 'unknown'; }
    }
    console.log(`tlive          ${ver}`);
    console.log(`tlive-core     ${coreVer}`);
    console.log(`node           ${process.version}`);
    // Check for updates
    try {
      const latest = execSync('npm view tlive version', { encoding: 'utf-8', timeout: 5000 }).trim();
      if (latest !== ver) {
        console.log(`\nUpdate available: ${ver} → ${latest}`);
        console.log('Run: tlive update');
      } else {
        console.log('\nUp to date.');
      }
    } catch {}
    break;
  }

  case 'update': {
    const current = getVersion();
    console.log(`Current version: ${current}`);
    console.log('Updating...');
    try {
      execSync('npm install -g tlive@latest', { stdio: 'inherit' });
      const updated = execSync('npm view tlive version', { encoding: 'utf-8', timeout: 5000 }).trim();
      console.log(`\nUpdated to ${updated || 'latest'}.`);
      // Restart bridge if running
      const pidFile = join(homedir(), '.tlive', 'runtime', 'bridge.pid');
      if (existsSync(pidFile)) {
        try {
          const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
          process.kill(pid, 0);
          console.log('Restarting bridge...');
          run(`bash ${DAEMON_SH} stop`);
          run(`bash ${DAEMON_SH} start`);
        } catch {}
      }
    } catch (err) {
      console.error(`Update failed: ${err.message || err}`);
      process.exit(1);
    }
    break;
  }

  case 'install': {
    const sub = args[0];
    if (sub === 'skills') {
      const target = args.includes('--codex') ? 'codex' : 'claude';
      const skillSrc = join(PACKAGE_ROOT, 'SKILL.md');
      const hookSrc = join(__dirname, 'hook-handler.sh');
      const notifySrc = join(__dirname, 'notify-handler.sh');
      const stopSrc = join(__dirname, 'stop-handler.sh');

      if (!existsSync(skillSrc)) {
        console.error('SKILL.md not found. Try reinstalling: npm install -g tlive');
        process.exit(1);
      }

      // Install SKILL.md
      const skillDir = target === 'codex'
        ? join(homedir(), '.codex', 'skills', 'tlive')
        : join(homedir(), '.claude', 'commands');
      mkdirSync(skillDir, { recursive: true });

      const skillDest = target === 'codex'
        ? join(skillDir, 'SKILL.md')
        : join(skillDir, 'tlive.md');
      const { copyFileSync } = await import('node:fs');
      copyFileSync(skillSrc, skillDest);
      console.log(`Skill installed: ${skillDest}`);

      // Install hook scripts
      const binDir = join(homedir(), '.tlive', 'bin');
      mkdirSync(binDir, { recursive: true });
      for (const src of [hookSrc, notifySrc, stopSrc]) {
        if (existsSync(src)) {
          const dest = join(binDir, src.split('/').pop());
          copyFileSync(src, dest);
          chmodSync(dest, 0o755);
        }
      }
      console.log(`Hook scripts installed: ${binDir}`);

      // Sync reference docs to ~/.tlive/docs/
      const docsDir = join(homedir(), '.tlive', 'docs');
      mkdirSync(docsDir, { recursive: true });
      const refsDir = join(PACKAGE_ROOT, 'references');
      for (const doc of ['setup-guides.md', 'token-validation.md', 'troubleshooting.md']) {
        const src = join(refsDir, doc);
        const dest = join(docsDir, doc);
        if (existsSync(src)) {
          copyFileSync(src, dest);
        }
      }
      console.log(`Reference docs synced: ${docsDir}`);

      // Auto-configure hooks in ~/.claude/settings.json
      if (target === 'claude') {
        const settingsPath = join(homedir(), '.claude', 'settings.json');
        let settings = {};
        if (existsSync(settingsPath)) {
          try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')); } catch {}
        }

        if (!settings.hooks) settings.hooks = {};

        const hookHandlerCmd = join(binDir, 'hook-handler.sh');
        const notifyHandlerCmd = join(binDir, 'notify-handler.sh');

        // Check if TLive hooks already configured
        const hasHook = (type, cmd) => {
          const entries = settings.hooks[type] || [];
          return entries.some(e => {
            // Support both flat and nested format
            if (e.command?.includes('hook-handler.sh') || e.command?.includes('notify-handler.sh')) return true;
            if (e.hooks) return e.hooks.some(h => h.command?.includes('hook-handler.sh') || h.command?.includes('notify-handler.sh'));
            return false;
          });
        };

        let hooksAdded = false;

        // PermissionRequest: forward Claude Code permission dialogs to IM
        // (replaces PreToolUse — only fires when permission is actually needed)
        if (!hasHook('PermissionRequest', hookHandlerCmd)) {
          if (!settings.hooks.PermissionRequest) settings.hooks.PermissionRequest = [];
          settings.hooks.PermissionRequest.push({
            hooks: [{
              type: 'command',
              command: hookHandlerCmd,
              timeout: 300000,
            }],
          });
          hooksAdded = true;
        }

        // Clean up legacy PreToolUse hook if present
        if (settings.hooks.PreToolUse) {
          settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(e => {
            if (e.hooks) return !e.hooks.some(h => h.command?.includes('hook-handler.sh'));
            return !e.command?.includes('hook-handler.sh');
          });
          if (settings.hooks.PreToolUse.length === 0) delete settings.hooks.PreToolUse;
          hooksAdded = true; // force write to remove legacy
        }

        if (!hasHook('Notification', notifyHandlerCmd)) {
          if (!settings.hooks.Notification) settings.hooks.Notification = [];
          settings.hooks.Notification.push({
            hooks: [{
              type: 'command',
              command: notifyHandlerCmd,
              timeout: 5000,
            }],
          });
          hooksAdded = true;
        }

        const stopHandlerCmd = join(binDir, 'stop-handler.sh');

        const hasStopHook = (settings.hooks.Stop || []).some(e => {
          if (e.hooks) return e.hooks.some(h => h.command?.includes('stop-handler.sh'));
          return e.command?.includes('stop-handler.sh');
        });

        if (!hasStopHook) {
          if (!settings.hooks.Stop) settings.hooks.Stop = [];
          settings.hooks.Stop.push({
            hooks: [{
              type: 'command',
              command: stopHandlerCmd,
              async: true,
            }],
          });
          hooksAdded = true;
        }

        if (hooksAdded) {
          writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
          console.log(`Hooks configured in: ${settingsPath}`);
        } else {
          console.log('Hooks already configured in settings.json');
        }
      }
    } else {
      console.log('Usage: tlive install skills [--codex]');
    }
    break;
  }

  default: {
    // Check for typos of known commands before forwarding to Go Core
    const known = ['setup', 'start', 'stop', 'status', 'logs', 'hooks', 'doctor', 'install', 'help', 'version', 'update'];
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
    // Unknown command → wrap with Go Core web terminal
    runCore([command, ...args]);
    break;
  }
}
