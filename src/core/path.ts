import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';

/** Get TLive home directory path */
export function getTliveHome(): string {
  return join(homedir(), '.tlive');
}

/** Get TLive runtime directory path */
export function getTliveRuntimeDir(): string {
  return join(getTliveHome(), 'runtime');
}

/** Get restart request marker file path */
export function getRestartRequestFile(): string {
  return join(getTliveRuntimeDir(), 'restart-request.json');
}

export interface RestartRequest {
  timestamp: string;
  oldPid: number;
}

/** Write restart request marker file */
export function writeRestartRequest(oldPid: number): void {
  const file = getRestartRequestFile();
  mkdirSync(getTliveRuntimeDir(), { recursive: true });
  writeFileSync(file, JSON.stringify({
    timestamp: new Date().toISOString(),
    oldPid,
  }, null, 2));
}

/** Read restart request marker file */
export function readRestartRequest(): RestartRequest | null {
  const file = getRestartRequestFile();
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as RestartRequest;
  } catch {
    return null;
  }
}

/** Delete restart request marker file */
export function deleteRestartRequest(): void {
  const file = getRestartRequestFile();
  try { unlinkSync(file); } catch { /* ignore */ }
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