import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceStateManager } from '../../engine/state/workspace-state.js';

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

  describe('history', () => {
    it('pushes directory to history', () => {
      manager.pushHistory('telegram', 'chat1', '/home/user/project');
      const history = manager.getHistory('telegram', 'chat1');
      expect(history).toEqual(['/home/user/project']);
    });

    it('maintains history order (newest first)', () => {
      manager.pushHistory('telegram', 'chat1', '/dir1');
      manager.pushHistory('telegram', 'chat1', '/dir2');
      manager.pushHistory('telegram', 'chat1', '/dir3');

      const history = manager.getHistory('telegram', 'chat1');
      expect(history).toEqual(['/dir3', '/dir2', '/dir1']);
    });

    it('deduplicates history', () => {
      manager.pushHistory('telegram', 'chat1', '/dir1');
      manager.pushHistory('telegram', 'chat1', '/dir2');
      manager.pushHistory('telegram', 'chat1', '/dir1'); // revisit

      const history = manager.getHistory('telegram', 'chat1');
      expect(history).toEqual(['/dir1', '/dir2']);
    });

    it('truncates history to MAX_HISTORY_SIZE', () => {
      for (let i = 0; i < 15; i++) {
        manager.pushHistory('telegram', 'chat1', `/dir${i}`);
      }

      const history = manager.getHistory('telegram', 'chat1');
      expect(history.length).toBe(WorkspaceStateManager.MAX_HISTORY_SIZE);
      // Most recent should be at front
      expect(history[0]).toBe('/dir14');
    });

    it('returns previous directory for /cd -', () => {
      manager.pushHistory('telegram', 'chat1', '/dir1');
      manager.pushHistory('telegram', 'chat1', '/dir2');

      const previous = manager.getPreviousDirectory('telegram', 'chat1');
      expect(previous).toBe('/dir1'); // history[1]
    });

    it('returns undefined if no previous directory', () => {
      manager.pushHistory('telegram', 'chat1', '/dir1');

      const previous = manager.getPreviousDirectory('telegram', 'chat1');
      expect(previous).toBeUndefined();
    });

    it('separates history by chat', () => {
      manager.pushHistory('telegram', 'chat1', '/dir1');
      manager.pushHistory('telegram', 'chat2', '/dir2');

      expect(manager.getHistory('telegram', 'chat1')).toEqual(['/dir1']);
      expect(manager.getHistory('telegram', 'chat2')).toEqual(['/dir2']);
    });
  });

  describe('binding', () => {
    it('sets workspace binding', () => {
      manager.setBinding('telegram', 'chat1', '/home/user/repo');
      expect(manager.getBinding('telegram', 'chat1')).toBe('/home/user/repo');
    });

    it('returns undefined if no binding', () => {
      expect(manager.getBinding('telegram', 'chat1')).toBeUndefined();
    });

    it('clears workspace binding', () => {
      manager.setBinding('telegram', 'chat1', '/home/user/repo');
      manager.clearBinding('telegram', 'chat1');
      expect(manager.getBinding('telegram', 'chat1')).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('clears workspace state for a chat', () => {
      manager.pushHistory('telegram', 'chat1', '/dir1');
      manager.setBinding('telegram', 'chat1', '/repo');

      manager.clear('telegram', 'chat1');

      expect(manager.getHistory('telegram', 'chat1')).toEqual([]);
      expect(manager.getBinding('telegram', 'chat1')).toBeUndefined();
    });
  });
});
