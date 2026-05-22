import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkForUpdates, compareVersions, selectUpdateRelease } from '../../utils/version-checker.js';

function release(tag: string, prerelease = false) {
  return {
    tag_name: `v${tag}`,
    name: `v${tag}`,
    html_url: `https://example.test/${tag}`,
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
