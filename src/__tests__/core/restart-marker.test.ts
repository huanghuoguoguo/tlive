import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  getRestartRequestFile,
  writeRestartRequest,
  readRestartRequest,
  deleteRestartRequest,
  type RestartRequest,
} from '../../core/path.js';

const testRuntimeDir = join(homedir(), '.tlive', 'runtime');

describe('restart request marker', () => {
  beforeEach(() => {
    mkdirSync(testRuntimeDir, { recursive: true });
  });

  afterEach(() => {
    const file = getRestartRequestFile();
    try { rmSync(file, { force: true }); } catch { /* ignore */ }
  });

  describe('writeRestartRequest', () => {
    it('writes marker file with correct structure', () => {
      writeRestartRequest(12345);

      const file = getRestartRequestFile();
      expect(existsSync(file)).toBe(true);

      const content = JSON.parse(readFileSync(file, 'utf-8')) as RestartRequest;
      expect(content.oldPid).toBe(12345);
      expect(content.timestamp).toBeDefined();
    });

    it('overwrites existing marker file', () => {
      writeRestartRequest(11111);
      writeRestartRequest(22222);

      const content = readRestartRequest();
      expect(content?.oldPid).toBe(22222);
    });
  });

  describe('readRestartRequest', () => {
    it('returns null when file does not exist', () => {
      deleteRestartRequest();
      expect(readRestartRequest()).toBeNull();
    });

    it('returns parsed content when file exists', () => {
      writeRestartRequest(99999);
      const result = readRestartRequest();
      expect(result?.oldPid).toBe(99999);
    });

    it('returns null for malformed JSON', () => {
      const file = getRestartRequestFile();
      mkdirSync(testRuntimeDir, { recursive: true });
      writeFileSync(file, 'not valid json');

      expect(readRestartRequest()).toBeNull();
    });
  });

  describe('deleteRestartRequest', () => {
    it('removes marker file', () => {
      writeRestartRequest(12345);
      deleteRestartRequest();

      const file = getRestartRequestFile();
      expect(existsSync(file)).toBe(false);
    });

    it('does not throw when file does not exist', () => {
      deleteRestartRequest(); // File doesn't exist
      deleteRestartRequest(); // Should not throw
      expect(true).toBe(true);
    });
  });

  describe('getRestartRequestFile', () => {
    it('returns path in runtime directory', () => {
      const path = getRestartRequestFile();
      expect(path).toContain('.tlive');
      expect(path).toContain('runtime');
      expect(path).toContain('restart-request.json');
    });
  });
});