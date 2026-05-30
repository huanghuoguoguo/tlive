const TLIVE_MCP_SERVER_NAME = 'tlive';
const TLIVE_MCP_TOOLS = ['tlive_send_file', 'tlive_send_image', 'tlive_status'] as const;

type CodexConfigValue = string | number | boolean | CodexConfigValue[] | CodexConfigObject;
type CodexConfigObject = { [key: string]: CodexConfigValue };
type TliveMcpServerConfig = { type: 'http'; url: string; headers?: Record<string, string> };
type CodexMcpServerConfig = { url: string; bearer_token_env_var?: string };

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
      [TLIVE_MCP_SERVER_NAME]: tliveMcpServerConfigForCodex(),
    },
  };
}

function tliveMcpServerConfig(): TliveMcpServerConfig {
  const url = process.env.TL_MCP_URL?.trim() || defaultHttpMcpUrl();
  const token =
    process.env.TL_MCP_TOKEN?.trim() ||
    process.env.TL_REMOTE_TOKEN?.trim() ||
    process.env.TL_TOKEN?.trim();
  return {
    type: 'http',
    url,
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  };
}

function tliveMcpServerConfigForCodex(): CodexMcpServerConfig {
  const config = tliveMcpServerConfig();
  return {
    url: config.url,
    ...optionalBearerTokenEnvVar(),
  };
}

function optionalBearerTokenEnvVar():
  | Pick<CodexMcpServerConfig, 'bearer_token_env_var'>
  | Record<string, never> {
  if (process.env.TL_MCP_TOKEN?.trim()) return { bearer_token_env_var: 'TL_MCP_TOKEN' };
  if (process.env.TL_REMOTE_TOKEN?.trim()) return { bearer_token_env_var: 'TL_REMOTE_TOKEN' };
  if (process.env.TL_TOKEN?.trim()) return { bearer_token_env_var: 'TL_TOKEN' };
  return {};
}

function defaultHttpMcpUrl(): string {
  const path = normalizePath(process.env.TL_MCP_PATH?.trim() || '/mcp');
  const base =
    httpBaseFromRemoteServerUrl(process.env.TL_REMOTE_SERVER_URL?.trim()) ||
    `http://127.0.0.1:${process.env.TL_MCP_PORT?.trim() || '8081'}`;
  return `${base.replace(/\/+$/, '')}${path}`;
}

function httpBaseFromRemoteServerUrl(serverUrl: string | undefined): string | undefined {
  if (!serverUrl) return undefined;
  try {
    const url = new URL(serverUrl);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '';
    url.search = '';
    url.hash = '';
    url.port = process.env.TL_MCP_PORT?.trim() || '8081';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return '/mcp';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}
