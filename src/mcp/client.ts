import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface TliveMcpConfig {
  fileSendUrl: string;
  webhookUrl: string;
  token: string;
  statusPath: string;
}

export interface TliveToolResponse {
  success: boolean;
  message?: string;
  error?: string;
  [key: string]: unknown;
}

export interface SendFileInput {
  file_path: string;
  caption?: string;
  routeToken?: string;
  channelType?: string;
  chatId?: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
}

export interface InjectPromptInput {
  event: string;
  prompt: string;
  payload?: Record<string, unknown>;
  channelType?: string;
  chatId?: string;
  projectName?: string;
  sessionId?: string;
  silent?: boolean;
}

export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): TliveMcpConfig {
  const home = env.TLIVE_HOME?.trim() || join(homedir(), '.tlive');
  const port = env.TL_WEBHOOK_PORT?.trim() || env.TL_PORT?.trim() || '8080';
  const baseUrl = env.TLIVE_MCP_BRIDGE_URL?.trim() || `http://127.0.0.1:${port}`;
  const webhookPath = normalizePath(env.TL_WEBHOOK_PATH?.trim() || '/webhook');
  const token = env.TL_WEBHOOK_TOKEN?.trim() || env.TL_TOKEN?.trim() || '';

  return {
    fileSendUrl: `${baseUrl}/api/files/send`,
    webhookUrl: env.TLIVE_WEBHOOK_URL?.trim() || `${baseUrl}${webhookPath}`,
    token,
    statusPath: env.TLIVE_STATUS_FILE?.trim() || join(home, 'runtime', 'status.json'),
  };
}

export async function sendFile(input: SendFileInput, config = loadMcpConfig()): Promise<TliveToolResponse> {
  if (!input.file_path.trim()) {
    return { success: false, error: 'file_path is required.' };
  }
  return postJson(config.fileSendUrl, config.token, { ...input });
}

export async function injectPrompt(
  input: InjectPromptInput,
  config = loadMcpConfig(),
): Promise<TliveToolResponse> {
  if (!input.event.trim()) {
    return { success: false, error: 'event is required.' };
  }
  if (!input.prompt.trim()) {
    return { success: false, error: 'prompt is required.' };
  }
  return postJson(config.webhookUrl, config.token, { ...input });
}

export function readStatus(config = loadMcpConfig()): TliveToolResponse {
  if (!existsSync(config.statusPath)) {
    return {
      success: false,
      error: `TLive status file not found: ${config.statusPath}. Start the bridge with tlive start.`,
    };
  }
  try {
    return { success: true, status: JSON.parse(readFileSync(config.statusPath, 'utf-8')) };
  } catch (error) {
    return {
      success: false,
      error: `Failed to read TLive status: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function postJson(
  url: string,
  token: string,
  body: Record<string, unknown>,
): Promise<TliveToolResponse> {
  if (!token) {
    return {
      success: false,
      error: 'Missing TLive token. Set TL_WEBHOOK_TOKEN or TL_TOKEN.',
    };
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const result = (await response.json().catch(() => ({}))) as TliveToolResponse;
    if (response.ok) return result;
    return {
      ...result,
      success: false,
      error: result.error || `TLive server returned HTTP ${response.status}.`,
    };
  } catch (error) {
    return {
      success: false,
      error: `Could not reach TLive server at ${url}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return '/webhook';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}
