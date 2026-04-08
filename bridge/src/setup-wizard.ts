// Setup wizard for non-Claude-Code environments
// When running inside Claude Code, the SKILL.md handles setup via AskUserQuestion.
// When running from a regular terminal, this module provides interactive prompts.

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';

const TERMLIVE_HOME = join(homedir(), '.tlive');
const CONFIG_PATH = join(TERMLIVE_HOME, 'config.env');

export function isClaudeCodeEnvironment(): boolean {
  return !!(process.env.CLAUDE_CODE || process.env.CLAUDE_SESSION_ID);
}

async function ask(question: string, defaultValue = ''): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue);
    });
  });
}

type Choice = {
  label: string;
  value: string;
};

async function askChoice(question: string, choices: Choice[], current?: string[]): Promise<string[]> {
  console.log(question);
  choices.forEach((c, i) => {
    const marker = current?.includes(c.value) ? ' (current)' : '';
    console.log(`  ${i + 1}. ${c.label}${marker}`);
  });
  const hint = current?.length ? ` [${current.join(',')}]` : '';
  const answer = await ask(`Enter numbers, comma-separated${hint}`);
  if (!answer && current?.length) return current;
  const indices = answer.split(',').map(s => parseInt(s.trim(), 10) - 1);
  return indices.filter(i => i >= 0 && i < choices.length).map(i => choices[i].value);
}

function loadExistingConfig(): Record<string, string> {
  if (!existsSync(CONFIG_PATH)) return {};
  const content = readFileSync(CONFIG_PATH, 'utf-8');
  const config: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) {
      config[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }
  return config;
}

function maskSecret(value: string): string {
  if (!value || value.length <= 8) return value ? '****' : '';
  return value.slice(0, 4) + '****' + value.slice(-4);
}

function printNextSteps(platforms: string[]): void {
  console.log('\nNext steps:');
  console.log('  tlive install skills    Install Claude Code skill + hooks');
  console.log('  tlive start             Start services');

  if (platforms.includes('feishu')) {
    console.log('\nFeishu first-run checklist:');
    console.log('  1. Finish app publish + admin approval in Feishu');
    console.log('  2. Run /tlive or tlive start');
    console.log('  3. Send the bot a private message in Feishu');
    console.log('  4. Confirm you receive replies, progress updates, and approval cards');
  }

  if (platforms.includes('telegram')) {
    console.log('\nTelegram first-run checklist:');
    console.log('  1. Start a chat with your bot');
    console.log('  2. Run /tlive or tlive start');
    console.log('  3. Send a real task and confirm the reply reaches Telegram');
  }

  if (platforms.includes('discord')) {
    console.log('\nDiscord first-run checklist:');
    console.log('  1. Invite the bot to your target server/channel');
    console.log('  2. Run /tlive or tlive start');
    console.log('  3. Send a real task and confirm the reply reaches Discord');
  }

  if (platforms.includes('qqbot')) {
    console.log('\nQQ Bot first-run checklist:');
    console.log('  1. Confirm the bot is available in your target chat');
    console.log('  2. Run /tlive or tlive start');
    console.log('  3. Send a real task and confirm the reply reaches QQ');
  }
}

