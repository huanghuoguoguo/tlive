import { appendFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { format } from 'node:util';

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
type ConsoleMethod = 'info' | 'warn' | 'error' | 'debug';

type RawConsole = {
  log: typeof console.log;
  info: typeof console.info;
  warn: typeof console.warn;
  error: typeof console.error;
  debug: typeof console.debug;
};

export class Logger {
  private logDir: string;
  private logBase: string;
  private logExt: string;
  private secrets: string[];
  private closed = false;
  private mirrorToConsole: boolean;
  private rawConsole: RawConsole;

  constructor(logPath: string, secrets: string[], mirrorToConsole = process.stdout.isTTY || process.stderr.isTTY) {
    this.logDir = dirname(logPath);
    this.logExt = extname(logPath) || '.log';
    this.logBase = basename(logPath, this.logExt);
    this.secrets = secrets.filter(Boolean);
    this.mirrorToConsole = mirrorToConsole;
    this.rawConsole = {
      log: console.log.bind(console),
      info: console.info.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      debug: console.debug.bind(console),
    };
    mkdirSync(this.logDir, { recursive: true });
  }

  info(msg: string): void { this.write('INFO', msg); }
  warn(msg: string): void { this.write('WARN', msg); }
  error(msg: string): void { this.write('ERROR', msg); }
  debug(msg: string): void { this.write('DEBUG', msg); }
  close(): void { this.closed = true; }

  installConsoleInterception(): void {
    console.log = (...args: unknown[]) => this.write('INFO', format(...args));
    console.info = (...args: unknown[]) => this.write('INFO', format(...args));
    console.warn = (...args: unknown[]) => this.write('WARN', format(...args));
    console.error = (...args: unknown[]) => this.write('ERROR', format(...args));
    console.debug = (...args: unknown[]) => this.write('DEBUG', format(...args));
  }

  private write(level: LogLevel, msg: string): void {
    if (this.closed) return;
    const redacted = this.redact(msg);
    const date = new Date();
    const stamp = this.getDateStamp(date);
    const parsed = this.parseMessage(redacted);
    const fileLine = `${date.toISOString()} [${parsed.module}] ${level}: ${parsed.message}\n`;
    appendFileSync(this.getDailyPath(stamp), fileLine);
    if (level === 'WARN' || level === 'ERROR') {
      appendFileSync(this.getDailyPath(stamp, 'error'), fileLine);
    }

    if (this.mirrorToConsole) {
      const consoleLine = `${this.getTimeStamp(date)} [${parsed.module}] ${level}: ${parsed.message}`;
      this.getConsoleMethod(level)(consoleLine);
    }
  }

  private getDailyPath(dateStamp: string, suffix?: 'error'): string {
    const extra = suffix ? `-${suffix}` : '';
    return join(this.logDir, `${this.logBase}-${dateStamp}${extra}${this.logExt}`);
  }

  private getDateStamp(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private getTimeStamp(date: Date): string {
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  private parseMessage(text: string): { module: string; message: string } {
    const trimmed = text.trim();
    const match = trimmed.match(/^\[([^\]]+)\]\s*(.*)$/s);
    if (match) {
      return {
        module: match[1],
        message: match[2] || '(empty)',
      };
    }
    return { module: 'app', message: trimmed || '(empty)' };
  }

  private getConsoleMethod(level: LogLevel): (...args: unknown[]) => void {
    const method: ConsoleMethod = level === 'ERROR'
      ? 'error'
      : level === 'WARN'
        ? 'warn'
        : level === 'DEBUG'
          ? 'debug'
          : 'info';
    return this.rawConsole[method];
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
