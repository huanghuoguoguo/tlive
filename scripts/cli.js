#!/usr/bin/env node
// TermLive CLI entry point
import { execSync, spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const [,, command, ...args] = process.argv;

const SCRIPTS_DIR = __dirname;
const DAEMON_SH = join(SCRIPTS_DIR, 'daemon.sh');

function run(cmd, opts = {}) {
  try {
    execSync(cmd, { stdio: 'inherit', ...opts });
  } catch (err) {
    process.exit(err.status || 1);
  }
}

switch (command) {
  case 'setup':
    // If running inside Claude Code, the SKILL.md handles setup
    // Otherwise, run the Node.js setup wizard
    const bridgeEntry = join(__dirname, '..', 'bridge', 'dist', 'setup.mjs');
    if (existsSync(bridgeEntry)) {
      run(`node ${bridgeEntry}`);
    } else {
      console.log('Setup wizard not available. Use /tlive setup in Claude Code.');
    }
    break;

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
    const pauseFile = join(process.env.HOME, '.tlive', 'hooks-paused');
    if (hooksSub === 'pause') {
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

  default: {
    // No command or unknown command → try to wrap with Go Core (Web Terminal)
    if (command) {
      // tlive claude, tlive python train.py, etc. → forward to Go Core
      const coreBin = join(process.env.HOME, '.tlive', 'bin', 'tlive-core');
      if (!existsSync(coreBin)) {
        console.error(`Go Core not found at ${coreBin}`);
        console.error('Run: npm run setup:core');
        process.exit(1);
      }
      const result = spawnSync(coreBin, [command, ...args], {
        stdio: 'inherit',
      });
      process.exit(result.status ?? 1);
    }

    console.log(`TermLive — Terminal live monitoring + IM bridge

Usage: tlive <command>        Wrap command with web terminal
       tlive <subcommand>    Manage services

Commands:
  <cmd>       Wrap any command with web terminal (e.g. tlive claude)
  setup       Configure IM platforms and credentials
  start       Start Go Core + Node.js Bridge
  stop        Stop all services
  status      Show service status
  logs [N]    Show last N log lines (default: 50)
  hooks       Show hook status (pause/resume to toggle)
  doctor      Run diagnostic checks

In Claude Code:
  /tlive setup    Interactive setup wizard
  /tlive start    Start services
  /tlive status   Show status
`);
    break;
  }
}
