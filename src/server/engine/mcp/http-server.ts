import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleTliveHttpMcpRequest } from './tlive-http-mcp.js';
import type { TliveMcpBridge } from './bridge.js';

export interface TliveMcpHttpServerOptions {
  token: string;
  port: number;
  path: string;
  bridge: TliveMcpBridge;
  defaultWorkdir: string;
  maxFileSizeBytes?: number;
}

export class TliveMcpHttpServer {
  private server: Server | null = null;

  constructor(private readonly options: TliveMcpHttpServerOptions) {}

  start(): void {
    if (this.server) return;
    this.server = createServer((req, res) => this.handleRequest(req, res));
    this.server.listen(this.options.port, () => {
      console.log(`[mcp] Server listening on port ${this.options.port}, path: ${this.options.path}`);
    });
  }

  stop(): void {
    if (!this.server) return;
    this.server.close();
    this.server = null;
    console.log('[mcp] Server stopped');
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = safePathname(req.url ?? '/');
    if (pathname !== this.options.path) {
      writeJson(res, 404, { success: false, error: 'Not found' });
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      writeJson(res, 401, { success: false, error: 'Missing or invalid Authorization header' });
      return;
    }

    const token = authHeader.slice('Bearer '.length);
    if (token !== this.options.token) {
      writeJson(res, 403, { success: false, error: 'Invalid token' });
      return;
    }

    await handleTliveHttpMcpRequest(req, res, {
      bridge: this.options.bridge,
      defaultWorkdir: this.options.defaultWorkdir,
      maxFileSizeBytes: this.options.maxFileSizeBytes,
    });
  }
}

function safePathname(url: string): string {
  try {
    return new URL(url, 'http://localhost').pathname;
  } catch {
    return url;
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
