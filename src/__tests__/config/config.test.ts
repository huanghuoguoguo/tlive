import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('layers server.env and client.env over config.env for their own roles', () => {
    writeFileSync(
      join(root, 'config.env'),
      [
        'TL_TOKEN=base-token',
        'TL_FS_APP_ID=base-app',
        'TL_FS_APP_SECRET=base-secret',
        'TL_DEFAULT_WORKDIR=/base-default',
        'TL_REMOTE_CLIENT_ID=base-client',
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
    expect(server.defaultWorkdir).toBe('/base-default');
    expect(server.remote.client.clientId).toBe('base-client');

    const client = loadConfig({ validateBridge: false });
    expect(client.token).toBe('base-token');
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
