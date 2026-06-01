import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod/v4';
import type { TliveMcpBridge } from './bridge.js';
import { FileDeliveryService } from '../services/file-delivery.js';

const TLIVE_MCP_TOOLS = [
  'tlive_send_file',
  'tlive_send_image',
  'tlive_status',
] as const;

export interface TliveHttpMcpOptions {
  bridge: TliveMcpBridge;
  defaultWorkdir: string;
  maxFileSizeBytes?: number;
}

const deliveryTargetSchema = {
  routeToken: z
    .string()
    .optional()
    .describe('Per-turn TLive route token. Prefer this when the current prompt provides one.'),
  channelType: z
    .string()
    .optional()
    .describe('Explicit channel type, for example feishu. Use only when no routeToken is available.'),
  chatId: z
    .string()
    .optional()
    .describe('Explicit chat ID. Use only with channelType when no routeToken is available.'),
  replyToMessageId: z.string().optional().describe('Optional platform message ID to reply to.'),
  replyInThread: z.boolean().optional().describe('Send as a topic/thread reply when supported.'),
};

const fileDataSchema = z
  .object({
    fileName: z.string().min(1).describe('Original filename, for example report.pdf.'),
    mimeType: z.string().optional().describe('MIME type, for example application/pdf.'),
    base64: z.string().min(1).describe('Base64-encoded file content.'),
    size: z.number().optional().describe('Decoded file size in bytes, when known.'),
  })
  .describe('File content to send.')
  .meta({ format: 'file' });

export async function handleTliveHttpMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: TliveHttpMcpOptions,
): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      }),
    );
    return;
  }

  const server = createTliveMcpServer(options);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
  } catch (error) {
    console.warn(`[mcp] request failed: ${error instanceof Error ? error.message : String(error)}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        }),
      );
    }
  }
}

function createTliveMcpServer(options: TliveHttpMcpOptions): McpServer {
  const server = new McpServer({
    name: 'tlive',
    version: process.env.npm_package_version || '0.0.0',
  });
  const files = new FileDeliveryService(options);

  server.registerTool(
    'tlive_send_file',
    {
      title: 'Send File to TLive Chat',
      description:
        'Send a file back to the current TLive IM chat/topic. Prefer the file object input with base64 content. The url input is fetched by the TLive MCP server process, so localhost/private URLs must be reachable from the server, not just from the execution client.',
      inputSchema: {
        file: fileDataSchema.optional(),
        url: z
          .string()
          .url()
          .optional()
          .describe('HTTP(S) URL fetched by the TLive MCP server process, not the client.'),
        fileName: z.string().optional().describe('Filename override for URL input.'),
        mimeType: z.string().optional().describe('MIME type override for URL input.'),
        caption: z.string().optional().describe('Optional text shown with the file.'),
        ...deliveryTargetSchema,
      },
      outputSchema: {
        success: z.boolean(),
        error: z.string().optional(),
        filename: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const result = input.file
        ? await files.sendContent({
            routeToken: input.routeToken,
            channelType: input.channelType,
            chatId: input.chatId,
            replyToMessageId: input.replyToMessageId,
            replyInThread: input.replyInThread,
            fileName: input.file.fileName,
            mimeType: input.file.mimeType,
            base64Data: input.file.base64,
            caption: input.caption,
          })
        : input.url
          ? await files.sendUrl({
              routeToken: input.routeToken,
              channelType: input.channelType,
              chatId: input.chatId,
              replyToMessageId: input.replyToMessageId,
              replyInThread: input.replyInThread,
              url: input.url,
              fileName: input.fileName,
              mimeType: input.mimeType,
              caption: input.caption,
            })
          : { success: false, error: 'Provide either file or url.' };
      return toolResult({ ...result });
    },
  );

  server.registerTool(
    'tlive_send_image',
    {
      title: 'Send Image to TLive Chat',
      description:
        'Send an image back to the current TLive IM chat/topic. Prefer the file object input with base64 image content. The url input is fetched by the TLive MCP server process, so localhost/private URLs must be reachable from the server, not just from the execution client.',
      inputSchema: {
        file: fileDataSchema.optional(),
        url: z
          .string()
          .url()
          .optional()
          .describe('HTTP(S) URL fetched by the TLive MCP server process, not the client.'),
        fileName: z.string().optional().describe('Filename override for URL input.'),
        mimeType: z.string().optional().describe('MIME type override for URL input.'),
        caption: z.string().optional().describe('Optional text shown with the image.'),
        ...deliveryTargetSchema,
      },
      outputSchema: {
        success: z.boolean(),
        error: z.string().optional(),
        filename: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const result = input.file
        ? await files.sendContent({
            routeToken: input.routeToken,
            channelType: input.channelType,
            chatId: input.chatId,
            replyToMessageId: input.replyToMessageId,
            replyInThread: input.replyInThread,
            fileName: input.file.fileName,
            mimeType: input.file.mimeType,
            base64Data: input.file.base64,
            caption: input.caption,
          })
        : input.url
          ? await files.sendUrl({
              routeToken: input.routeToken,
              channelType: input.channelType,
              chatId: input.chatId,
              replyToMessageId: input.replyToMessageId,
              replyInThread: input.replyInThread,
              url: input.url,
              fileName: input.fileName,
              mimeType: input.mimeType,
              caption: input.caption,
            })
          : { success: false, error: 'Provide either file or url.' };
      return toolResult({ ...result });
    },
  );

  server.registerTool(
    'tlive_status',
    {
      title: 'Read TLive Status',
      description: 'Check whether the TLive MCP endpoint is reachable.',
      inputSchema: {},
      outputSchema: {
        success: z.boolean(),
        tools: z.array(z.string()).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => toolResult({ success: true, tools: [...TLIVE_MCP_TOOLS] }),
  );

  return server;
}

function toolResult(result: Record<string, unknown> & { success?: boolean }) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(result, null, 2),
      },
    ],
    structuredContent: result,
    isError: result.success === false,
  };
}
