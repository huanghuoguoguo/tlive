/**
 * Shared code between ClaudeSDKProvider and ClaudeLiveSession.
 */

// ── Environment isolation ──

const ENV_ALWAYS_STRIP = ['CLAUDECODE'];

export function buildSubprocessEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (ENV_ALWAYS_STRIP.some(prefix => k.startsWith(prefix))) continue;
    out[k] = v;
  }
  return out;
}

// ── Safe permissions for initial settings ──

export const SAFE_PERMISSIONS = [
  'Bash(safe *)',
  'Read(*)',
  'Write(*)',
  'Edit(*)',
  'Glob(*)',
  'Grep(*)',
  'NotebookEdit(*)',
  'WebFetch(domain:*)',
  'WebSearch',
  'Task(*)',
  'ExitPlanMode',
  'ToolSearch',
];
