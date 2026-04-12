import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Find the git repository root directory for a given path.
 * Returns undefined if the path is not inside a git repository.
 */
export function findGitRoot(path: string): string | undefined {
  let current = resolve(path);
  while (true) {
    if (existsSync(join(current, '.git'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return undefined;
}

/**
 * Check if two directories belong to the same git repository.
 * Returns true if:
 * - Both paths are in the same git repo (share the same .git root)
 * - Neither path is in a git repo (treat as same "non-repo" space)
 * - Either path is undefined (treat as same for simplicity)
 */
export function isSameRepoRoot(path1: string | undefined, path2: string | undefined): boolean {
  // If either is undefined, treat as same
  if (!path1 || !path2) return true;

  const root1 = findGitRoot(path1);
  const root2 = findGitRoot(path2);

  // Both are non-git directories - treat as same
  if (!root1 && !root2) return true;

  // One is git, one is non-git - different
  if (!root1 || !root2) return false;

  // Both are git - check if same root
  return root1 === root2;
}
