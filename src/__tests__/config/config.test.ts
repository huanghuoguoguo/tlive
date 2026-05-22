import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../../config.js';

describe('loadConfig', () => {
  beforeEach(() => {
    process.env.TL_TOKEN = 'test-token';
    process.env.TL_FS_APP_ID = 'fs-id';
    process.env.TL_FS_APP_SECRET = 'fs-secret';
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
    expect(config.agentSettingSources).toEqual(['user', 'project', 'local']);
  });

  it('accepts legacy TL_CLAUDE_SETTINGS as an alias for agent settings', () => {
    process.env.TL_CLAUDE_SETTINGS = 'user';
    const config = loadConfig();
    expect(config.agentSettingSources).toEqual(['user']);
  });

  it('prefers TL_AGENT_SETTINGS over legacy TL_CLAUDE_SETTINGS', () => {
    process.env.TL_CLAUDE_SETTINGS = 'user';
    process.env.TL_AGENT_SETTINGS = 'user,local';
    const config = loadConfig();
    expect(config.agentSettingSources).toEqual(['user', 'local']);
  });

  it('loads from env vars', () => {
    process.env.TL_PORT = '9090';
    process.env.TL_TOKEN = 'test-token';
    const config = loadConfig();
    expect(config.port).toBe(9090);
    expect(config.token).toBe('test-token');
  });

  it('parses feishu config', () => {
    process.env.TL_FS_APP_ID = 'fs-id';
    process.env.TL_FS_APP_SECRET = 'fs-secret';
    process.env.TL_FS_ALLOWED_USERS = 'fsu1';
    const config = loadConfig();
    expect(config.feishu.appId).toBe('fs-id');
    expect(config.feishu.appSecret).toBe('fs-secret');
    expect(config.feishu.allowedUsers).toEqual(['fsu1']);
    expect(config.feishu.autoPinTopics).toBe(true);
  });

  it('allows disabling Feishu topic auto pinning', () => {
    process.env.TL_FS_AUTO_PIN_TOPIC = 'false';
    const config = loadConfig();
    expect(config.feishu.autoPinTopics).toBe(false);
  });

  it('defaults done card buttons to home only', () => {
    const config = loadConfig();
    expect(config.ui.doneButtons).toEqual(['home']);
  });

  it('parses configurable done card buttons with aliases and dedupe', () => {
    process.env.TL_DONE_BUTTONS = 'home,new,help,permissions,home';
    const config = loadConfig();
    expect(config.ui.doneButtons).toEqual(['home', 'new', 'help', 'perm']);
  });

  it('allows disabling done card buttons', () => {
    process.env.TL_DONE_BUTTONS = 'none';
    const config = loadConfig();
    expect(config.ui.doneButtons).toEqual([]);
  });

  it('rejects unsupported done card buttons', () => {
    process.env.TL_DONE_BUTTONS = 'home,unknown';
    expect(() => loadConfig()).toThrow('TL_DONE_BUTTONS');
  });

  it('normalizes webhook path, strategy, and rate limit config', () => {
    process.env.TL_WEBHOOK_PATH = 'hook/';
    process.env.TL_WEBHOOK_SESSION_STRATEGY = 'invalid';
    process.env.TL_WEBHOOK_RATE_LIMIT_PER_MINUTE = '15';

    const config = loadConfig();
    expect(config.webhook.path).toBe('/hook');
    expect(config.webhook.sessionStrategy).toBe('reject');
    expect(config.webhook.rateLimitPerMinute).toBe(15);
  });
});
