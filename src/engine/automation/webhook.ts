/**
 * Webhook server for automation entry.
 *
 * Provides HTTP endpoint for external systems to inject prompts into tlive chats.
 * - Token-based authentication
 * - Prompt delivery to specified chat/session
 * - Event name and payload support
 * - Payload template variable injection (Phase 2)
 * - Session routing strategies: reject/create (Phase 2)
 * - Enhanced error observability (Phase 2)
 * - Project-based routing (Phase 3)
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AutomationBridge } from '../types/automation-bridge.js';
import type { CronScheduler } from './cron.js';
import type { ProjectConfig } from '../../store/interface.js';
import { generateRequestId, Logger } from '../../logger.js';
import { isCronApiRequest, handleCronApiRequest } from './cron-api.js';
import { handleFileSendRequest } from './file-send-api.js';

/** Webhook request body */
export interface WebhookRequest {
  /** Target channel type (e.g., 'telegram', 'feishu') */
  channelType?: string;
  /** Target chat ID */
  chatId?: string;
  /** Target project name for project-based routing (Phase 3) */
  projectName?: string;
  /** Event name for display (e.g., 'git:commit', 'ci:failed') */
  event: string;
  /** Prompt to send to Claude - supports {key} template variables from payload */
  prompt: string;
  /** Optional payload data for template injection */
  payload?: Record<string, unknown>;
  /** Silent mode - no IM feedback (default: false) */
  silent?: boolean;
  /** Optional sessionId to target specific session */
  sessionId?: string;
}

/** Webhook response */
export interface WebhookResponse {
  success: boolean;
  message?: string;
  error?: string;
  /** Session ID that received the prompt (if successful) */
  sessionId?: string;
  /** Request ID for log correlation */
  requestId?: string;
  /** Resolved route information */
  route?: { channelType: string; chatId: string; workdir?: string };
}

/** Webhook callback notification payload */
export interface WebhookCallbackPayload {
  /** Original request ID */
  requestId: string;
  /** Whether the prompt was delivered successfully */
  success: boolean;
  /** Event name from original request */
  event: string;
  /** Channel type */
  channelType: string;
  /** Chat ID */
  chatId: string;
  /** Session ID (if available) */
  sessionId?: string;
  /** Error message (if failed) */
  error?: string;
  /** Timestamp */
  timestamp: string;
}

interface ResolvedWebhookRoute {
  channelType: string;
  chatId: string;
  workdir?: string;
  projectName?: string;
  claudeSettingSources?: ProjectConfig['claudeSettingSources'];
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
  /** Bridge for message delivery */
  bridge: AutomationBridge;
  /** Session routing strategy: 'reject' (return error) or 'create' (auto-create session) */
  sessionStrategy: 'reject' | 'create';
  /** Optional callback URL for result notifications */
  callbackUrl?: string;
  /** Maximum requests per minute from the same source (0 disables) */
  rateLimitPerMinute?: number;
  /** Project configurations for project-based routing (Phase 3) */
  projects?: ProjectConfig[];
  /** Default project name (used when no target specified) */
  defaultProject?: string;
  /** Default working directory for file path resolution */
  defaultWorkdir?: string;
  /** Cron scheduler for API requests (optional) */
  cronScheduler?: CronScheduler | null;
}

/**
 * Inject payload values into prompt template.
 * Supports {key} format where key matches payload field names.
 *
 * Example:
 *   prompt: "Review commit {commit} on branch {branch}"
 *   payload: { commit: "abc123", branch: "main" }
 *   result: "Review commit abc123 on branch main"
 */
export function injectPayload(prompt: string, payload?: Record<string, unknown>): string {
  if (!payload) return prompt;

  return prompt.replace(/\{(\w+)\}/g, (match, key) => {
    if (key in payload) {
      const value = payload[key];
      // Handle different value types
      if (value === null || value === undefined) {
        return match; // Keep original placeholder if value is null/undefined
      }
      if (typeof value === 'object') {
        return JSON.stringify(value);
      }
      return String(value);
    }
    return match; // Keep original placeholder if key not found
  });
}

/**
 * Send callback notification to external URL.
 */
