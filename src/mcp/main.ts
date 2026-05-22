import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import {
  injectPrompt,
  loadMcpConfig,
  readStatus,
  sendFile,
  type TliveToolResponse,
} from './client.js';

const server = new McpServer({
  name: 'tlive',
  version: process.env.npm_package_version || '0.0.0',
});

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

const fileOutputSchema = {
  success: z.boolean(),
  error: z.string().optional(),
  filename: z.string().optional(),
};

server.registerTool(
  'tlive_send_file',
  {
    title: 'Send File to TLive Chat',
    description:
      'Send a local file back to the current TLive IM chat/topic through the TLive bridge. Prefer routeToken for turn-scoped delivery.',
    inputSchema: {
      file_path: z.string().min(1).describe('Absolute path or path relative to the active TLive cwd.'),
      caption: z.string().optional().describe('Optional text shown with the file.'),
      ...deliveryTargetSchema,
    },
    outputSchema: fileOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (input) => toolResult(await sendFile(input)),
);

server.registerTool(
  'tlive_send_image',
  {
    title: 'Send Image to TLive Chat',
    description:
      'Send a local image file back to the current TLive IM chat/topic. This uses the same route handling as tlive_send_file.',
    inputSchema: {
      file_path: z
        .string()
        .min(1)
        .describe('Path to a local image file such as png, jpg, jpeg, gif, webp, or svg.'),
      caption: z.string().optional().describe('Optional text shown with the image.'),
      ...deliveryTargetSchema,
    },
    outputSchema: fileOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (input) => toolResult(await sendFile(input)),
);

server.registerTool(
  'tlive_inject_prompt',
  {
    title: 'Inject Prompt into TLive',
    description:
      'Send an automation prompt into a TLive chat through the bridge webhook. Use for explicit callback workflows, not for normal chat replies.',
    inputSchema: {
      event: z.string().min(1).describe('Short event name, for example agent:callback.'),
      prompt: z.string().min(1).describe('Prompt text to inject into the target chat/session.'),
      payload: z.record(z.string(), z.unknown()).optional().describe('Optional template payload.'),
      channelType: z.string().optional().describe('Explicit channel type, for example feishu.'),
      chatId: z.string().optional().describe('Explicit target chat ID.'),
      projectName: z.string().optional().describe('Project name configured in TLive routing.'),
      sessionId: z.string().optional().describe('Optional existing session ID to target.'),
      silent: z.boolean().optional().describe('Suppress IM feedback when supported.'),
    },
    outputSchema: {
      success: z.boolean(),
      error: z.string().optional(),
      message: z.string().optional(),
      sessionId: z.string().optional(),
      requestId: z.string().optional(),
      route: z.unknown().optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (input) => toolResult(await injectPrompt(input)),
);

server.registerTool(
  'tlive_status',
  {
    title: 'Read TLive Status',
    description: 'Read the local TLive runtime status file to check whether the bridge is running.',
    inputSchema: {},
    outputSchema: {
      success: z.boolean(),
      error: z.string().optional(),
      status: z.unknown().optional(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => toolResult(readStatus()),
);

function toolResult(result: TliveToolResponse) {
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

async function main(): Promise<void> {
  const config = loadMcpConfig();
  if (!config.token) {
    console.error(
      '[tlive:mcp] Missing token. Set TL_WEBHOOK_TOKEN or TL_TOKEN.',
    );
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[tlive:mcp] MCP server running on stdio.');
}

main().catch((error) => {
  console.error('[tlive:mcp] Server error:', error);
  process.exit(1);
});
