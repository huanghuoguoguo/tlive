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

/** Expand ~ in path to actual home directory */
export function expandTilde(path: string): string {
  return path.startsWith('~') ? join(homedir(), path.slice(1)) : path;
}

/** Shorten path by replacing home directory with ~ */
export function shortPath(path: string): string {
  const home = homedir();
  return path.replace(home, '~').replace(/\\/g, '/');
}