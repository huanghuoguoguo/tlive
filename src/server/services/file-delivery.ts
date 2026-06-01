import { readFile, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import type { TliveMcpBridge } from '../mcp/bridge.js';
import { applyDeliveryRoute, type DeliveryRoute } from '../channels/delivery-route.js';
import type { MediaAttachment } from '../../shared/media/attachments.js';

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

const IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

export const DEFAULT_MAX_FILE_DELIVERY_BYTES = 20 * 1024 * 1024;

export interface FileDeliveryTargetInput {
  channelType?: string;
  chatId?: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  routeToken?: string;
}

export interface FileContentInput extends FileDeliveryTargetInput {
  fileName: string;
  mimeType?: string;
  base64Data: string;
  caption?: string;
}

export interface FilePathInput extends FileDeliveryTargetInput {
  filePath: string;
  caption?: string;
}

export interface FileUrlInput extends FileDeliveryTargetInput {
  url: string;
  fileName?: string;
  mimeType?: string;
  caption?: string;
}

export interface FileDeliveryResponse {
  success: boolean;
  error?: string;
  filename?: string;
}

interface ResolvedFileDeliveryTarget {
  route: DeliveryRoute;
  cwd?: string;
}

export interface FileDeliveryServiceOptions {
  bridge: TliveMcpBridge;
  defaultWorkdir: string;
  maxFileSizeBytes?: number;
}

export class FileDeliveryService {
  private readonly maxFileSizeBytes: number;

  constructor(private readonly options: FileDeliveryServiceOptions) {
    this.maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_DELIVERY_BYTES;
  }

  async sendPath(input: FilePathInput): Promise<FileDeliveryResponse> {
    const target = await this.resolveTarget(input);
    if ('error' in target) return { success: false, error: target.error };

    const cwd = await this.resolveCwd(target);
    const resolvedPath = resolve(cwd, input.filePath);

    let fileStat: Stats;
    try {
      fileStat = await stat(resolvedPath);
    } catch {
      return { success: false, error: `File not found: ${input.filePath}` };
    }

    if (!fileStat.isFile()) return { success: false, error: `Not a file: ${input.filePath}` };
    const sizeError = this.validateSize(fileStat.size);
    if (sizeError) return { success: false, error: sizeError };

    const buffer = await readFile(resolvedPath);
    const ext = extname(resolvedPath).toLowerCase();
    return this.sendBuffer({
      buffer,
      fileName: basename(resolvedPath),
      mimeType: MIME_MAP[ext] || 'application/octet-stream',
      caption: input.caption,
      route: target.route,
    });
  }

  async sendContent(input: FileContentInput): Promise<FileDeliveryResponse> {
    const target = await this.resolveTarget(input);
    if ('error' in target) return { success: false, error: target.error };

    let buffer: Buffer;
    try {
      buffer = Buffer.from(input.base64Data, 'base64');
    } catch {
      return { success: false, error: 'Invalid base64Data' };
    }

    if (!buffer.length) return { success: false, error: 'File is empty' };
    const sizeError = this.validateSize(buffer.length);
    if (sizeError) return { success: false, error: sizeError };

    return this.sendBuffer({
      buffer,
      fileName: input.fileName,
      mimeType: input.mimeType || guessMimeType(input.fileName),
      caption: input.caption,
      route: target.route,
    });
  }

  async sendUrl(input: FileUrlInput): Promise<FileDeliveryResponse> {
    const target = await this.resolveTarget(input);
    if ('error' in target) return { success: false, error: target.error };

    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      return { success: false, error: 'Invalid URL' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { success: false, error: 'Only http and https URLs are supported' };
    }

    const serverSideHint = serverSideUrlHint(parsed);
    let response: Response;
    try {
      response = await fetch(parsed);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: [
          `Failed to fetch URL from the TLive MCP server: ${detail}`,
          serverSideHint,
        ].filter(Boolean).join(' '),
      };
    }
    if (!response.ok) {
      return {
        success: false,
        error: [
          `Failed to fetch URL from the TLive MCP server: HTTP ${response.status}`,
          serverSideHint,
        ].filter(Boolean).join(' '),
      };
    }

    const contentLength = Number(response.headers.get('content-length') ?? '0');
    if (contentLength) {
      const sizeError = this.validateSize(contentLength);
      if (sizeError) return { success: false, error: sizeError };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const sizeError = this.validateSize(buffer.length);
    if (sizeError) return { success: false, error: sizeError };

    const fileName = input.fileName || basename(parsed.pathname) || 'download';
    const mimeType =
      input.mimeType || response.headers.get('content-type')?.split(';')[0] || guessMimeType(fileName);
    return this.sendBuffer({
      buffer,
      fileName,
      mimeType,
      caption: input.caption,
      route: target.route,
    });
  }

  private async sendBuffer(input: {
    buffer: Buffer;
    fileName: string;
    mimeType: string;
    caption?: string;
    route: DeliveryRoute;
  }): Promise<FileDeliveryResponse> {
    const adapter = this.options.bridge.getAdapter(input.route.channelType);
    if (!adapter) {
      return { success: false, error: `Channel '${input.route.channelType}' not available` };
    }

    const media: MediaAttachment = {
      type: isImage(input.fileName, input.mimeType) ? 'image' : 'file',
      buffer: input.buffer,
      filename: input.fileName,
      mimeType: input.mimeType,
    };

    try {
      const outMsg = applyDeliveryRoute(
        adapter.formatContent(input.route.chatId, input.caption || ''),
        input.route,
      );
      outMsg.media = media;
      const result = await adapter.send(outMsg);
      if (result.success) return { success: true, filename: input.fileName };
      return { success: false, error: 'Send failed' };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async resolveTarget(
    input: FileDeliveryTargetInput,
  ): Promise<ResolvedFileDeliveryTarget | { error: string }> {
    if (input.routeToken) {
      const target = this.options.bridge.resolveFileDeliveryToken?.(input.routeToken);
      if (!target) return { error: 'Invalid or expired routeToken' };
      return { route: target, cwd: target.cwd };
    }

    if (input.channelType && input.chatId) {
      return {
        route: {
          channelType: input.channelType,
          chatId: input.chatId,
          scopeId: input.chatId,
          replyToMessageId: input.replyToMessageId,
          replyInThread: input.replyInThread,
        },
      };
    }

    return {
      error:
        'Missing file delivery target. Include the current turn routeToken, or specify channelType and chatId explicitly.',
    };
  }

  private async resolveCwd(target: ResolvedFileDeliveryTarget): Promise<string> {
    if (target.cwd) return target.cwd;
    const binding = await this.options.bridge.getBinding(target.route.channelType, target.route.scopeId);
    return binding?.cwd || this.options.defaultWorkdir;
  }

  private validateSize(size: number): string | undefined {
    if (size <= 0) return 'File is empty';
    if (size <= this.maxFileSizeBytes) return undefined;
    const actual = Math.round(size / 1024 / 1024);
    const max = Math.round(this.maxFileSizeBytes / 1024 / 1024);
    return `File too large (${actual}MB). Maximum is ${max}MB.`;
  }
}

export function guessMimeType(fileName: string): string {
  return MIME_MAP[extname(fileName).toLowerCase()] || 'application/octet-stream';
}

function serverSideUrlHint(url: URL): string | undefined {
  const host = url.hostname.toLowerCase();
  if (!isLocalOrPrivateHost(host)) return undefined;
  return [
    'URL fetch happens in the TLive MCP server process.',
    'localhost, 127.0.0.1, and private IPs refer to the server network, not the execution client.',
    'For files generated on the client machine, use the file/base64 input or a URL reachable by the server.',
  ].join(' ');
}

function isLocalOrPrivateHost(host: string): boolean {
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  const parts = host.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

function isImage(fileName: string, mimeType: string): boolean {
  return IMAGE_MIME_TYPES.has(mimeType) || IMAGE_EXTENSIONS.has(extname(fileName).toLowerCase());
}