async function sendCallback(callbackUrl: string, payload: WebhookCallbackPayload): Promise<void> {
  try {
    const body = JSON.stringify(payload);
    const url = new URL(callbackUrl);

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body,
    });

    if (!response.ok) {
      console.warn(`[webhook] Callback failed: ${response.status} ${response.statusText}`);
    } else {
      console.log(`[webhook] Callback sent successfully to ${callbackUrl}`);
    }
  } catch (err) {
    console.warn(`[webhook] Callback error: ${Logger.formatError(err)}`);
  }
}

/**
 * HTTP server that accepts webhook requests and delivers prompts to chats.
 */
export class WebhookServer {
  private server: Server | null = null;
  private options: WebhookServerOptions;
  private recentRequestsBySource = new Map<string, number[]>();

  constructor(options: WebhookServerOptions) {
    this.options = options;
  }

  /** Get default workdir for file path resolution */
  private getDefaultWorkdir(): string {
    return this.options.defaultWorkdir || process.cwd();
  }

  private allowRequestForSource(sourceKey: string, now = Date.now()): boolean {
    const limit = this.options.rateLimitPerMinute ?? 0;
    if (limit <= 0) {
      return true;
    }

    const windowStart = now - 60_000;
    const recent = (this.recentRequestsBySource.get(sourceKey) ?? []).filter(timestamp => timestamp > windowStart);
    if (recent.length === 0) {
      this.recentRequestsBySource.delete(sourceKey);
    }
    if (recent.length >= limit) {
      this.recentRequestsBySource.set(sourceKey, recent);
      return false;
    }

    recent.push(now);
    this.recentRequestsBySource.set(sourceKey, recent);
    return true;
  }

  /**
   * Start the webhook server.
   */
  start(): void {
    this.server = createServer((req, res) => this.handleRequest(req, res));
    this.server.listen(this.options.port, () => {
      console.log(`[webhook] Server listening on port ${this.options.port}, path: ${this.options.path}, strategy: ${this.options.sessionStrategy}`);
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
    const requestId = generateRequestId();
    const url = req.url ?? '/';

    // Validate token for all requests
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      console.warn(`[webhook] ${requestId} 401 Missing or invalid Authorization header`);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Missing or invalid Authorization header', requestId }));
      return;
    }

    const token = authHeader.slice('Bearer '.length);
    if (token !== this.options.token) {
      console.warn(`[webhook] ${requestId} 403 Invalid token`);
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid token', requestId }));
      return;
    }

    // Route cron API requests
    if (isCronApiRequest(url)) {
      const scheduler = this.options.cronScheduler;
      await handleCronApiRequest(req, res, scheduler);
      return;
    }

    // Route: /api/files/send
    if (url === '/api/files/send') {
      await handleFileSendRequest(req, res, {
        bridge: this.options.bridge,
        defaultWorkdir: this.getDefaultWorkdir(),
      });
      return;
    }

    // Only accept POST to the configured webhook path
    if (req.method !== 'POST' || url !== this.options.path) {
      console.log(`[webhook] ${requestId} 404 Not found: ${req.method} ${url}`);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Not found', requestId }));
      return;
    }

    const sourceKey = req.socket.remoteAddress || 'unknown';
    if (!this.allowRequestForSource(sourceKey)) {
      console.warn(`[webhook] ${requestId} 429 Rate limit exceeded for ${sourceKey}`);
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
      res.end(JSON.stringify({ success: false, error: 'Rate limit exceeded', requestId }));
      return;
    }

    // Read body with size limit
    let body = '';
    let bodySize = 0;
    const maxSize = 64 * 1024; // 64KB limit
    let bodyTooLarge = false;

    req.on('data', (chunk) => {
      if (bodyTooLarge) return; // Already rejected, stop reading
      bodySize += chunk.length;
      if (bodySize > maxSize) {
        bodyTooLarge = true;
        console.warn(`[webhook] ${requestId} 400 Body too large (${bodySize} bytes)`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Request body too large (max 64KB)', requestId }));
        return;
      }
      body += chunk.toString();
    });

    req.on('end', async () => {
      if (bodyTooLarge) return; // Already responded

      try {
        const request: WebhookRequest = JSON.parse(body);

        // Validate required fields
        const validationError = this.validateRequest(request);
        if (validationError) {
          console.warn(`[webhook] ${requestId} 400 Validation failed: ${validationError}`);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: validationError, requestId }));
          return;
        }

        // Route the request to target chat
        const routeResult = await this.resolveRoute(request);
        if (!routeResult) {
          const errorMsg = 'No valid target: specify channelType+chatId, projectName, or configure defaultProject';
          console.warn(`[webhook] ${requestId} ROUTE_FAILED: ${errorMsg}`);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: errorMsg, requestId }));
          return;
        }

