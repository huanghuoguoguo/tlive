import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ProxyAgent } from 'undici';
import type { Agent } from 'node:http';
import type { Dispatcher } from 'undici';

function getProtocol(url: string): string {
  if (!url.includes('://')) {
    throw new Error(`Invalid proxy URL: ${url}. Expected format: protocol://host:port`);
  }
  return url.split('://')[0]?.toLowerCase() ?? '';
}

function isSocks(protocol: string): boolean {
  return ['socks4', 'socks4a', 'socks5', 'socks5h'].includes(protocol);
}

/**
 * Create an http.Agent-compatible proxy agent (for grammy / node-fetch).
 * Supports: http, https, socks4, socks5.
 */
export function createNodeAgent(proxyUrl: string): Agent | undefined {
  if (!proxyUrl) return undefined;
  const protocol = getProtocol(proxyUrl);

  if (isSocks(protocol)) {
    return new SocksProxyAgent(proxyUrl);
  }
  if (protocol === 'http' || protocol === 'https') {
    return new HttpsProxyAgent(proxyUrl);
  }
  throw new Error(`Unsupported proxy protocol: ${protocol}. Use http://, https://, socks4://, or socks5://`);
}

/**
 * Create an undici Dispatcher-compatible proxy agent (for discord.js).
 * Supports: http, https only. SOCKS is not supported by undici.
 */
export function createUndiciAgent(proxyUrl: string): Dispatcher | undefined {
  if (!proxyUrl) return undefined;
  const protocol = getProtocol(proxyUrl);

  if (isSocks(protocol)) {
    console.warn(`[proxy] SOCKS proxy is not supported for Discord. Use http:// or https:// proxy instead.`);
    return undefined;
  }
  if (protocol === 'http' || protocol === 'https') {
    return new ProxyAgent(proxyUrl);
  }
  throw new Error(`Unsupported proxy protocol: ${protocol}. Use http:// or https://`);
}

/** Mask credentials in proxy URL for safe logging */
export function maskProxyUrl(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl);
    if (url.username || url.password) {
      url.username = '****';
      url.password = '****';
    }
    return url.toString();
  } catch {
    return '****';
  }
}
