import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Cache for findGitRoot results — keyed by resolved path */
const gitRootCache = new Map<string, string | undefined>();

/** Maximum cache size to prevent unbounded growth */
const MAX_CACHE_SIZE = 100;

/**
 * Find the git repository root directory for a given path.
 * Returns undefined if the path is not inside a git repository.
 * Results are cached to avoid repeated filesystem walks.
 */
export function findGitRoot(path: string): string | undefined {
  const resolved = resolve(path);

  // Check cache first
  const cached = gitRootCache.get(resolved);
  if (cached !== undefined || gitRootCache.has(resolved)) {
    return cached;
  }

  // Walk up the directory tree
  let current = resolved;
  while (true) {
    if (existsSync(join(current, '.git'))) {
      // Cache the result
      if (gitRootCache.size >= MAX_CACHE_SIZE) {
        // Evict oldest entry (first key)
        const oldestKey = gitRootCache.keys().next().value;
        if (oldestKey) gitRootCache.delete(oldestKey);
      }
      gitRootCache.set(resolved, current);
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  // Cache negative result too (undefined means no git root)
  gitRootCache.set(resolved, undefined as any);
  return undefined;
}

/**
 * Check if two directories belong to the same git repository.
 * Uses cached findGitRoot results for efficiency.
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
