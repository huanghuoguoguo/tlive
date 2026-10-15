import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkForUpdates,
  compareVersions,
  getBuildCommit,
  getBuildFingerprint,
  getCurrentVersion,
  getVersionLabel,
  selectUpdateRelease,
} from '../../shared/utils/version-checker.js';

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function release(tag: string, prerelease = false, body = '') {
  return {
    tag_name: `v${tag}`,
    name: `v${tag}`,
    html_url: `https://example.test/${tag}`,
    body,
    published_at: '2026-05-22T00:00:00Z',
    prerelease,
    draft: false,
  };
}

function mockJsonResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(data),
  };
}

describe('version-checker', () => {
  const originalVersion = process.env.npm_package_version;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env.npm_package_version = originalVersion;
    vi.unstubAllGlobals();
  });

  it('compares prerelease versions using semver precedence', () => {
    expect(compareVersions('0.13.8-beta.1', '0.13.8-beta.2')).toBeLessThan(0);
    expect(compareVersions('0.13.8-beta.10', '0.13.8-beta.2')).toBeGreaterThan(0);
    expect(compareVersions('0.13.8-beta.2', '0.13.8')).toBeLessThan(0);
    expect(compareVersions('0.13.8-beta.2', '0.13.7')).toBeGreaterThan(0);
  });

  it('keeps stable users on the stable release channel', () => {
    const selected = selectUpdateRelease('0.13.7', [
      release('0.13.8-beta.2', true),
      release('0.13.7'),
    ]);

    expect(selected).toBeNull();
  });

  it('offers newer prereleases to prerelease users without downgrading to stable', () => {
    const selected = selectUpdateRelease('0.13.8-beta.1', [
      release('0.13.7'),
      release('0.13.8-beta.2', true),
    ]);

    expect(selected?.tag_name).toBe('v0.13.8-beta.2');
  });

  it('uses GitHub latest for stable versions', async () => {
    process.env.npm_package_version = '0.13.7';
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(release('0.13.7')));
    vi.stubGlobal('fetch', fetchMock);

    const info = await checkForUpdates();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/releases/latest'),
      expect.any(Object),
    );
    expect(info).toMatchObject({ current: '0.13.7', latest: '0.13.7', hasUpdate: false });
  });

  it('includes release notes from GitHub release metadata', async () => {
    process.env.npm_package_version = '0.13.7';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockJsonResponse(release('0.13.8', false, 'Fix Feishu QA paths')));
    vi.stubGlobal('fetch', fetchMock);

    const info = await checkForUpdates();

    expect(info).toMatchObject({
      current: '0.13.7',
      latest: '0.13.8',
      hasUpdate: true,
      releaseNotes: 'Fix Feishu QA paths',
    });
  });

  it('uses the releases list for prerelease versions', async () => {
    process.env.npm_package_version = '0.13.8-beta.1';
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse([
        release('0.13.7'),
        release('0.13.8-beta.2', true),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const info = await checkForUpdates();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/releases?per_page=30'),
      expect.any(Object),
    );
    expect(info).toMatchObject({
      current: '0.13.8-beta.1',
      latest: '0.13.8-beta.2',
      hasUpdate: true,
    });
  });

  it('reports prerelease versions as current when no newer prerelease exists', async () => {
    process.env.npm_package_version = '0.13.8-beta.3';
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse([
        release('0.13.7'),
        release('0.13.8-beta.3', true),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const info = await checkForUpdates();

    expect(info).toMatchObject({
      current: '0.13.8-beta.3',
      latest: '0.13.8-beta.3',
      hasUpdate: false,
    });
  });
});

describe('build fingerprint', () => {
  const originalSha = process.env.TLIVE_BUILD_SHA;
  const originalBranch = process.env.TLIVE_BUILD_BRANCH;
  const originalVersion = process.env.npm_package_version;

  beforeEach(() => {
    delete process.env.TLIVE_BUILD_SHA;
    delete process.env.TLIVE_BUILD_BRANCH;
    process.env.npm_package_version = '1.5.4';
  });

  afterEach(() => {
    restoreEnv('TLIVE_BUILD_SHA', originalSha);
    restoreEnv('TLIVE_BUILD_BRANCH', originalBranch);
    process.env.npm_package_version = originalVersion;
  });

  // The injector writes these as build-time constants; a bundle built without
  // them (or on a tarball install) must degrade to a plain version rather than
  // rendering "undefined".
  it('returns an empty fingerprint when the build injected nothing', () => {
    expect(getBuildCommit()).toBe('');
    expect(getBuildFingerprint()).toBe('');
    expect(getVersionLabel()).toBe('1.5.4');
  });

  it('reports the injected commit and branch', () => {
    process.env.TLIVE_BUILD_SHA = '9d02d37f2';
    process.env.TLIVE_BUILD_BRANCH = 'feat/local-v154';

    expect(getBuildCommit()).toBe('9d02d37f2');
    expect(getBuildFingerprint()).toBe('9d02d37f2 @ feat/local-v154');
  });

  it('omits the branch separator when only a commit is known', () => {
    process.env.TLIVE_BUILD_SHA = '9d02d37f2';

    expect(getBuildFingerprint()).toBe('9d02d37f2');
  });

  it('ignores a branch without a commit', () => {
    process.env.TLIVE_BUILD_BRANCH = 'feat/local-v154';

    expect(getBuildFingerprint()).toBe('');
  });

  it('appends the fingerprint to the display label', () => {
    process.env.TLIVE_BUILD_SHA = '9d02d37f2';
    process.env.TLIVE_BUILD_BRANCH = 'feat/local-v154';

    expect(getVersionLabel()).toBe('1.5.4 (9d02d37f2 @ feat/local-v154)');
  });

  // getCurrentVersion() feeds compareVersions() for the client upgrade banner,
  // so it must stay a bare semver. Appending a fingerprint there silently
  // breaks version comparison.
  it('keeps getCurrentVersion a bare semver even with a fingerprint present', () => {
    process.env.TLIVE_BUILD_SHA = '9d02d37f2';
    process.env.TLIVE_BUILD_BRANCH = 'feat/local-v154';

    expect(getCurrentVersion()).toBe('1.5.4');
    expect(compareVersions(getCurrentVersion(), '1.5.3')).toBeGreaterThan(0);
  });
});
