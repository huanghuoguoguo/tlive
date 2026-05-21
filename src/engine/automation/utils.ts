import type { AgentSettingSource } from '../../config.js';

/** Compare two AgentSettingSource arrays for equality */
export function areSettingSourcesEqual(
  current: AgentSettingSource[] | undefined,
  next: AgentSettingSource[] | undefined,
): boolean {
  const left = current ?? [];
  const right = next ?? [];
  return left.length === right.length && left.every((source, index) => source === right[index]);
}