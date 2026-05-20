import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { acquireSingletonLock } from '../../main.js';
import {
  getTliveRuntimeDir,
  getRestartRequestFile,
  writeRestartRequest,
  deleteRestartRequest,
} from '../../core/path.js';

const testRuntimeDir = getTliveRuntimeDir();
const pidFile = join(testRuntimeDir, 'bridge.pid');

describe('acquireSingletonLock restart handoff', () => {
  beforeEach(() => {
    mkdirSync(testRuntimeDir, { recursive: true });
    // Clean up any existing files
    try { rmSync(pidFile, { force: true }); } catch { /* ignore */ }
    deleteRestartRequest();
  });

  afterEach(() => {
    // Clean up after test
    try { rmSync(pidFile, { force: true }); } catch { /* ignore */ }
    deleteRestartRequest();
    vi.restoreAllMocks();
  });

  describe('restart handoff detection', () => {
    it('detects restart marker and waits for old process', () => {
      const fakeOldPid = 99999;
      writeRestartRequest(fakeOldPid);

      // Mock process.kill to simulate old process immediately dead
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === fakeOldPid && signal === 0) {
          throw new Error('Process not found');
        }
        return true;
      });

      acquireSingletonLock();

      // Should have detected restart handoff
      expect(killSpy).toHaveBeenCalledWith(fakeOldPid, 0);

      // Should have cleaned up restart marker
      expect(existsSync(getRestartRequestFile())).toBe(false);

      // Should have written our PID
      const writtenPid = readFileSync(pidFile, 'utf-8').trim();
      expect(writtenPid).toBe(String(process.pid));
    });

    it('skips killing when restart handoff matches oldPid', () => {
      const fakeOldPid = 99998;
      writeRestartRequest(fakeOldPid);

      // Create a PID file with the same PID
      writeFileSync(pidFile, String(fakeOldPid));

      // Mock process.kill - old process is dead
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === fakeOldPid) {
          throw new Error('Process not found');
        }
        return true;
      });

      acquireSingletonLock();

      // Should NOT have called SIGTERM/SIGKILL (skip killing for restart handoff)
      expect(killSpy).not.toHaveBeenCalledWith(fakeOldPid, 'SIGTERM');
      expect(killSpy).not.toHaveBeenCalledWith(fakeOldPid, 'SIGKILL');
    });

    it('kills process when NOT a restart handoff', () => {
      const fakeOldPid = 99997;

      // Create PID file without restart marker
      writeFileSync(pidFile, String(fakeOldPid));

      // Mock process.kill - process is alive, then dies after SIGTERM
      let processAlive = true;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === fakeOldPid) {
          if (signal === 0) {
            if (!processAlive) throw new Error('Process not found');
            return true;
          }
          if (signal === 'SIGTERM') {
            processAlive = false;
            return true;
          }
        }
        return true;
      });

      acquireSingletonLock();

      // Should have killed the process
      expect(killSpy).toHaveBeenCalledWith(fakeOldPid, 'SIGTERM');
    });

    it('ignores restart marker with same PID as current process', () => {
      // Write restart marker with current PID (should be ignored)
      writeRestartRequest(process.pid);

      const killSpy = vi.spyOn(process, 'kill');

      acquireSingletonLock();

      // Should NOT have tried to kill current process
      expect(killSpy).not.toHaveBeenCalledWith(process.pid, 0);
    });
  });

  describe('PID file operations', () => {
    it('writes current PID to file', () => {
      acquireSingletonLock();

      const writtenPid = readFileSync(pidFile, 'utf-8').trim();
      expect(writtenPid).toBe(String(process.pid));
    });

    it('overwrites existing PID file', () => {
      writeFileSync(pidFile, '12345');
      acquireSingletonLock();

      const writtenPid = readFileSync(pidFile, 'utf-8').trim();
      expect(writtenPid).toBe(String(process.pid));
    });
  });
});