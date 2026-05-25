/**
 * Shared code between ClaudeSDKProvider and ClaudeLiveSession.
 */

import { redactSensitiveContent } from '../../shared/utils/content-filter.js';
import { getTliveHome } from '../../shared/core/path.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ── Environment isolation ──

const ENV_ALWAYS_STRIP = ['CLAUDECODE'];
const MAX_VISIBLE_STDERR_CHARS = 1200;

function claudeTmpDir(): string {
  return process.env.TL_CLAUDE_TMPDIR?.trim() || join(getTliveHome(), 'tmp', 'claude');
}

export function buildSubprocessEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (ENV_ALWAYS_STRIP.some((prefix) => k.startsWith(prefix))) continue;
    out[k] = v;
  }
  const tmpDir = claudeTmpDir();
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  out.TMPDIR = tmpDir;
  out.TMP = tmpDir;
  out.TEMP = tmpDir;
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

export function appendClaudeStderrToError(message: string, stderr: string): string {
  const cleaned = redactSensitiveContent(stderr)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .join('\n')
    .trim();

  if (!cleaned) return message;

  const stderrTail =
    cleaned.length > MAX_VISIBLE_STDERR_CHARS
      ? `...${cleaned.slice(-MAX_VISIBLE_STDERR_CHARS)}`
      : cleaned;

  if (message.includes(stderrTail)) return message;
  return `${message}\n\nClaude Code stderr:\n${stderrTail}`;
}
