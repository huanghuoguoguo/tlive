import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../shared/config.js';

const ENV_KEYS = [
  'TLIVE_HOME',
  'TL_TOKEN',
  'TL_FS_APP_ID',
  'TL_FS_APP_SECRET',
  'TL_DEFAULT_WORKDIR',
  'TL_REMOTE_CLIENT_ID',
  'TL_REMOTE_CLIENT_NAME',
  'TL_REMOTE_CLIENT_NOTE',
  'TL_REMOTE_WORKSPACES',
];

describe('role-specific config loading', () => {
  let previousEnv: Record<string, string | undefined>;
  let root: string;

  beforeEach(() => {
    previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
    root = mkdtempSync(join(tmpdir(), 'tlive-config-'));
    process.env.TLIVE_HOME = root;
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('migrates legacy config.env into missing role-specific files', () => {
    writeFileSync(
      join(root, 'config.env'),
      [
        'TL_TOKEN=legacy-token',
        'TL_REMOTE_TOKEN=remote-token',
        'TL_FS_APP_ID=legacy-app',
        'TL_FS_APP_SECRET=legacy-secret',
        'TL_DEFAULT_WORKDIR=/legacy-default',
        'TL_REMOTE_CLIENT_ID=legacy-client',
        'TL_REMOTE_CLIENT_NAME=Legacy Client',
        'HTTP_PROXY=http://127.0.0.1:7890',
      ].join('\n'),
    );

    const server = loadConfig();
    const client = loadConfig({ validateBridge: false });
    const serverFile = readFileSync(join(root, 'server.env'), 'utf-8');
    const clientFile = readFileSync(join(root, 'client.env'), 'utf-8');

    expect(server.token).toBe('legacy-token');
    expect(server.remote.server.token).toBe('remote-token');
    expect(server.feishu.appId).toBe('legacy-app');
    expect(server.defaultWorkdir).not.toBe('/legacy-default');
    expect(client.remote.client.token).toBe('remote-token');
    expect(client.defaultWorkdir).toBe('/legacy-default');
    expect(client.remote.client.clientId).toBe('legacy-client');
    expect(client.remote.client.name).toBe('Legacy Client');
    expect(existsSync(join(root, 'server.env'))).toBe(true);
    expect(existsSync(join(root, 'client.env'))).toBe(true);
    expect(serverFile).toContain('TL_FS_APP_ID=legacy-app');
    expect(serverFile).not.toContain('TL_DEFAULT_WORKDIR=');
    expect(clientFile).toContain('TL_DEFAULT_WORKDIR=/legacy-default');
    expect(clientFile).toContain('HTTP_PROXY=http://127.0.0.1:7890');
    expect(clientFile).not.toContain('TL_FS_APP_ID=');
  });

  it('does not read legacy config.env when role-specific files already exist', () => {
    writeFileSync(
      join(root, 'config.env'),
      [
        'TL_TOKEN=legacy-token',
        'TL_FS_APP_ID=legacy-app',
        'TL_FS_APP_SECRET=legacy-secret',
        'TL_DEFAULT_WORKDIR=/legacy-default',
        'TL_REMOTE_CLIENT_ID=legacy-client',
      ].join('\n'),
    );
    writeFileSync(
      join(root, 'server.env'),
      [
        'TL_TOKEN=server-token',
        'TL_FS_APP_ID=server-app',
        'TL_FS_APP_SECRET=server-secret',
      ].join('\n'),
    );
    writeFileSync(
      join(root, 'client.env'),
      [
        'TL_DEFAULT_WORKDIR=/client-default',
        'TL_REMOTE_CLIENT_ID=client-1',
        'TL_REMOTE_CLIENT_NAME=Client One',
        'TL_REMOTE_CLIENT_NOTE=worker note',
        'TL_REMOTE_WORKSPACES=/quick-a,/quick-b',
      ].join('\n'),
    );

    const server = loadConfig();
    expect(server.token).toBe('server-token');
    expect(server.feishu.appId).toBe('server-app');
    expect(server.defaultWorkdir).not.toBe('/legacy-default');
    expect(server.remote.client.clientId).toBe('');

    const client = loadConfig({ validateBridge: false });
    expect(client.token).toBe('');
    expect(client.defaultWorkdir).toBe('/client-default');
    expect(client.remote.client.clientId).toBe('client-1');
    expect(client.remote.client.name).toBe('Client One');
    expect(client.remote.client.note).toBe('worker note');
    expect(client.remote.client.workspaces).toEqual(['/quick-a', '/quick-b']);
  });

  it('keeps shell environment variables above role-specific files', () => {
    writeFileSync(join(root, 'config.env'), 'TL_REMOTE_CLIENT_ID=base-client\n');
    writeFileSync(join(root, 'client.env'), 'TL_REMOTE_CLIENT_ID=file-client\n');
    process.env.TL_REMOTE_CLIENT_ID = 'env-client';

    expect(loadConfig({ validateBridge: false }).remote.client.clientId).toBe('env-client');
  });
});
