import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface Config {
  port: number;
  token: string;
  publicUrl: string;
  enabledChannels: string[];
  runtime: 'claude' | 'codex' | 'auto';
  defaultWorkdir: string;
  defaultModel: string;
  coreUrl: string;
  telegram: {
    botToken: string;
    chatId: string;
    allowedUsers: string[];
    /** Require @mention in groups (default: true) */
    requireMention: boolean;
    /** Webhook URL (if set, uses webhook instead of polling) */
    webhookUrl: string;
    /** Webhook secret for verification */
    webhookSecret: string;
    /** Webhook listen port (default: 8443) */
    webhookPort: number;
    /** Disable link previews in outbound messages (default: true) */
    disableLinkPreview: boolean;
    /** HTTP/SOCKS proxy URL for api.telegram.org (e.g., socks5://127.0.0.1:1080) */
    proxy: string;
  };
  discord: {
    botToken: string;
    allowedUsers: string[];
    allowedChannels: string[];
  };
  feishu: {
    appId: string;
    appSecret: string;
    verificationToken: string;
    encryptKey: string;
    webhookPort: number;
    allowedUsers: string[];
  };
}

function parseList(value: string | undefined): string[] {
  if (!value || !value.trim()) return [];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

function loadEnvFile(path: string): Record<string, string> {
  try {
    const content = readFileSync(path, 'utf-8');
    const env: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      // Remove surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
    return env;
  } catch {
    return {};
  }
}

export function maskSecret(value: string): string {
  if (!value || value.length <= 4) return '****';
  return '*'.repeat(value.length - 4) + value.slice(-4);
}

export function loadConfig(): Config {
  // 1. Load env file
  const envFile = loadEnvFile(join(homedir(), '.tlive', 'config.env'));

  // 2. Merge: env vars override env file
  const get = (key: string, defaultValue = ''): string =>
    process.env[key] ?? envFile[key] ?? defaultValue;

  const port = parseInt(get('TL_PORT', '8080'), 10);

  return {
    port,
    token: get('TL_TOKEN'),
    publicUrl: get('TL_PUBLIC_URL'),
    enabledChannels: parseList(get('TL_ENABLED_CHANNELS')),
    runtime: (get('TL_RUNTIME', 'claude') as Config['runtime']),
    defaultWorkdir: get('TL_DEFAULT_WORKDIR', process.cwd()),
    defaultModel: get('TL_DEFAULT_MODEL'),
    coreUrl: get('TL_CORE_URL', `http://localhost:${port}`),
    telegram: {
      botToken: get('TL_TG_BOT_TOKEN'),
      chatId: get('TL_TG_CHAT_ID'),
      allowedUsers: parseList(get('TL_TG_ALLOWED_USERS')),
      requireMention: get('TL_TG_REQUIRE_MENTION', 'true') !== 'false',
      webhookUrl: get('TL_TG_WEBHOOK_URL'),
      webhookSecret: get('TL_TG_WEBHOOK_SECRET'),
      webhookPort: parseInt(get('TL_TG_WEBHOOK_PORT', '8443'), 10),
      disableLinkPreview: get('TL_TG_DISABLE_LINK_PREVIEW', 'true') !== 'false',
      proxy: get('TL_TG_PROXY'),
    },
    discord: {
      botToken: get('TL_DC_BOT_TOKEN'),
      allowedUsers: parseList(get('TL_DC_ALLOWED_USERS')),
      allowedChannels: parseList(get('TL_DC_ALLOWED_CHANNELS')),
    },
    feishu: {
      appId: get('TL_FS_APP_ID'),
      appSecret: get('TL_FS_APP_SECRET'),
      verificationToken: get('TL_FS_VERIFICATION_TOKEN'),
      encryptKey: get('TL_FS_ENCRYPT_KEY'),
      webhookPort: parseInt(get('TL_FS_WEBHOOK_PORT', '9100'), 10),
      allowedUsers: parseList(get('TL_FS_ALLOWED_USERS')),
    },
  };
}
