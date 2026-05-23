import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JsonFileStore } from '../../server/store/json-file.js';
import type { AgentSettingSource } from '../../shared/config.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('JsonFileStore', () => {
  let tmpDir: string;
  let store: JsonFileStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'termlive-store-'));
    store = new JsonFileStore(tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Bindings
  it('saves and retrieves binding', async () => {
    const binding = { channelType: 'feishu', chatId: '123', sessionId: 's1', createdAt: '' };
    await store.saveBinding(binding);
    const got = await store.getBinding('feishu', '123');
    expect(got).toEqual(binding);
  });

  it('returns null for missing binding', async () => {
    expect(await store.getBinding('feishu', 'missing')).toBeNull();
  });

  it('persists sdkSessionId and cwd in binding', async () => {
    const binding = {
      channelType: 'feishu',
      chatId: '123',
      sessionId: 's1',
      sdkSessionId: 'uuid-1',
      cwd: '/home/test',
      agentSettingSources: ['user', 'project'] as AgentSettingSource[],
      createdAt: '',
    };
    await store.saveBinding(binding);
    const got = await store.getBinding('feishu', '123');
    expect(got?.sdkSessionId).toBe('uuid-1');
    expect(got?.cwd).toBe('/home/test');
    expect(got?.agentSettingSources).toEqual(['user', 'project']);
  });

  it('finds bindings by internal or sdk session id', async () => {
    const binding = {
      channelType: 'feishu',
      chatId: '123',
      sessionId: 'internal-1',
      sdkSessionId: 'sdk-1',
      createdAt: '',
    };
    await store.saveBinding(binding);
    expect(await store.getBindingBySessionId('internal-1')).toEqual(binding);
    expect(await store.getBindingBySessionId('sdk-1')).toEqual(binding);
  });

  it('lists bindings', async () => {
    const first = { channelType: 'feishu', chatId: '1', sessionId: 's1', createdAt: '' };
    const second = { channelType: 'feishu', chatId: '2', sessionId: 's2', createdAt: '' };
    await store.saveBinding(first);
    await store.saveBinding(second);
    expect(await store.listBindings()).toEqual(expect.arrayContaining([first, second]));
  });

  // Locks
  it('acquires and releases lock', async () => {
    expect(await store.acquireLock('k1', 60000)).toBe(true);
    expect(await store.acquireLock('k1', 60000)).toBe(false); // already held
    await store.releaseLock('k1');
    expect(await store.acquireLock('k1', 60000)).toBe(true);
  });

  it('lock expires after TTL', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    expect(await store.acquireLock('k1', 1)).toBe(true);
    now.mockReturnValue(1_002);
    expect(await store.acquireLock('k1', 60000)).toBe(true); // expired
  });
});
