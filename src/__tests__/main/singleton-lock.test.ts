import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireSingletonLock } from '../../main.js';
import {
  getTliveRuntimeDir,
  getRestartRequestFile,
  writeRestartRequest,
  deleteRestartRequest,
} from '../../core/path.js';

const originalTliveHome = process.env.TLIVE_HOME;
const originalProcRoot = process.env.TLIVE_PROC_ROOT;
const testHome = mkdtempSync(join(tmpdir(), 'tlive-singleton-'));
const testProcRoot = join(testHome, 'proc');
process.env.TLIVE_HOME = testHome;
process.env.TLIVE_PROC_ROOT = testProcRoot;

const testRuntimeDir = getTliveRuntimeDir();
const pidFile = join(testRuntimeDir, 'bridge.pid');

function writeProcMetadata(pid: number, cmdline: string[], cwd = '/home/glwuy/workspace/tlive') {
  const procDir = join(testProcRoot, String(pid));
  mkdirSync(procDir, { recursive: true });
  writeFileSync(join(procDir, 'cmdline'), `${cmdline.join('\0')}\0`);
  writeFileSync(join(procDir, 'comm'), `${cmdline[0]?.includes('node') ? 'node' : cmdline[0]}\n`);
  try {
    symlinkSync(cwd, join(procDir, 'cwd'), 'dir');
  } catch {
    /* ignore */
  }
}

describe('acquireSingletonLock restart handoff', () => {
  beforeEach(() => {
    mkdirSync(testRuntimeDir, { recursive: true });
    // Clean up any existing files
    try { rmSync(pidFile, { force: true }); } catch { /* ignore */ }
    try { rmSync(testProcRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    deleteRestartRequest();
  });

  afterEach(() => {
    // Clean up after test
    try { rmSync(pidFile, { force: true }); } catch { /* ignore */ }
    deleteRestartRequest();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    if (originalTliveHome === undefined) {
      delete process.env.TLIVE_HOME;
    } else {
      process.env.TLIVE_HOME = originalTliveHome;
    }

    if (originalProcRoot === undefined) {
      delete process.env.TLIVE_PROC_ROOT;
    } else {
      process.env.TLIVE_PROC_ROOT = originalProcRoot;
    }

    try { rmSync(testHome, { recursive: true, force: true }); } catch { /* ignore */ }
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
      writeProcMetadata(fakeOldPid, [process.execPath, '/home/glwuy/workspace/tlive/dist/main.mjs']);

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
      expect(killSpy).not.toHaveBeenCalledWith(fakeOldPid, 'SIGKILL');
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

    it('overwrites legacy pure PID file when process is stale', () => {
      writeFileSync(pidFile, '12345');
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === 12345 && signal === 0) {
          throw new Error('Process not found');
        }
        return true;
      });

      acquireSingletonLock();

      expect(killSpy).toHaveBeenCalledWith(12345, 0);
      const writtenPid = readFileSync(pidFile, 'utf-8').trim();
      expect(writtenPid).toBe(String(process.pid));
    });

    it('reads JSON lock file and replaces it when process is stale', () => {
      const fakeOldPid = 99996;
      writeFileSync(pidFile, JSON.stringify({
        pid: fakeOldPid,
        startedAt: '2026-05-22T00:00:00.000Z',
        argv: [process.execPath, '/home/glwuy/workspace/tlive/dist/main.mjs'],
        cwd: '/home/glwuy/workspace/tlive',
      }));
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === fakeOldPid && signal === 0) {
          throw new Error('Process not found');
        }
        return true;
      });

      acquireSingletonLock();

      expect(killSpy).toHaveBeenCalledWith(fakeOldPid, 0);
      const writtenPid = readFileSync(pidFile, 'utf-8').trim();
      expect(writtenPid).toBe(String(process.pid));
    });

    it('does not kill a live PID that is not a tlive bridge process', () => {
      const fakeOldPid = 99995;
      writeFileSync(pidFile, String(fakeOldPid));
      writeProcMetadata(fakeOldPid, ['sleep', '60'], '/tmp');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === fakeOldPid && signal === 0) {
          return true;
        }
        if (pid === fakeOldPid && (signal === 'SIGTERM' || signal === 'SIGKILL')) {
          throw new Error('should not kill non-tlive process');
        }
        return true;
      });

      acquireSingletonLock();

      expect(killSpy).toHaveBeenCalledWith(fakeOldPid, 0);
      expect(killSpy).not.toHaveBeenCalledWith(fakeOldPid, 'SIGTERM');
      expect(killSpy).not.toHaveBeenCalledWith(fakeOldPid, 'SIGKILL');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('does not look like a tlive'));
      const writtenPid = readFileSync(pidFile, 'utf-8').trim();
      expect(writtenPid).toBe(String(process.pid));
    });

    it('does not trust stale JSON metadata for a live non-tlive node PID', () => {
      const fakeOldPid = 99994;
      writeFileSync(pidFile, JSON.stringify({
        pid: fakeOldPid,
        startedAt: '2026-05-22T00:00:00.000Z',
        argv: [process.execPath, '/home/glwuy/workspace/tlive/dist/main.mjs'],
        cwd: '/home/glwuy/workspace/tlive',
      }));
      writeProcMetadata(fakeOldPid, [process.execPath, '/tmp/server.js'], '/tmp');
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === fakeOldPid && signal === 0) {
          return true;
        }
        if (pid === fakeOldPid && (signal === 'SIGTERM' || signal === 'SIGKILL')) {
          throw new Error('should not kill reused node process');
        }
        return true;
      });
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      acquireSingletonLock();

      expect(killSpy).toHaveBeenCalledWith(fakeOldPid, 0);
      expect(killSpy).not.toHaveBeenCalledWith(fakeOldPid, 'SIGTERM');
      expect(killSpy).not.toHaveBeenCalledWith(fakeOldPid, 'SIGKILL');
      const writtenPid = readFileSync(pidFile, 'utf-8').trim();
      expect(writtenPid).toBe(String(process.pid));
    });
  });
});
