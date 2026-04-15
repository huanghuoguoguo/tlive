/**
 * Push API — REST endpoint for pushing session context to mobile IM.
 *
 * Mounted on the webhook server at POST /api/push.
 * Called by Claude Code plugin command `/tlive:push`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AutomationBridge } from '../types/automation-bridge.js';

/** Request body for POST /api/push */
export interface PushRequest {
  /** Current working directory (from Claude Code session) */
  workdir: string;
  /** Project name (optional, derived from git repo or directory name) */
  projectName?: string;
  /** Custom message (optional) */
  message?: string;
}

export interface PushResponse {
  success: boolean;
  error?: string;
  /** Session ID for resuming on mobile */
  sessionId?: string;
  /** Channel that received the push */
  channelType?: string;
  /** Chat ID that received the push */
  chatId?: string;
  /** Whether fallback was used */
  fallback?: boolean;
}

export interface PushApiOptions {
  bridge: AutomationBridge;
  /** Push config: default channel and chat */
  pushConfig: { defaultChannel: string; defaultChat: string };
}

/**
 * Resolve push target: config default → ingress last chat → reject.
 */
export function resolvePushTarget(
  pushConfig: { defaultChannel: string; defaultChat: string },
  bridge: AutomationBridge,
): { channelType: string; chatId: string; fallback: boolean } | null {
  // Priority 1: Configured defaults
  if (pushConfig.defaultChannel && pushConfig.defaultChat) {
    return {
      channelType: pushConfig.defaultChannel,
      chatId: pushConfig.defaultChat,
      fallback: false,
    };
  }

  // Priority 2: Last active chat per enabled channel
  const adapters = bridge.getAdapters();
  for (const adapter of adapters) {
    const lastChat = bridge.getLastChatId(adapter.channelType);
    if (lastChat) {
      return {
        channelType: adapter.channelType,
        chatId: lastChat,
        fallback: true,
      };
    }
  }

  // No target available
  return null;
}

/**
 * Handle POST /api/push request.
 * Called from the webhook server after auth is validated.
 */
export async function handlePushRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: PushApiOptions,
): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Method not allowed' }));
    return;
  }

  // Read body
  let body = '';
  let bodySize = 0;
  const maxSize = 64 * 1024;

  await new Promise<void>((resolve, reject) => {
    req.on('data', (chunk) => {
      bodySize += chunk.length;
      if (bodySize > maxSize) {
        reject(new Error('Request body too large'));
        return;
      }
      body += chunk.toString();
    });
    req.on('end', resolve);
    req.on('error', reject);
  }).catch((err) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  });

  if (res.writableEnded) return;

  let request: PushRequest;
  try {
    request = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
    return;
  }

  // Validate
  if (!request.workdir) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Missing required field: workdir' }));
    return;
  }

  // Resolve target
  const target = resolvePushTarget(options.pushConfig, options.bridge);
  if (!target) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'no-push-target' }));
    return;
  }

  // Get adapter
  const adapter = options.bridge.getAdapter(target.channelType);
  if (!adapter) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: `Channel '${target.channelType}' not available` }));
    return;
  }

  // Send push notification
  try {
    const result = await options.bridge.pushToMobile({
      channelType: target.channelType,
      chatId: target.chatId,
      workdir: request.workdir,
      projectName: request.projectName,
      message: request.message,
    });

    if (result.success) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        sessionId: result.sessionId,
        channelType: target.channelType,
        chatId: target.chatId,
        fallback: target.fallback,
      }));
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: result.error }));
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }));
  }
}