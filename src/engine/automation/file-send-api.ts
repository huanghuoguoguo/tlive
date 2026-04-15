/**
 * File Send API — REST endpoint for sending files to IM channels.
 *
 * Mounted on the webhook server at POST /api/files/send.
 * Agent calls this via WebFetch to proactively send files to the user.
 */

import { readFile, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AutomationBridge } from '../types/automation-bridge.js';
import type { MediaAttachment } from '../../channels/media-types.js';

/** MIME type lookup by extension */
const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
};

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

/** Maximum file size: 20MB */
const MAX_FILE_SIZE = 20 * 1024 * 1024;

/** Request body for POST /api/files/send */
export interface FileSendRequest {
  /** Absolute or relative path to the file (resolved against session workdir) */
  file_path: string;
  /** Optional caption/description */
  caption?: string;
  /** Target channel type (optional — defaults to last active) */
  channelType?: string;
  /** Target chat ID (optional — defaults to last active) */
  chatId?: string;
}

export interface FileSendResponse {
  success: boolean;
  error?: string;
  filename?: string;
}

export interface FileSendApiOptions {
  bridge: AutomationBridge;
  /** Default working directory for resolving relative paths */
  defaultWorkdir: string;
}

/**
 * Core logic: read file and send as MediaAttachment.
 * Exported for testability.
 */
export async function sendFileToChat(
  filePath: string,
  caption: string | undefined,
  channelType: string,
  chatId: string,
  cwd: string,
  bridge: AutomationBridge,
): Promise<FileSendResponse> {
  const resolvedPath = resolve(cwd, filePath);

  // Validate file
  let fileStat: Stats;
  try {
    fileStat = await stat(resolvedPath);
  } catch {
    return { success: false, error: `File not found: ${filePath}` };
  }

  if (!fileStat.isFile()) {
    return { success: false, error: `Not a file: ${filePath}` };
  }
  if (fileStat.size > MAX_FILE_SIZE) {
    return { success: false, error: `File too large (${Math.round(fileStat.size / 1024 / 1024)}MB). Maximum is 20MB.` };
  }
  if (fileStat.size === 0) {
    return { success: false, error: 'File is empty' };
  }

  // Read and classify
  const buffer = await readFile(resolvedPath);
  const ext = extname(resolvedPath).toLowerCase();
  const filename = basename(resolvedPath);
  const mimeType = MIME_MAP[ext] || 'application/octet-stream';
  const isImage = IMAGE_EXTENSIONS.has(ext);

  const media: MediaAttachment = {
    type: isImage ? 'image' : 'file',
    buffer,
    filename,
    mimeType,
  };

  // Get adapter and send
  const adapter = bridge.getAdapter(channelType);
  if (!adapter) {
    return { success: false, error: `Channel '${channelType}' not available` };
  }

  try {
    const outMsg = adapter.formatContent(chatId, caption || '');
    (outMsg as any).media = media;
    const result = await adapter.send(outMsg);
    if (result.success) {
      return { success: true, filename };
    }
    return { success: false, error: 'Send failed' };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Handle POST /api/files/send request.
 * Called from the webhook server after auth is validated.
 */
export async function handleFileSendRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: FileSendApiOptions,
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

  let request: FileSendRequest;
  try {
    request = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
    return;
  }

  // Validate
  if (!request.file_path) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Missing required field: file_path' }));
    return;
  }

  // Resolve target chat
  let channelType = request.channelType;
  let chatId = request.chatId;

  if (!channelType || !chatId) {
    // Default to last active chat
    const adapters = options.bridge.getAdapters();
    for (const adapter of adapters) {
      const lastChat = options.bridge.getLastChatId(adapter.channelType);
      if (lastChat) {
        channelType = adapter.channelType;
        chatId = lastChat;
        break;
      }
    }
  }

  if (!channelType || !chatId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'No target chat available. Specify channelType and chatId, or start a conversation first.' }));
    return;
  }

  // Resolve workdir from binding
  const binding = await options.bridge.getBinding(channelType, chatId);
  const cwd = binding?.cwd || options.defaultWorkdir;

  const result = await sendFileToChat(request.file_path, request.caption, channelType, chatId, cwd, options.bridge);

  const status = result.success ? 200 : 400;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
}