export async function runSetupWizard(): Promise<void> {
  if (isClaudeCodeEnvironment()) {
    console.error('Setup wizard should be run via /tlive setup in Claude Code.');
    process.exit(1);
  }

  console.log('=== TLive Setup ===\n');

  const existing = loadExistingConfig();
  const isUpdate = Object.keys(existing).length > 0;

  if (isUpdate) {
    console.log(`Existing config: ${CONFIG_PATH}`);
    console.log(`  Channels: ${existing.TL_ENABLED_CHANNELS || '(none)'}`);
    console.log(`  Port: ${existing.TL_PORT || '8080'}`);
    console.log('');

    const mode = await ask('What do you want to do?\n  1. Update existing config\n  2. Start fresh\n  3. Cancel\nChoice', '1');
    if (mode === '3') { console.log('Cancelled.'); return; }
    if (mode === '2') {
      // Clear existing, start fresh
      for (const key of Object.keys(existing)) {
        delete existing[key];
      }
    }
  }

  const config = { ...existing };

  // Token + port
  if (!config.TL_TOKEN) config.TL_TOKEN = randomBytes(16).toString('hex');
  config.TL_PORT = await ask('Web server port', config.TL_PORT || '8080');

  // Choose platforms
  const currentChannels = (config.TL_ENABLED_CHANNELS || '').split(',').filter(Boolean);
  const platforms = await askChoice(
    '\nWhich IM platforms do you want to enable?\nRecommended for most personal users in Chinese environments: Feishu.',
    [
      { label: 'Feishu (recommended for personal users)', value: 'feishu' },
      { label: 'Telegram', value: 'telegram' },
      { label: 'Discord', value: 'discord' },
      { label: 'QQBot', value: 'qqbot' },
    ],
    currentChannels,
  );
  config.TL_ENABLED_CHANNELS = platforms.join(',');

  // Collect credentials per platform
  if (platforms.includes('telegram')) {
    console.log('\n--- Telegram ---');
    const cur = maskSecret(config.TL_TG_BOT_TOKEN || '');
    config.TL_TG_BOT_TOKEN = await ask('Bot Token (from @BotFather)', cur.includes('****') ? config.TL_TG_BOT_TOKEN : '');
    config.TL_TG_CHAT_ID = await ask('Chat ID (blank = any)', config.TL_TG_CHAT_ID || '');
    config.TL_TG_ALLOWED_USERS = await ask('Allowed user IDs (comma-separated, blank = all)', config.TL_TG_ALLOWED_USERS || '');
  }

  if (platforms.includes('discord')) {
    console.log('\n--- Discord ---');
    config.TL_DC_BOT_TOKEN = await ask('Bot Token', config.TL_DC_BOT_TOKEN || '');
    config.TL_DC_ALLOWED_USERS = await ask('Allowed user IDs (blank = all)', config.TL_DC_ALLOWED_USERS || '');
    config.TL_DC_ALLOWED_CHANNELS = await ask('Allowed channel IDs (blank = all)', config.TL_DC_ALLOWED_CHANNELS || '');
  }

  if (platforms.includes('feishu')) {
    console.log('\n--- Feishu ---');
    config.TL_FS_APP_ID = await ask('App ID', config.TL_FS_APP_ID || '');
    config.TL_FS_APP_SECRET = await ask('App Secret', config.TL_FS_APP_SECRET || '');
  }

  if (platforms.includes('qqbot')) {
    console.log('\n--- QQ Bot ---');
    config.TL_QQ_APP_ID = await ask('App ID (from QQ Open Platform)', config.TL_QQ_APP_ID || '');
    config.TL_QQ_CLIENT_SECRET = await ask('Client Secret', config.TL_QQ_CLIENT_SECRET || '');
    config.TL_QQ_ALLOWED_USERS = await ask('Allowed user openids (comma-separated, blank = all)', config.TL_QQ_ALLOWED_USERS || '');
  }

  // General
  console.log('\n--- General ---');
  config.TL_PUBLIC_URL = await ask('Public URL for web links (blank = local only)', config.TL_PUBLIC_URL || '');

  // Write
  mkdirSync(TERMLIVE_HOME, { recursive: true });
  const lines = Object.entries(config)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${v}`);

  writeFileSync(CONFIG_PATH, lines.join('\n') + '\n', { mode: 0o600 });

  console.log(`\n✅ Config saved to ${CONFIG_PATH}`);
  console.log(`   Token: ${maskSecret(config.TL_TOKEN)}`);
  console.log(`   Port: ${config.TL_PORT}`);
  console.log(`   Channels: ${config.TL_ENABLED_CHANNELS}`);
  printNextSteps(platforms);
}

// Run if executed directly
if (process.argv[1]?.endsWith('setup-wizard.ts') || process.argv[1]?.endsWith('setup.mjs')) {
  runSetupWizard().catch(console.error);
}
