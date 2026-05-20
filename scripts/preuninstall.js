#!/usr/bin/env node
// preuninstall: clean up installed binaries, scripts, and docs from ~/.tlive/
// Preserves user data: config.env, data/, logs/, runtime/
import { existsSync, unlinkSync, readdirSync, rmdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const TLIVE_HOME = process.env.TLIVE_HOME?.trim() || join(homedir(), '.tlive');
const BIN_DIR = join(TLIVE_HOME, 'bin');
const DOCS_DIR = join(TLIVE_HOME, 'docs');

// Stop bridge daemon if running
function stopBridge() {
  const pidFile = join(TLIVE_HOME, 'runtime', 'bridge.pid');
  if (!existsSync(pidFile)) return;
  try {
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    process.kill(pid);
    unlinkSync(pidFile);
    console.log(`Stopped bridge daemon (PID ${pid})`);
  } catch {
    // Already dead or no permission
  }
}

// Remove files installed by postinstall
function cleanBinDir() {
  const files = [
    'tlive-core', 'tlive-core.exe',
    '.core-version',
    // Legacy .sh files (from versions <= 0.4.2)
    'hook-handler.sh', 'notify-handler.sh', 'stop-handler.sh',
    // Legacy .mjs copies (from early 0.4.3 builds)
    'hook-handler.mjs', 'notify-handler.mjs', 'stop-handler.mjs', 'statusline.mjs',
  ];
  let removed = 0;
  for (const f of files) {
    const p = join(BIN_DIR, f);
    if (existsSync(p)) {
      unlinkSync(p);
      removed++;
    }
  }
  // Remove bin/ if empty
  try {
    if (existsSync(BIN_DIR) && readdirSync(BIN_DIR).length === 0) {
      rmdirSync(BIN_DIR);
    }
  } catch {}
  if (removed > 0) console.log(`Removed ${removed} file(s) from ${BIN_DIR}`);
}

// Remove reference docs installed by postinstall
function cleanDocs() {
  if (!existsSync(DOCS_DIR)) return;
  const docs = ['setup-guides.md', 'token-validation.md', 'troubleshooting.md'];
  for (const doc of docs) {
    const p = join(DOCS_DIR, doc);
    if (existsSync(p)) unlinkSync(p);
  }
  // Remove docs/ if empty
  try {
    if (readdirSync(DOCS_DIR).length === 0) rmdirSync(DOCS_DIR);
  } catch {}
  console.log(`Removed reference docs from ${DOCS_DIR}`);
}

// Remove Claude Code hooks that point to our scripts
function cleanHooks() {
  const settingsPath = join(homedir(), '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return;
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    if (!settings.hooks) return;

    let changed = false;
    for (const hookType of ['PermissionRequest', 'Notification', 'Stop', 'PreToolUse']) {
      const entries = settings.hooks[hookType];
      if (!Array.isArray(entries)) continue;
      const filtered = entries.filter(e => {
        if (e.hooks) return !e.hooks.some(h => /hook-handler\.(sh|mjs)|notify-handler\.(sh|mjs)|stop-handler\.(sh|mjs)/.test(h.command || ''));
        return !/hook-handler\.(sh|mjs)|notify-handler\.(sh|mjs)|stop-handler\.(sh|mjs)/.test(e.command || '');
      });
      if (filtered.length !== entries.length) {
        changed = true;
        if (filtered.length === 0) delete settings.hooks[hookType];
        else settings.hooks[hookType] = filtered;
      }
    }

    if (changed) {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      console.log('Removed TLive hooks from Claude Code settings');
    }
  } catch {}
}

console.log('Cleaning up TLive...');
stopBridge();
cleanBinDir();
cleanDocs();
await cleanHooks();
console.log('TLive uninstalled. User data preserved in ~/.tlive/ (config, sessions, logs).');
