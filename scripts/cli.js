#!/usr/bin/env node
// TermLive CLI entry point
import { execSync, spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, writeFileSync, unlinkSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const [,, command, ...args] = process.argv;

const SCRIPTS_DIR = __dirname;
const DAEMON_SH = join(SCRIPTS_DIR, 'daemon.sh');
const CORE_BIN = join(homedir(), '.tlive', 'bin', 'tlive-core');
const PACKAGE_ROOT = join(__dirname, '..');

const HELP_TEXT = `TermLive — Terminal live monitoring + IM bridge

Usage: tlive <command>        Wrap command with web terminal
       tlive <subcommand>    Manage services

Commands:
  <cmd>           Wrap any command with web terminal (e.g. tlive claude)
  setup           Configure IM platforms and credentials
  start           Start Go Core + Node.js Bridge
  stop            Stop all services
  status          Show service status
  install skills  Install /tlive skill to Claude Code / Codex
  logs [N]        Show last N log lines (default: 50)
  hooks           Show hook status (pause/resume to toggle)
  doctor          Run diagnostic checks

In Claude Code:
  /tlive setup    Interactive setup wizard
  /tlive start    Start services
  /tlive status   Show status
`;

// Known subcommands handled by Node.js CLI
const NODE_COMMANDS = new Set(['setup', 'start', 'stop', 'status', 'logs', 'hooks', 'doctor']);

// Commands forwarded to Go Core
const CORE_COMMANDS = new Set(['install']);

function run(cmd, opts = {}) {
  try {
    execSync(cmd, { stdio: 'inherit', ...opts });
  } catch (err) {
    process.exit(err.status || 1);
  }
}

function runCore(coreArgs) {
  if (!existsSync(CORE_BIN)) {
    console.error(`Go Core not found at ${CORE_BIN}`);
    console.error('Run: npm run setup:core');
    process.exit(1);
  }
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

  case 'start':
    run(`bash ${DAEMON_SH} start`);
    break;

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

  case 'install': {
    const sub = args[0];
    if (sub === 'skills') {
      const target = args.includes('--codex') ? 'codex' : 'claude';
      const skillSrc = join(PACKAGE_ROOT, 'SKILL.md');
      const hookSrc = join(__dirname, 'hook-handler.sh');
      const notifySrc = join(__dirname, 'notify-handler.sh');

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
      for (const src of [hookSrc, notifySrc]) {
        if (existsSync(src)) {
          const dest = join(binDir, src.split('/').pop());
          copyFileSync(src, dest);
          chmodSync(dest, 0o755);
        }
      }
      console.log(`Hook scripts installed: ${binDir}`);

      // Show hooks config hint
      console.log(`
Add to ~/.claude/settings.json (if not already):

  "hooks": {
    "PreToolUse": [{
      "type": "command",
      "command": "${join(binDir, 'hook-handler.sh')}",
      "timeout": 300000
    }],
    "Notification": [{
      "type": "command",
      "command": "${join(binDir, 'notify-handler.sh')}",
      "timeout": 5000
    }]
  }
`);
    } else {
      console.log('Usage: tlive install skills [--codex]');
    }
    break;
  }

  default:
    // Unknown command → wrap with Go Core web terminal
    runCore([command, ...args]);
    break;
}
