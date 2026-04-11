import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../config.js';

describe('loadConfig', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env.TL_TOKEN = 'test-token';
  });

  afterEach(() => {
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('TL_')) delete process.env[key];
    }
  });

  it('uses defaults when no env vars set', () => {
    const config = loadConfig();
    expect(config.port).toBe(8080);
    expect(config.claudeSettingSources).toEqual(['user', 'project', 'local']);
  });

  it('loads from env vars', () => {
    process.env.TL_PORT = '9090';
    process.env.TL_TOKEN = 'test-token';
    const config = loadConfig();
    expect(config.port).toBe(9090);
    expect(config.token).toBe('test-token');
  });

  it('parses enabled channels', () => {
    process.env.TL_ENABLED_CHANNELS = 'telegram,feishu';
    process.env.TL_TG_BOT_TOKEN = 'tg-token';
    process.env.TL_FS_APP_ID = 'fs-id';
    process.env.TL_FS_APP_SECRET = 'fs-secret';
    const config = loadConfig();
    expect(config.enabledChannels).toEqual(['telegram', 'feishu']);
  });

  it('parses telegram config', () => {
    process.env.TL_TG_BOT_TOKEN = 'tg-token';
    process.env.TL_TG_CHAT_ID = '12345';
    process.env.TL_TG_ALLOWED_USERS = 'user1,user2';
    const config = loadConfig();
    expect(config.telegram.botToken).toBe('tg-token');
    expect(config.telegram.chatId).toBe('12345');
    expect(config.telegram.allowedUsers).toEqual(['user1', 'user2']);
  });

  it('parses feishu config', () => {
    process.env.TL_FS_APP_ID = 'fs-id';
    process.env.TL_FS_APP_SECRET = 'fs-secret';
    process.env.TL_FS_ALLOWED_USERS = 'fsu1';
    const config = loadConfig();
    expect(config.feishu.appId).toBe('fs-id');
    expect(config.feishu.appSecret).toBe('fs-secret');
    expect(config.feishu.allowedUsers).toEqual(['fsu1']);
  });

  it('parses qqbot config', () => {
    process.env.TL_QQ_APP_ID = 'qq-id';
    process.env.TL_QQ_CLIENT_SECRET = 'qq-secret';
    process.env.TL_QQ_ALLOWED_USERS = 'qqu1';
    const config = loadConfig();
    expect(config.qqbot.appId).toBe('qq-id');
    expect(config.qqbot.clientSecret).toBe('qq-secret');
    expect(config.qqbot.allowedUsers).toEqual(['qqu1']);
  });
});
