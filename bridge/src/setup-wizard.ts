// Setup wizard for non-Claude-Code environments
// When running inside Claude Code, the SKILL.md handles setup via AskUserQuestion.
// When running from a regular terminal, this module provides interactive prompts.

import { writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';

const TERMLIVE_HOME = join(homedir(), '.termlive');
const CONFIG_PATH = join(TERMLIVE_HOME, 'config.env');

export function isClaudeCodeEnvironment(): boolean {
  return !!(process.env.CLAUDE_CODE || process.env.CLAUDE_SESSION_ID);
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function askChoice(question: string, choices: string[]): Promise<string[]> {
  console.log(question);
  choices.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
  const answer = await ask('Enter numbers (comma-separated): ');
  const indices = answer.split(',').map(s => parseInt(s.trim(), 10) - 1);
  return indices.filter(i => i >= 0 && i < choices.length).map(i => choices[i]);
}

export async function runSetupWizard(): Promise<void> {
  if (isClaudeCodeEnvironment()) {
    console.error('Setup wizard should be run via /termlive setup in Claude Code.');
    process.exit(1);
  }

  console.log('=== TermLive Setup Wizard ===\n');

  if (existsSync(CONFIG_PATH)) {
    const answer = await ask('Config already exists. Overwrite? (y/n): ');
    if (answer.toLowerCase() !== 'y') {
      console.log('Setup cancelled.');
      return;
    }
  }

  // Step 1: Choose platforms
  const platforms = await askChoice(
    'Which IM platforms do you want to enable?',
    ['Telegram', 'Discord', 'Feishu']
  );

  const config: Record<string, string> = {};
  config.TL_TOKEN = randomBytes(16).toString('hex');
  config.TL_PORT = '8080';
  config.TL_ENABLED_CHANNELS = platforms.map(p => p.toLowerCase()).join(',');

  // Step 2: Collect credentials per platform
  if (platforms.includes('Telegram')) {
    config.TL_TG_BOT_TOKEN = await ask('Telegram Bot Token (from @BotFather): ');
    config.TL_TG_CHAT_ID = await ask('Telegram Chat ID (blank for any): ');
    config.TL_TG_ALLOWED_USERS = await ask('Allowed user IDs (comma-separated, blank for all): ');
  }

  if (platforms.includes('Discord')) {
    config.TL_DC_BOT_TOKEN = await ask('Discord Bot Token: ');
    config.TL_DC_ALLOWED_USERS = await ask('Allowed user IDs (comma-separated, blank for all): ');
    config.TL_DC_ALLOWED_CHANNELS = await ask('Allowed channel IDs (comma-separated, blank for all): ');
  }

  if (platforms.includes('Feishu')) {
    config.TL_FS_APP_ID = await ask('Feishu App ID: ');
    config.TL_FS_APP_SECRET = await ask('Feishu App Secret: ');
  }

  // Step 3: General settings
  config.TL_PUBLIC_URL = await ask('Public URL for web links (blank to skip): ');

  // Step 4: Write config
  mkdirSync(TERMLIVE_HOME, { recursive: true });

  const lines = Object.entries(config)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${v}`);

  writeFileSync(CONFIG_PATH, lines.join('\n') + '\n', { mode: 0o600 });

  console.log(`\nConfig written to ${CONFIG_PATH}`);
  console.log(`Token: ${config.TL_TOKEN}`);
  console.log(`Port: ${config.TL_PORT}`);
  console.log(`\nNext: run 'termlive start' or '/termlive start' in Claude Code`);
}

// Run if executed directly
if (process.argv[1]?.endsWith('setup-wizard.ts') || process.argv[1]?.endsWith('setup.mjs')) {
  runSetupWizard().catch(console.error);
}
