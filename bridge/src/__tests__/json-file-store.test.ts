import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JsonFileStore } from '../store/json-file.js';
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

  // Sessions
  it('saves and retrieves session', async () => {
    const session = { id: 's1', workingDirectory: '/tmp', createdAt: new Date().toISOString() };
    await store.saveSession(session);
    const got = await store.getSession('s1');
    expect(got).toEqual(session);
  });

  it('lists sessions', async () => {
    await store.saveSession({ id: 's1', workingDirectory: '/tmp', createdAt: '' });
    await store.saveSession({ id: 's2', workingDirectory: '/home', createdAt: '' });
    const list = await store.listSessions();
    expect(list).toHaveLength(2);
  });

  it('deletes session', async () => {
    await store.saveSession({ id: 's1', workingDirectory: '/tmp', createdAt: '' });
    await store.deleteSession('s1');
    expect(await store.getSession('s1')).toBeNull();
  });

  // Messages
  it('saves and retrieves messages', async () => {
    await store.saveMessage('s1', { role: 'user', content: 'hello', timestamp: '' });
    await store.saveMessage('s1', { role: 'assistant', content: 'hi', timestamp: '' });
    const msgs = await store.getMessages('s1');
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe('hello');
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
