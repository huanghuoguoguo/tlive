import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  injectPrompt,
  loadMcpConfig,
  readStatus,
  sendFile,
  type TliveToolResponse,
} from '../../mcp/client.js';

describe('TLive MCP client', () => {
  const servers: Array<{ close: () => void }> = [];

  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  it('derives local bridge URLs and token from environment', () => {
    const config = loadMcpConfig({
      TLIVE_HOME: '/tmp/tlive-home',
      TL_WEBHOOK_PORT: '9999',
      TL_WEBHOOK_TOKEN: 'token-a',
      TL_WEBHOOK_PATH: 'hook',
    });

    expect(config.fileSendUrl).toBe('http://127.0.0.1:9999/api/files/send');
    expect(config.webhookUrl).toBe('http://127.0.0.1:9999/hook');
    expect(config.token).toBe('token-a');
    expect(config.statusPath).toBe('/tmp/tlive-home/runtime/status.json');
  });

  it('posts file sends with bearer auth', async () => {
    const received = await withJsonServer(async (url) => {
      const result = await sendFile(
        { file_path: 'out.png', caption: 'done', routeToken: 'route-1' },
        {
          fileSendUrl: url,
          webhookUrl: `${url}/unused`,
          token: 'secret',
          statusPath: '/missing',
        },
      );
      expect(result).toMatchObject({ success: true, filename: 'out.png' });
    });

    expect(received).toMatchObject({
      authorization: 'Bearer secret',
      body: { file_path: 'out.png', caption: 'done', routeToken: 'route-1' },
    });
  });

  it('posts automation prompts through the webhook URL', async () => {
    const received = await withJsonServer(async (url) => {
      const result = await injectPrompt(
        { event: 'agent:callback', prompt: 'continue', channelType: 'feishu', chatId: 'chat-1' },
        {
          fileSendUrl: `${url}/unused`,
          webhookUrl: url,
          token: 'secret',
          statusPath: '/missing',
        },
      );
      expect(result).toMatchObject({ success: true });
    });

    expect(received.body).toMatchObject({
      event: 'agent:callback',
      prompt: 'continue',
      channelType: 'feishu',
      chatId: 'chat-1',
    });
  });

  it('returns actionable errors without token or status file', async () => {
    await expect(sendFile({ file_path: 'out.txt' }, missingTokenConfig())).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('Missing TLive token'),
    });
    expect(readStatus(missingTokenConfig())).toMatchObject({
      success: false,
      error: expect.stringContaining('Start the bridge'),
    });
  });

  async function withJsonServer(
    run: (url: string) => Promise<void>,
  ): Promise<{ authorization?: string; body?: TliveToolResponse }> {
    let received: { authorization?: string; body?: TliveToolResponse } = {};
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      received = {
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf-8')),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, filename: received.body?.file_path }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    await run(`http://127.0.0.1:${address.port}`);
    return received;
  }
});

function missingTokenConfig() {
  return {
    fileSendUrl: 'http://127.0.0.1:1/api/files/send',
    webhookUrl: 'http://127.0.0.1:1/webhook',
    token: '',
    statusPath: '/missing/tlive/status.json',
  };
}
