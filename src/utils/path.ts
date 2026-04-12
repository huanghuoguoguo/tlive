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

/** Shorten path by replacing home directory with ~ */
export function shortPath(path: string): string {
  const home = homedir();
  return path.replace(home, '~').replace(/\\/g, '/');
}