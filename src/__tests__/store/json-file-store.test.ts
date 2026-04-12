import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JsonFileStore } from '../../store/json-file.js';
import type { ClaudeSettingSource } from '../../config.js';
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
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Bindings
  it('saves and retrieves binding', async () => {
    const binding = { channelType: 'telegram', chatId: '123', sessionId: 's1', createdAt: '' };
    await store.saveBinding(binding);
    const got = await store.getBinding('telegram', '123');
    expect(got).toEqual(binding);
  });

  it('deletes binding', async () => {
    await store.saveBinding({ channelType: 'telegram', chatId: '123', sessionId: 's1', createdAt: '' });
    await store.deleteBinding('telegram', '123');
    expect(await store.getBinding('telegram', '123')).toBeNull();
  });

  it('persists sdkSessionId and cwd in binding', async () => {
    const binding = {
      channelType: 'telegram',
      chatId: '123',
      sessionId: 's1',
      sdkSessionId: 'uuid-1',
      cwd: '/home/test',
      claudeSettingSources: ['user', 'project'] as ClaudeSettingSource[],
      createdAt: '',
    };
    await store.saveBinding(binding);
    const got = await store.getBinding('telegram', '123');
    expect(got?.sdkSessionId).toBe('uuid-1');
    expect(got?.cwd).toBe('/home/test');
    expect(got?.claudeSettingSources).toEqual(['user', 'project']);
  });

  // Dedup
  it('tracks processed messages', async () => {
    expect(await store.isDuplicate('msg1')).toBe(false);
    await store.markProcessed('msg1');
    expect(await store.isDuplicate('msg1')).toBe(true);
  });

  // Locks
  it('acquires and releases lock', async () => {
    expect(await store.acquireLock('k1', 60000)).toBe(true);
    expect(await store.acquireLock('k1', 60000)).toBe(false); // already held
    await store.releaseLock('k1');
    expect(await store.acquireLock('k1', 60000)).toBe(true);
  });

  it('lock expires after TTL', async () => {
    expect(await store.acquireLock('k1', 1)).toBe(true); // 1ms TTL
    await new Promise(r => setTimeout(r, 10));
    expect(await store.acquireLock('k1', 60000)).toBe(true); // expired
  });
});
