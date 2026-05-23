import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceStateManager } from '../../server/engine/state/workspace-state.js';

describe('WorkspaceStateManager', () => {
  let tmpDir: string;
  let manager: WorkspaceStateManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tlive-workspace-test-'));
    manager = new WorkspaceStateManager(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps per-chat workspace history newest-first, deduped, and bounded', () => {
    for (let i = 0; i < 15; i++) {
      manager.pushHistory('feishu', 'chat-1', `/dir${i}`);
    }
    manager.pushHistory('feishu', 'chat-1', '/dir10');
    manager.pushHistory('feishu', 'chat-2', '/other');

    expect(manager.getHistory('feishu', 'chat-1')).toEqual([
      '/dir10',
      '/dir14',
      '/dir13',
      '/dir12',
      '/dir11',
      '/dir9',
      '/dir8',
      '/dir7',
      '/dir6',
      '/dir5',
    ]);
    expect(manager.getHistory('feishu', 'chat-1')).toHaveLength(
      WorkspaceStateManager.MAX_HISTORY_SIZE,
    );
    expect(manager.getPreviousDirectory('feishu', 'chat-1')).toBe('/dir14');
    expect(manager.getHistory('feishu', 'chat-2')).toEqual(['/other']);
  });

  it('stores and clears workspace binding with the rest of chat state', () => {
    manager.pushHistory('feishu', 'chat-1', '/dir1');
    manager.setBinding('feishu', 'chat-1', '/repo');

    expect(manager.getBinding('feishu', 'chat-1')).toBe('/repo');

    manager.clearBinding('feishu', 'chat-1');
    expect(manager.getBinding('feishu', 'chat-1')).toBeUndefined();
    expect(manager.getHistory('feishu', 'chat-1')).toEqual(['/dir1']);

    manager.setBinding('feishu', 'chat-1', '/repo');
    manager.clear('feishu', 'chat-1');
    expect(manager.getBinding('feishu', 'chat-1')).toBeUndefined();
    expect(manager.getHistory('feishu', 'chat-1')).toEqual([]);
  });
});
