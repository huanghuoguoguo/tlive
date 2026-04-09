/**
 * Version checker for tlive upgrades.
 * Checks GitHub Releases API for new versions.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');

const REPO = 'huanghuoguoguo/tlive';
const GITHUB_API = `https://api.github.com/repos/${REPO}/releases/latest`;

export interface VersionInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
  releaseUrl?: string;
  releaseNotes?: string;
  publishedAt?: string;
}

/**
 * Get current installed version from package.json
 */
export function getCurrentVersion(): string {
  return packageJson.version;
}

/**
 * Parse semver version string into comparable parts
 */
function parseVersion(v: string): [number, number, number] {
  const parts = v.replace(/^v/, '').split('.').map(Number);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

/**
 * Compare two versions: returns -1, 0, or 1
 */
function compareVersions(a: string, b: string): number {
  const [aMajor, aMinor, aPatch] = parseVersion(a);
  const [bMajor, bMinor, bPatch] = parseVersion(b);

  if (aMajor !== bMajor) return aMajor - bMajor;
  if (aMinor !== bMinor) return aMinor - bMinor;
  return aPatch - bPatch;
}

/**
 * Check for updates by querying GitHub Releases API.
 * Returns null if check fails.
 */
export async function checkForUpdates(): Promise<VersionInfo | null> {
  const current = getCurrentVersion();

  try {
    const resp = await fetch(GITHUB_API, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': `tlive/${current}`,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      console.warn(`[version-checker] GitHub API returned ${resp.status}`);
      return null;
    }

    const data = await resp.json() as {
      tag_name?: string;
      html_url?: string;
      body?: string;
      published_at?: string;
    };

    const latest = data.tag_name?.replace(/^v/, '') || '';
    if (!latest) {
      console.warn('[version-checker] No tag_name in response');
      return null;
    }

    const hasUpdate = compareVersions(current, latest) < 0;

    return {
      current,
      latest,
      hasUpdate,
      releaseUrl: data.html_url,
      releaseNotes: data.body?.slice(0, 500),
      publishedAt: data.published_at,
    };
  } catch (err) {
    console.warn('[version-checker] Failed to check for updates:', err);
    return null;
  }
}

/**
 * Generate upgrade command based on OS
 */
export function getUpgradeCommand(version?: string): string {
  const versionArg = version ? ` ${version}` : '';
  return `curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash -s --${versionArg}`;
}