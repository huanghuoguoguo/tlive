import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Logger {
  private logPath: string;
  private secrets: string[];
  private closed = false;

  constructor(logPath: string, secrets: string[]) {
    this.logPath = logPath;
    this.secrets = secrets.filter(Boolean);
    mkdirSync(dirname(logPath), { recursive: true });
  }

  info(msg: string): void { this.write('INFO', msg); }
  warn(msg: string): void { this.write('WARN', msg); }
  error(msg: string): void { this.write('ERROR', msg); }
  debug(msg: string): void { this.write('DEBUG', msg); }
  close(): void { this.closed = true; }

  private write(level: string, msg: string): void {
    if (this.closed) return;
    const timestamp = new Date().toISOString();
    const redacted = this.redact(msg);
    const line = `${timestamp} [${level}] ${redacted}\n`;
    appendFileSync(this.logPath, line);
  }

  private redact(text: string): string {
    let result = text;
    for (const secret of this.secrets) {
      if (secret.length > 0) {
        result = result.replaceAll(secret, '***');
      }
    }
    return result;
  }
}
