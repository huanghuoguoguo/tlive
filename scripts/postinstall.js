#!/usr/bin/env node
// postinstall: copy lightweight reference files to ~/.tlive/docs/
import { mkdirSync, existsSync, copyFileSync, rmSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TLIVE_HOME = process.env.TLIVE_HOME?.trim() || join(homedir(), '.tlive');

function copyReferenceDocs() {
  const docsDir = join(TLIVE_HOME, 'docs');
  mkdirSync(docsDir, { recursive: true });

  const configExample = join(__dirname, '..', 'config.env.example');
  const configDest = join(docsDir, 'config.env.example');
  if (existsSync(configExample)) {
    copyFileSync(configExample, configDest);
  }

  console.log(`Reference docs installed to ${docsDir}`);
}

function removeRetiredSkills() {
  const retiredSkills = ['tlive', 'tlive-troubleshoot', 'tlive-cron'];
  for (const skill of retiredSkills) {
    const skillDir = join(homedir(), '.claude', 'skills', skill);
    if (existsSync(skillDir)) {
      rmSync(skillDir, { recursive: true, force: true });
      console.log(`Removed retired Claude Code skill: ${skillDir}`);
    }
  }
  const commandFile = join(homedir(), '.claude', 'commands', 'tlive.md');
  if (existsSync(commandFile)) {
    unlinkSync(commandFile);
    console.log(`Removed retired Claude Code command: ${commandFile}`);
  }
}

async function main() {
  console.log('Setting up TLive...');
  copyReferenceDocs();
  removeRetiredSkills();
  console.log('\nTLive setup complete.');
  console.log('Next steps:');
  console.log('  1. tlive setup              — configure Feishu/Lark');
  console.log('  2. tlive start              — start the bridge');
}

main().catch(console.error);
