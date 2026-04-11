import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findGitRoot, isSameRepoRoot } from '../utils/repo.js';

describe('repo utilities', () => {
  let tmpDir: string;

  const createTmpDir = () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tlive-repo-test-'));
    return tmpDir;
  };

  const cleanupTmpDir = () => {
    rmSync(tmpDir, { recursive: true, force: true });
  };

  describe('findGitRoot', () => {
    it('returns undefined for non-git directory', () => {
      const dir = createTmpDir();
      expect(findGitRoot(dir)).toBeUndefined();
      cleanupTmpDir();
    });

    it('returns root for git directory', () => {
      const dir = createTmpDir();
      // Create .git directory
      mkdirSync(join(dir, '.git'));
      expect(findGitRoot(dir)).toBe(dir);
      cleanupTmpDir();
    });

    it('returns parent git root for subdirectory', () => {
      const dir = createTmpDir();
      mkdirSync(join(dir, '.git'));
      const subDir = join(dir, 'src', 'components');
      mkdirSync(subDir, { recursive: true });
      expect(findGitRoot(subDir)).toBe(dir);
      cleanupTmpDir();
    });

    it('returns undefined for directory outside git', () => {
      const gitDir = createTmpDir();
      mkdirSync(join(gitDir, '.git'));
      const nonGitDir = join(tmpdir(), 'non-git-' + Date.now());
      mkdirSync(nonGitDir);
      expect(findGitRoot(nonGitDir)).toBeUndefined();
      rmSync(nonGitDir, { recursive: true, force: true });
      cleanupTmpDir();
    });
  });

  describe('isSameRepoRoot', () => {
    it('returns true when both paths are undefined', () => {
      expect(isSameRepoRoot(undefined, undefined)).toBe(true);
    });

    it('returns true when one path is undefined', () => {
      expect(isSameRepoRoot('/some/path', undefined)).toBe(true);
      expect(isSameRepoRoot(undefined, '/some/path')).toBe(true);
    });

    it('returns true for paths in same git repo', () => {
      const dir = createTmpDir();
      mkdirSync(join(dir, '.git'));
      const subDir1 = join(dir, 'src');
      const subDir2 = join(dir, 'test');
      mkdirSync(subDir1);
      mkdirSync(subDir2);
      expect(isSameRepoRoot(subDir1, subDir2)).toBe(true);
      cleanupTmpDir();
    });

    it('returns false for paths in different git repos', () => {
      const dir1 = createTmpDir();
      mkdirSync(join(dir1, '.git'));
      const dir2 = mkdtempSync(join(tmpdir(), 'tlive-repo-test2-'));
      mkdirSync(join(dir2, '.git'));
      expect(isSameRepoRoot(dir1, dir2)).toBe(false);
      cleanupTmpDir();
      rmSync(dir2, { recursive: true, force: true });
    });

    it('returns true for both non-git directories', () => {
      const dir1 = createTmpDir();
      const dir2 = mkdtempSync(join(tmpdir(), 'tlive-repo-test2-'));
      expect(isSameRepoRoot(dir1, dir2)).toBe(true);
      cleanupTmpDir();
      rmSync(dir2, { recursive: true, force: true });
    });

    it('returns false for git repo vs non-git directory', () => {
      const gitDir = createTmpDir();
      mkdirSync(join(gitDir, '.git'));
      const nonGitDir = mkdtempSync(join(tmpdir(), 'tlive-repo-test2-'));
      expect(isSameRepoRoot(gitDir, nonGitDir)).toBe(false);
      cleanupTmpDir();
      rmSync(nonGitDir, { recursive: true, force: true });
    });
  });
});