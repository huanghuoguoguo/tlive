import type { ClaudeSettingSource } from '../config.js';

/** Compare two ClaudeSettingSource arrays for equality */
export function areSettingSourcesEqual(
  current: ClaudeSettingSource[] | undefined,
  next: ClaudeSettingSource[] | undefined,
): boolean {
  const left = current ?? [];
  const right = next ?? [];
  return left.length === right.length && left.every((source, index) => source === right[index]);
}