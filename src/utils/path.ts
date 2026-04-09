import { homedir } from 'node:os';
import { join } from 'node:path';

/** Get TLive home directory path */
export function getTliveHome(): string {
  return join(homedir(), '.tlive');
}

/** Get TLive runtime directory path */
export function getTliveRuntimeDir(): string {
  return join(getTliveHome(), 'runtime');
}

/** Get TLive logs directory path */
export function getTliveLogsDir(): string {
  return join(getTliveHome(), 'logs');
}

/** Get TLive data directory path */
export function getTliveDataDir(): string {
  return join(getTliveHome(), 'data');
}

/** Shorten path by replacing home directory with ~ */
export function shortPath(path: string): string {
  const home = homedir();
  return path.replace(home, '~').replace(/\\/g, '/');
}

/** Compact path display: show ~/.../lastSegment or .../lastTwoSegments */
export function compactPath(path: string): string {
  const home = homedir();
  const normalized = path.replace(/\\/g, '/');
  const segments = normalized.split('/');

  // Replace home with ~
  if (normalized.startsWith(home.replace(/\\/g, '/'))) {
    const remaining = normalized.slice(home.length);
    const parts = remaining.split('/').filter(Boolean);
    if (parts.length <= 2) {
      return '~/' + parts.join('/');
    }
    return '~/.../' + parts.slice(-2).join('/');
  }

  // Non-home path
  if (segments.length <= 3) {
    return normalized;
  }
  return '.../' + segments.slice(-2).join('/');
}