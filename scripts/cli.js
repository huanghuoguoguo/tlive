#!/usr/bin/env node
// TermLive CLI entry point
import { execSync, spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

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

  case 'doctor':
    run(`bash ${join(SCRIPTS_DIR, 'doctor.sh')}`);
    break;

  default:
    console.log(`TermLive — Terminal live monitoring + IM bridge

Usage: tlive <command>

Commands:
  setup       Configure IM platforms and credentials
  start       Start Go Core + Node.js Bridge
  stop        Stop all services
  status      Show service status
  logs [N]    Show last N log lines (default: 50)
  doctor      Run diagnostic checks

In Claude Code:
  /tlive setup    Interactive setup wizard
  /tlive start    Start services
  /tlive status   Show status
`);
    break;
}
