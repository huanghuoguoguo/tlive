export const FILE_SEND_URL_ENV = 'TLIVE_FILE_SEND_URL';
export const FILE_SEND_TOKEN_ENV = 'TLIVE_FILE_SEND_TOKEN';

export interface FileSendPromptConfig {
  enabled: boolean;
  port: number;
  token: string;
}

export function configureFileSendEnvironment(config: FileSendPromptConfig): void {
  if (!config.enabled || !config.token) {
    delete process.env[FILE_SEND_URL_ENV];
    delete process.env[FILE_SEND_TOKEN_ENV];
    return;
  }

  process.env[FILE_SEND_URL_ENV] = `http://127.0.0.1:${config.port}/api/files/send`;
  process.env[FILE_SEND_TOKEN_ENV] = config.token;
}

export function buildFileSendSystemPrompt(config: FileSendPromptConfig): string | undefined {
  if (!config.enabled || !config.token) return undefined;

  return [
    'TLive file delivery through /api/files/send:',
    '- When the user asks you to send, return, or share a local file back to the IM chat, use the local TLive file-send endpoint instead of saying you cannot send files.',
    `- Endpoint and auth are available in the ${FILE_SEND_URL_ENV} and ${FILE_SEND_TOKEN_ENV} environment variables.`,
    '- Use Bash/curl with POST JSON: {"file_path":"/absolute/or/relative/path","caption":"optional text","routeToken":"token-from-current-turn"}.',
    '- If the current prompt includes a TLive file delivery routeToken, you must include it in the POST JSON.',
    '- If no routeToken is available, specify channelType and chatId explicitly. TLive rejects ambiguous file-send requests instead of guessing a last active chat.',
    '- After a {"success":true} response, briefly tell the user the file was sent. If it fails, report the error.',
    '- Never print or reveal the auth token value.',
  ].join('\n');
}

export function buildFileSendRoutePrompt(routeToken: string | undefined): string {
  if (!routeToken) return '';
  return [
    '',
    '[TLive file delivery route]',
    `When using /api/files/send for this turn, include "routeToken":"${routeToken}" in the JSON body.`,
    'Do not print or reveal this routeToken.',
    '[/TLive file delivery route]',
  ].join('\n');
}
