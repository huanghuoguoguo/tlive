import { describe, it, expect, vi } from 'vitest';
import { createNodeAgent, createUndiciAgent, maskProxyUrl } from '../proxy.js';

describe('createNodeAgent (for grammy / node-fetch)', () => {
  it('returns undefined for empty string', () => {
    expect(createNodeAgent('')).toBeUndefined();
  });

  it('returns SocksProxyAgent for socks5:// URL', () => {
    const agent = createNodeAgent('socks5://127.0.0.1:1080');
    expect(agent).toBeDefined();
    expect(agent!.constructor.name).toBe('SocksProxyAgent');
  });

  it('returns SocksProxyAgent for socks4:// URL', () => {
    const agent = createNodeAgent('socks4://127.0.0.1:1080');
    expect(agent).toBeDefined();
    expect(agent!.constructor.name).toBe('SocksProxyAgent');
  });

  it('returns HttpsProxyAgent for http:// URL', () => {
    const agent = createNodeAgent('http://127.0.0.1:7890');
    expect(agent).toBeDefined();
    expect(agent!.constructor.name).toBe('HttpsProxyAgent');
  });

  it('returns HttpsProxyAgent for https:// URL', () => {
    const agent = createNodeAgent('https://127.0.0.1:7890');
    expect(agent).toBeDefined();
    expect(agent!.constructor.name).toBe('HttpsProxyAgent');
  });

  it('throws on unsupported protocol', () => {
    expect(() => createNodeAgent('ftp://foo')).toThrow();
  });

  it('throws on malformed URL without ://', () => {
    expect(() => createNodeAgent('socks5:foo')).toThrow('Invalid proxy URL');
  });
});

describe('createUndiciAgent (for discord.js)', () => {
  it('returns undefined for empty string', () => {
    expect(createUndiciAgent('')).toBeUndefined();
  });

  it('returns ProxyAgent for http:// URL', () => {
    const agent = createUndiciAgent('http://127.0.0.1:7890');
    expect(agent).toBeDefined();
  });

  it('returns ProxyAgent for https:// URL', () => {
    const agent = createUndiciAgent('https://127.0.0.1:7890');
    expect(agent).toBeDefined();
  });

  it('returns undefined and warns for socks:// URL', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const agent = createUndiciAgent('socks5://127.0.0.1:1080');
    expect(agent).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('SOCKS'));
    warnSpy.mockRestore();
  });

  it('throws on unsupported protocol', () => {
    expect(() => createUndiciAgent('ftp://foo')).toThrow();
  });
});

describe('maskProxyUrl', () => {
  it('masks credentials in URL', () => {
    expect(maskProxyUrl('socks5://user:pass@host:1080')).not.toContain('user');
    expect(maskProxyUrl('socks5://user:pass@host:1080')).not.toContain('pass');
    expect(maskProxyUrl('socks5://user:pass@host:1080')).toContain('host:1080');
  });

  it('preserves URL without credentials', () => {
    expect(maskProxyUrl('http://127.0.0.1:7890')).toBe('http://127.0.0.1:7890/');
  });

  it('handles invalid URL gracefully', () => {
    expect(maskProxyUrl('not-a-url')).toBe('****');
  });
});
