import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface CliDetectionResult {
  available: boolean;
  path?: string;
  version?: string;
  reason?: string;
}

function findCommand(name: string): string | undefined {
  const cmd = process.platform === 'win32' ? `where ${name}` : `which ${name}`;
  try {
    const result = execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim();
    return result.split('\n')[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function commandVersion(cliPath: string): string | undefined {
  try {
    const cmd = cliPath.endsWith('.js') ? `node "${cliPath}" --version` : `"${cliPath}" --version`;
    return execSync(cmd, { encoding: 'utf-8', timeout: 10000 }).trim();
  } catch {
    return undefined;
  }
}

export function findClaudeCli(): string | undefined {
  const fromEnv = process.env.CTI_CLAUDE_CODE_EXECUTABLE;
  if (fromEnv) return fromEnv;

  const found = findCommand('claude');
  if (!found) return undefined;

  if (process.platform === 'win32') {
    const cliJs = join(dirname(found), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (existsSync(cliJs)) return cliJs;
  }

  return found;
}

export function checkClaudeCliVersion(cliPath: string): CliDetectionResult {
  const version = commandVersion(cliPath);
  if (!version)
    return { available: false, path: cliPath, reason: 'Failed to run claude --version' };

  const match = version.match(/(\d+)\.\d+/);
  if (!match || Number.parseInt(match[1], 10) < 2) {
    return {
      available: false,
      path: cliPath,
      version,
      reason: `Claude CLI ${version} too old (need >= 2.x)`,
    };
  }

  return { available: true, path: cliPath, version };
}

export function detectClaudeCli(): CliDetectionResult {
  const cliPath = findClaudeCli();
  if (!cliPath) return { available: false, reason: 'Claude CLI not found' };
  return checkClaudeCliVersion(cliPath);
}

export function detectCodexCli(pathOverride?: string): CliDetectionResult {
  const cliPath = pathOverride || findCommand('codex');
  if (!cliPath) return { available: false, reason: 'Codex CLI not found' };
  const version = commandVersion(cliPath);
  if (!version) return { available: false, path: cliPath, reason: 'Failed to run codex --version' };
  return { available: true, path: cliPath, version };
}