        // Inject payload into prompt
        const injectedPrompt = injectPayload(request.prompt, request.payload);
        console.log(`[webhook] ${requestId} INJECT event=${request.event} prompt="${injectedPrompt.slice(0, 50)}${injectedPrompt.length > 50 ? '...' : ''}"`);

        // Deliver the prompt with resolved route
        const result = await this.deliverPrompt(request, routeResult, injectedPrompt, requestId);

        if (result.success) {
          console.log(`[webhook] ${requestId} SUCCESS sessionId=${result.sessionId?.slice(-4) || '?'}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            message: 'Prompt delivered',
            sessionId: result.sessionId,
            requestId,
            route: routeResult,
          }));
        } else {
          console.warn(`[webhook] ${requestId} FAILED: ${result.error}`);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: result.error,
            requestId,
          }));
        }

        // Send callback notification if configured
        if (this.options.callbackUrl) {
          await sendCallback(this.options.callbackUrl, {
            requestId,
            success: result.success,
            event: request.event,
            channelType: routeResult.channelType,
            chatId: routeResult.chatId,
            sessionId: result.sessionId,
            error: result.error,
            timestamp: new Date().toISOString(),
          });
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[webhook] ${requestId} ERROR: ${errorMessage}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body', requestId }));

        // Send error callback
        if (this.options.callbackUrl) {
          await sendCallback(this.options.callbackUrl, {
            requestId,
            success: false,
            event: 'unknown',
            channelType: 'unknown',
            chatId: 'unknown',
            error: errorMessage,
            timestamp: new Date().toISOString(),
          });
        }
      }
    });
  }

  private validateRequest(request: WebhookRequest): string | null {
    // Need prompt and event
    if (!request.prompt) {
      return 'Missing required field: prompt';
    }
    if (!request.event) {
      return 'Missing required field: event';
    }
    if (request.prompt.length > 10000) {
      return 'Prompt too long (max 10000 characters)';
    }
    if (request.payload) {
      // Validate payload size
      const payloadStr = JSON.stringify(request.payload);
      if (payloadStr.length > 4096) {
        return 'Payload too large (max 4096 characters)';
      }
      // Validate payload field count
      const fieldCount = Object.keys(request.payload).length;
      if (fieldCount > 20) {
        return 'Payload has too many fields (max 20)';
      }
    }
    // Routing validation happens in resolveRoute
    return null;
  }

  /**
   * Resolve routing target based on request fields.
   * Priority:
   * 1. Explicit channelType + chatId
   * 2. Explicit projectName (use project's webhookDefaultChat or last active chat)
   * 3. Default project's webhookDefaultChat
   */
  private async resolveRoute(request: WebhookRequest): Promise<ResolvedWebhookRoute | null> {
    if (request.sessionId) {
      const binding = await this.options.bridge.getBindingBySessionId(request.sessionId);
      if (!binding) {
        console.warn(`[webhook] Session '${request.sessionId}' not found`);
        return null;
      }

      return {
        channelType: binding.channelType,
        chatId: binding.chatId,
        workdir: binding.cwd,
        projectName: binding.projectName,
        claudeSettingSources: binding.claudeSettingSources,
      };
    }

    // Priority 1: Explicit channelType + chatId
    if (request.channelType && request.chatId) {
      const binding = await this.options.bridge.getBinding(request.channelType, request.chatId);
      return {
        channelType: request.channelType,
        chatId: request.chatId,
        workdir: binding?.cwd,
        projectName: binding?.projectName,
        claudeSettingSources: binding?.claudeSettingSources,
      };
    }

    // Priority 2: Explicit projectName
    if (request.projectName) {
      const project = this.options.projects?.find(p => p.name === request.projectName);
      if (!project) {
        console.warn(`[webhook] Project '${request.projectName}' not found`);
        return null;
      }

      // Use project's configured webhook default chat
      if (project.webhookDefaultChat) {
        return {
          channelType: project.webhookDefaultChat.channelType,
          chatId: project.webhookDefaultChat.chatId,
          workdir: project.workdir,
          projectName: project.name,
          claudeSettingSources: project.claudeSettingSources,
        };
      }

      // Fallback: find last active chat for project's enabled channels
      const enabledChannels = project.channels || this.options.bridge.getAdapters().map(a => a.channelType);
      for (const channelType of enabledChannels) {
        const lastChatId = this.options.bridge.getLastChatId(channelType);
        if (lastChatId) {
          console.log(`[webhook] Project '${request.projectName}' using last active chat: ${channelType}:${lastChatId.slice(-8)}`);
          return {
            channelType,
            chatId: lastChatId,
            workdir: project.workdir,
            projectName: project.name,
            claudeSettingSources: project.claudeSettingSources,
          };
        }
      }

      console.warn(`[webhook] Project '${request.projectName}' has no webhookDefaultChat and no recent chats`);
      return null;
    }

    // Priority 3: Default project
    if (this.options.defaultProject && this.options.projects) {
      const defaultProject = this.options.projects.find(p => p.name === this.options.defaultProject);
      if (defaultProject?.webhookDefaultChat) {
        return {
          channelType: defaultProject.webhookDefaultChat.channelType,
          chatId: defaultProject.webhookDefaultChat.chatId,
          workdir: defaultProject.workdir,
          projectName: defaultProject.name,
          claudeSettingSources: defaultProject.claudeSettingSources,
        };
      }
    }

    // No valid route found
    return null;
  }

  private async deliverPrompt(
    request: WebhookRequest,
    route: ResolvedWebhookRoute,
    injectedPrompt: string,
    requestId: string,
  ): Promise<{ success: boolean; sessionId?: string; error?: string }> {
    const { event, silent } = request;
    const { channelType, chatId, workdir, projectName, claudeSettingSources } = route;

    // Get the adapter for this channel
    const adapter = this.options.bridge.getAdapter(channelType);
    if (!adapter) {
      const enabledChannels = this.options.bridge.getAdapters().map(a => a.channelType).join(', ') || 'none';
      return {
        success: false,
        error: `Channel '${channelType}' not available. Enabled channels: ${enabledChannels}`,
      };
    }

    // Check session routing strategy
    if (this.options.sessionStrategy === 'reject') {
      const existingBinding = request.sessionId
        ? await this.options.bridge.getBindingBySessionId(request.sessionId)
        : await this.options.bridge.getBinding(channelType, chatId);
      const hasActiveSession = existingBinding
        ? this.options.bridge.hasActiveSession(channelType, chatId, existingBinding.cwd ?? workdir)
        : false;
      if (!existingBinding || !hasActiveSession) {
        return {
          success: false,
          error: `No active session for ${channelType}:${chatId}. Start a conversation in IM first, or set webhook.sessionStrategy='create'.`,
        };
      }
    }

    // Send feedback to IM (unless silent)
    if (!silent) {
      const projectHint = request.projectName ? ` [${request.projectName}]` : '';
      const payloadPreview = request.payload
        ? `\n📦 Payload: ${JSON.stringify(request.payload).slice(0, 100)}`
        : '';
      const feedbackText = `🔔 Webhook${projectHint}: ${event}${payloadPreview}\n\n📝 ${injectedPrompt.slice(0, 200)}${injectedPrompt.length > 200 ? '...' : ''}`;
      await adapter.send({ chatId, text: feedbackText }).catch((err) => {
        console.warn(`[webhook] ${requestId} Failed to send feedback: ${Logger.formatError(err)}`);
      });
    }

    try {
      const result = await this.options.bridge.injectAutomationPrompt({
        channelType,
        chatId,
        text: injectedPrompt,
        requestId,
        messageId: `webhook-${requestId}`,
        userId: 'webhook',
        workdir,
        projectName,
        claudeSettingSources,
      });

      return {
        success: true,
        sessionId: result.sessionId,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: `Failed to deliver prompt: ${errorMessage}`,
      };
    }
  }
}
