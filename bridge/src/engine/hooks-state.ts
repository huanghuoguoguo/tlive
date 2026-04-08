import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

function hooksPauseFile(): string {
  return join(homedir(), '.tlive', 'hooks-paused');
}

export function pauseHooks(): void {
  const file = hooksPauseFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '');
}

export function resumeHooks(): void {
  try {
    unlinkSync(hooksPauseFile());
  } catch {
    // Ignore missing pause file.
  }
}

export function areHooksPaused(): boolean {
  return existsSync(hooksPauseFile());
}
