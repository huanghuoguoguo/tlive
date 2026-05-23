/**
 * Version checker for tlive upgrades.
 * Checks GitHub Releases API for new versions.
 * Each version is only notified once automatically.
 */

import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { getTliveHome } from '../core/path.js';

// Version is injected at build time via esbuild define
declare const process: { env: { npm_package_version: string } };

const REPO = 'huanghuoguoguo/tlive';
const GITHUB_LATEST_STABLE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const GITHUB_RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
const NOTIFIED_FILE = join(getTliveHome(), 'data', 'notified-versions.json');

export interface VersionInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
  releaseUrl?: string;
  releaseNotes?: string;
  publishedAt?: string;
}

interface GitHubRelease {
  tag_name?: string;
  name?: string;
  html_url?: string;
  body?: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
}

/**
 * Get current installed version from build-time injection
 */
export function getCurrentVersion(): string {
  return process.env.npm_package_version;
}

function normalizeVersion(v: string): string {
  return v.trim().replace(/^v/i, '');
}

function isPrereleaseVersion(v: string): boolean {
  return normalizeVersion(v).includes('-');
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function parseVersion(v: string): ParsedVersion {
  const [core, prerelease = ''] = normalizeVersion(v).split('-', 2);
  const [major = 0, minor = 0, patch = 0] = core
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  return {
    major,
    minor,
    patch,
    prerelease: prerelease ? prerelease.split('.') : [],
  };
}

function comparePrerelease(aParts: string[], bParts: string[]): number {
  if (!aParts.length && !bParts.length) return 0;
  if (!aParts.length) return 1;
  if (!bParts.length) return -1;

  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const a = aParts[i];
    const b = bParts[i];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNum = /^\d+$/.test(a) ? Number.parseInt(a, 10) : null;
    const bNum = /^\d+$/.test(b) ? Number.parseInt(b, 10) : null;
    if (aNum !== null && bNum !== null && aNum !== bNum) return aNum - bNum;
    if (aNum !== null && bNum === null) return -1;
    if (aNum === null && bNum !== null) return 1;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/**
 * Compare semver-ish versions, including prerelease identifiers.
 * Returns -1, 0, or 1.
 */
export function compareVersions(a: string, b: string): number {
  const aVersion = parseVersion(a);
  const bVersion = parseVersion(b);
  if (aVersion.major !== bVersion.major) return aVersion.major - bVersion.major;
  if (aVersion.minor !== bVersion.minor) return aVersion.minor - bVersion.minor;
  if (aVersion.patch !== bVersion.patch) return aVersion.patch - bVersion.patch;
  return comparePrerelease(aVersion.prerelease, bVersion.prerelease);
}

function releaseVersion(release: GitHubRelease): string {
  return normalizeVersion(release.tag_name || release.name || '');
}

export function selectUpdateRelease(
  current: string,
  releases: GitHubRelease[],
): GitHubRelease | null {
  const currentIsPrerelease = isPrereleaseVersion(current);
  const candidates = releases
    .filter((release) => !release.draft)
    .filter((release) => {
      const version = releaseVersion(release);
      if (!version) return false;
      if (!currentIsPrerelease && release.prerelease) return false;
      return compareVersions(current, version) < 0;
    })
    .sort((a, b) => compareVersions(releaseVersion(b), releaseVersion(a)));

  return candidates[0] ?? null;
}

async function fetchRelease(url: string, current: string): Promise<GitHubRelease | null> {
  const resp = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': `tlive/${current}`,
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    console.warn(`[version-checker] GitHub API returned ${resp.status}`);
    return null;
  }

  return (await resp.json()) as GitHubRelease;
}

async function fetchReleases(current: string): Promise<GitHubRelease[] | null> {
  const resp = await fetch(GITHUB_RELEASES_API, {
    headers: {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': `tlive/${current}`,
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    console.warn(`[version-checker] GitHub API returned ${resp.status}`);
    return null;
  }

  return (await resp.json()) as GitHubRelease[];
}

/**
 * Get list of versions that have already been notified
 */
function getNotifiedVersions(): string[] {
  try {
    if (existsSync(NOTIFIED_FILE)) {
      const data = JSON.parse(readFileSync(NOTIFIED_FILE, 'utf-8'));
      return data.versions || [];
    }
  } catch {
    // Ignore errors
  }
  return [];
}

/**
 * Check if a version has already been notified
 */
export function isVersionNotified(version: string): boolean {
  return getNotifiedVersions().includes(version);
}

/**
 * Mark a version as notified (won't notify again for this version)
 */
export function markVersionNotified(version: string): void {
  try {
    const dir = join(getTliveHome(), 'data');
    mkdirSync(dir, { recursive: true });
    const versions = getNotifiedVersions();
    if (!versions.includes(version)) {
      versions.push(version);
      writeFileSync(NOTIFIED_FILE, JSON.stringify({ versions }));
    }
  } catch {
    // Ignore errors
  }
}

/**
 * Check for updates by querying GitHub Releases API.
 * Always returns version info (for manual checks).
 * Use isVersionNotified() to check if should notify.
 */
export async function checkForUpdates(): Promise<VersionInfo | null> {
  const current = getCurrentVersion();

  try {
    if (isPrereleaseVersion(current)) {
      const releases = await fetchReleases(current);
      if (!releases) return null;
      const update = selectUpdateRelease(current, releases);
      if (!update) {
        return {
          current,
          latest: current,
          hasUpdate: false,
        };
      }
      const latest = releaseVersion(update);
      return {
        current,
        latest,
        hasUpdate: compareVersions(current, latest) < 0,
        releaseUrl: update.html_url,
        releaseNotes: update.body?.slice(0, 500),
        publishedAt: update.published_at,
      };
    }

    const data = await fetchRelease(GITHUB_LATEST_STABLE_API, current);
    if (!data) {
      console.warn('[version-checker] No release found for current update channel');
      return null;
    }

    const latest = releaseVersion(data);
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
