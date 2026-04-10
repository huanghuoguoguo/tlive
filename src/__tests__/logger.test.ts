import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Logger } from '../logger.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function localDateStamp(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

describe('Logger', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'termlive-logger-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes log messages to file', () => {
    const logPath = join(tmpDir, 'test.log');
    const logger = new Logger(logPath, []);
    logger.info('hello world');
    logger.close();
    const content = readFileSync(join(tmpDir, `test-${localDateStamp()}.log`), 'utf-8');
    expect(content).toContain('hello world');
    expect(content).toContain('INFO: hello world');
  });

  it('supports multiple log levels', () => {
    const logPath = join(tmpDir, 'test.log');
    const logger = new Logger(logPath, []);
    logger.info('info msg');
    logger.warn('warn msg');
    logger.error('error msg');
    logger.debug('debug msg');
    logger.close();
    const dailyLog = join(tmpDir, `test-${localDateStamp()}.log`);
    const errorLog = join(tmpDir, `test-${localDateStamp()}-error.log`);
    const content = readFileSync(dailyLog, 'utf-8');
    const errorContent = readFileSync(errorLog, 'utf-8');
    expect(content).toContain('INFO: info msg');
    expect(content).toContain('WARN: warn msg');
    expect(content).toContain('ERROR: error msg');
    expect(content).toContain('DEBUG: debug msg');
    expect(errorContent).toContain('WARN: warn msg');
    expect(errorContent).toContain('ERROR: error msg');
  });

  it('redacts secrets from log output', () => {
    const logPath = join(tmpDir, 'test.log');
    const secret = 'my-super-secret-token';
    const logger = new Logger(logPath, [secret]);
    logger.info(`connecting with token ${secret} to server`);
    logger.close();
    const content = readFileSync(join(tmpDir, `test-${localDateStamp()}.log`), 'utf-8');
    expect(content).not.toContain(secret);
    expect(content).toContain('***');
  });

  it('redacts multiple secrets', () => {
    const logPath = join(tmpDir, 'test.log');
    const logger = new Logger(logPath, ['secret1', 'secret2']);
    logger.info('auth secret1 and secret2');
    logger.close();
    const content = readFileSync(join(tmpDir, `test-${localDateStamp()}.log`), 'utf-8');
    expect(content).not.toContain('secret1');
    expect(content).not.toContain('secret2');
  });

  it('includes timestamp', () => {
    const logPath = join(tmpDir, 'test.log');
    const logger = new Logger(logPath, []);
    logger.info('timestamped');
    logger.close();
    const content = readFileSync(join(tmpDir, `test-${localDateStamp()}.log`), 'utf-8');
    // Should contain ISO-like timestamp
    expect(content).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('preserves module prefix in unified format', () => {
    const logPath = join(tmpDir, 'test.log');
    const logger = new Logger(logPath, []);
    logger.info('[qqbot] Reconnecting in 2000ms');
    logger.close();
    const content = readFileSync(join(tmpDir, `test-${localDateStamp()}.log`), 'utf-8');
    expect(content).toContain('[qqbot] INFO: Reconnecting in 2000ms');
  });
});
