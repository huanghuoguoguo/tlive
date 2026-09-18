import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

export interface CodexAppServerNotification {
  method: string;
  params?: Record<string, unknown>;
}

export interface CodexAppServerClientOptions {
  codexPath?: string;
  workingDirectory: string;
  onNotification: (notification: CodexAppServerNotification) => void;
  onExit: (error: Error) => void;
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

/** Minimal JSONL client for Codex app-server's stable thread/turn protocol. */
export class CodexAppServerClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private lines: ReadlineInterface | null = null;
  private initialization: Promise<void> | null = null;
  private nextRequestId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private stderr = '';
  private closed = false;

  constructor(private readonly options: CodexAppServerClientOptions) {}

  async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed) throw new Error('Codex app-server client is closed');
    await this.ensureInitialized();
    return this.sendRequest(method, params);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lines?.close();
    this.lines = null;
    const error = new Error('Codex app-server client closed');
    this.rejectPending(error);
    this.process?.kill();
    this.process = null;
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initialization) this.initialization = this.initialize();
    return this.initialization;
  }

  private async initialize(): Promise<void> {
    const command = resolveCodexCommand(this.options.codexPath);
    const child = spawn(command.executable, [...command.prefixArgs, 'app-server'], {
      cwd: this.options.workingDirectory,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', (line) => this.handleLine(line));
    child.stderr.on('data', (chunk: Buffer | string) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-8000);
    });
    child.once('error', (error) => this.handleExit(error));
    child.once('exit', (code, signal) => {
      if (this.closed) return;
      const detail = this.stderr.trim();
      const suffix = detail ? `: ${detail}` : '';
      this.handleExit(
        new Error(
          `Codex app-server exited (${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`})${suffix}`,
        ),
      );
    });

    await this.sendRequest('initialize', {
      clientInfo: {
        name: 'tlive',
        title: 'TLive',
        version: process.env.npm_package_version || 'dev',
      },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    this.sendNotification('initialized');
  }

  private sendRequest(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.write({ method, id, params });
      } catch (error) {
        this.pending.delete(id);
        reject(asError(error));
      }
    });
  }

  private sendNotification(method: string): void {
    this.write({ method });
  }

  private write(message: JsonRpcMessage): void {
    const stdin = this.process?.stdin;
    if (!stdin?.writable) throw new Error('Codex app-server stdin is unavailable');
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      console.warn(`[codex-app-server] ignored invalid JSON: ${line.slice(0, 200)}`);
      return;
    }

    if (message.id !== undefined && message.method) {
      this.respondToServerRequest(message);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(
            `Codex app-server ${message.error.code ?? 'error'}: ${message.error.message ?? 'request failed'}`,
          ),
        );
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (message.method) {
      this.options.onNotification({ method: message.method, params: message.params });
    }
  }

  private respondToServerRequest(message: JsonRpcMessage): void {
    if (message.id === undefined || !message.method) return;
    const result = declinedServerRequestResult(message.method);
    if (result) {
      this.write({ id: message.id, result });
      return;
    }
    this.write({
      id: message.id,
      error: { code: -32601, message: `TLive does not handle ${message.method}` },
    });
  }

  private handleExit(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.lines?.close();
    this.lines = null;
    this.process = null;
    this.rejectPending(error);
    this.options.onExit(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function resolveCodexCommand(codexPath?: string): { executable: string; prefixArgs: string[] } {
  if (codexPath) {
    return codexPath.endsWith('.js')
      ? { executable: process.execPath, prefixArgs: [codexPath] }
      : { executable: codexPath, prefixArgs: [] };
  }

  try {
    const require = createRequire(import.meta.url);
    return {
      executable: process.execPath,
      prefixArgs: [require.resolve('@openai/codex/bin/codex.js')],
    };
  } catch {
    return { executable: process.platform === 'win32' ? 'codex.cmd' : 'codex', prefixArgs: [] };
  }
}

function declinedServerRequestResult(method: string): Record<string, unknown> | undefined {
  if (method === 'item/commandExecution/requestApproval') return { decision: 'decline' };
  if (method === 'item/fileChange/requestApproval') return { decision: 'decline' };
  if (method === 'item/tool/requestUserInput') return { answers: {} };
  if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
  if (method === 'mcpServer/elicitation/request') return { action: 'decline', content: null };
  return undefined;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
