import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TLIVE_MCP_SERVER_NAME = 'tlive';
const TLIVE_MCP_TOOLS = [
  'tlive_send_file',
  'tlive_send_image',
  'tlive_inject_prompt',
  'tlive_status',
] as const;

type CodexConfigValue = string | number | boolean | CodexConfigValue[] | CodexConfigObject;
type CodexConfigObject = { [key: string]: CodexConfigValue };

export function tliveMcpAllowedClaudeTools(): string[] {
  return TLIVE_MCP_TOOLS.map((tool) => `mcp__${TLIVE_MCP_SERVER_NAME}__${tool}`);
}

export function tliveMcpServersForClaude(): Record<string, unknown> {
  return {
    [TLIVE_MCP_SERVER_NAME]: tliveMcpServerConfig(),
  };
}

export function tliveMcpConfigForCodex(): CodexConfigObject {
  return {
    mcp_servers: {
      [TLIVE_MCP_SERVER_NAME]: {
        ...tliveMcpServerConfig(),
        tools: Object.fromEntries(
          TLIVE_MCP_TOOLS.map((tool) => [tool, { approval_mode: 'approve' }]),
        ),
      },
    },
  };
}

function tliveMcpServerConfig(): { command: string; args: string[]; env?: Record<string, string> } {
  const entry = resolveBundledMcpEntry();
  const env = tliveMcpEnvironment();
  if (entry) {
    return {
      command: process.execPath,
      args: [entry],
      ...(Object.keys(env).length ? { env } : {}),
    };
  }
  return {
    command: 'tlive',
    args: ['mcp'],
    ...(Object.keys(env).length ? { env } : {}),
  };
}

function resolveBundledMcpEntry(): string | undefined {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(currentDir, 'mcp.mjs'),
    join(currentDir, '..', '..', 'dist', 'mcp.mjs'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function tliveMcpEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    'TLIVE_HOME',
    'TLIVE_MCP_BRIDGE_URL',
    'TL_WEBHOOK_TOKEN',
    'TL_WEBHOOK_PORT',
    'TL_WEBHOOK_PATH',
    'TL_TOKEN',
    'TL_PORT',
  ]) {
    const value = process.env[key]?.trim();
    if (value) env[key] = value;
  }
  return env;
}
