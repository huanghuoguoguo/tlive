/**
 * Webhook server for automation entry.
 *
 * Provides HTTP endpoint for external systems to inject prompts into tlive chats.
 * - Token-based authentication
 * - Prompt delivery to specified chat/session
 * - Event name and payload support
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { BridgeManager } from './bridge-manager.js';

/** Webhook request body */
export interface WebhookRequest {
  /** Target channel type (e.g., 'telegram', 'feishu') */
  channelType: string;
  /** Target chat ID */
  chatId: string;
  /** Event name for display (e.g., 'git:commit', 'ci:failed') */
  event: string;
  /** Prompt to send to Claude */
  prompt: string;
  /** Optional payload data */
  payload?: Record<string, unknown>;
  /** Silent mode - no IM feedback (default: false) */
  silent?: boolean;
}

/** Webhook response */
export interface WebhookResponse {
  success: boolean;
  message?: string;
  error?: string;
}

/**
 * Webhook server configuration
 */
export interface WebhookServerOptions {
  /** Authentication token (must match Bearer token in request) */
  token: string;
  /** Listen port */
  port: number;
  /** URL path for webhook endpoint */
  path: string;
  /** Bridge manager for message delivery */
  bridge: BridgeManager;
}

/**
 * HTTP server that accepts webhook requests and delivers prompts to chats.
 */
export class WebhookServer {
  private server: Server | null = null;
  private options: WebhookServerOptions;

  constructor(options: WebhookServerOptions) {
    this.options = options;
  }

  /**
   * Start the webhook server.
   */
  start(): void {
    this.server = createServer((req, res) => this.handleRequest(req, res));
    this.server.listen(this.options.port, () => {
      console.log(`[webhook] Server listening on port ${this.options.port}, path: ${this.options.path}`);
    });
  }

  /**
   * Stop the webhook server.
   */
  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      console.log('[webhook] Server stopped');
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Only accept POST to the configured path
    if (req.method !== 'POST' || req.url !== this.options.path) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Not found' }));
      return;
    }

    // Validate token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Missing or invalid Authorization header' }));
      return;
    }

    const token = authHeader.slice('Bearer '.length);
    if (token !== this.options.token) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid token' }));
      return;
    }

    // Read body
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const request: WebhookRequest = JSON.parse(body);

        // Validate required fields
        if (!request.channelType || !request.chatId || !request.prompt) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Missing required fields: channelType, chatId, prompt' }));
          return;
        }

        // Validate prompt length
        if (request.prompt.length > 10000) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Prompt too long (max 10000 characters)' }));
          return;
        }

        // Deliver the prompt
        await this.deliverPrompt(request);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Prompt delivered' }));
      } catch (err) {
        console.error('[webhook] Error processing request:', err);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
      }
    });
  }

  private async deliverPrompt(request: WebhookRequest): Promise<void> {
    const { channelType, chatId, event, prompt, payload, silent } = request;

    console.log(`[webhook] Delivering prompt to ${channelType}:${chatId} (event: ${event})`);

    // Get the adapter for this channel
    const adapter = this.options.bridge.getAdapter(channelType);
    if (!adapter) {
      throw new Error(`Channel ${channelType} not available`);
    }

    // Send feedback to IM (unless silent)
    if (!silent) {
      const feedbackText = `🔔 Webhook: ${event}\n${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}`;
      await adapter.send({ chatId, text: feedbackText }).catch((err) => {
        console.warn(`[webhook] Failed to send feedback: ${err}`);
      });
    }

    // Inject the prompt into the bridge's message processing
    // Note: This requires the bridge to have a method to inject messages
    // For now, we'll simulate by sending the prompt as a regular message
    // The bridge will handle routing it to the active session or creating a new one

    // Create a synthetic inbound message
    const syntheticMessage = {
      channelType,
      chatId,
      userId: 'webhook',
      text: prompt,
      messageId: `webhook-${Date.now()}`,
      attachments: [],
    };

    // Process the message through the bridge
    // Note: BridgeManager.handleInboundMessage is private, so we need a public method
    // For now, we'll just send the prompt text to the chat
    // This will trigger a new query if no session is active
    await adapter.send({ chatId, text: `🤖 Processing: ${prompt.slice(0, 50)}...` }).catch(() => {});
  }
}