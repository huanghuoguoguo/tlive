import { describe, it, expect } from 'vitest';
import { formatSize, formatRelativeTime } from '../../utils/session-format.js';
import { redactSensitiveContent } from '../../utils/content-filter.js';

describe('formatSize', () => {
  it('formats bytes under 1KB', () => {
    expect(formatSize(100)).toBe('100B');
    expect(formatSize(0)).toBe('0B');
    expect(formatSize(1023)).toBe('1023B');
  });

  it('formats KB under 1MB', () => {
    expect(formatSize(1024)).toBe('1.0KB');
    expect(formatSize(5120)).toBe('5.0KB');
    expect(formatSize(1024 * 1023)).toBe('1023.0KB');
  });

  it('formats MB for larger sizes', () => {
    expect(formatSize(1024 * 1024)).toBe('1.0MB');
    expect(formatSize(1024 * 1024 * 10)).toBe('10.0MB');
  });
});

describe('formatRelativeTime', () => {
  it('returns "刚刚" for less than 1 minute', () => {
    const now = Date.now();
    expect(formatRelativeTime(now)).toBe('刚刚');
    expect(formatRelativeTime(now - 30000)).toBe('刚刚');
  });

  it('returns minutes for less than 1 hour', () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 60000)).toBe('1分钟前');
    expect(formatRelativeTime(now - 5 * 60000)).toBe('5分钟前');
    expect(formatRelativeTime(now - 59 * 60000)).toBe('59分钟前');
  });

  it('returns hours for less than 24 hours', () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 3600000)).toBe('1小时前');
    expect(formatRelativeTime(now - 12 * 3600000)).toBe('12小时前');
  });

  it('returns days for less than 7 days', () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 86400000)).toBe('1天前');
    expect(formatRelativeTime(now - 3 * 86400000)).toBe('3天前');
    expect(formatRelativeTime(now - 6 * 86400000)).toBe('6天前');
  });
});

describe('redactSensitiveContent', () => {
  it('strips ANSI escape sequences', () => {
    const input = '\u001B[32mSuccess\u001B[0m';
    expect(redactSensitiveContent(input)).toBe('Success');
  });

  it('redacts OpenAI API keys', () => {
    expect(redactSensitiveContent('Key: sk-proj-abcdefgh123456')).toBe('Key: sk-proj-[REDACTED]');
    expect(redactSensitiveContent('Key: sk-abcdefghijklmnopqrstuvwxyz123456')).toBe('Key: sk-[REDACTED]');
  });

  it('redacts Anthropic API keys', () => {
    expect(redactSensitiveContent('Key: sk-ant-api03-abcdefgh123456')).toBe('Key: sk-ant-[REDACTED]');
  });

  it('redacts AWS access keys', () => {
    expect(redactSensitiveContent('AWS: AKIAABCDEFGHIJKLMNOP')).toBe('AWS: AKIA[REDACTED]');
  });

  it('redacts GitHub tokens', () => {
    expect(redactSensitiveContent('Token: ghp_abcdefghijklmnopqrstuvwxyz1234567890')).toBe('Token: ghp_[REDACTED]');
  });

  it('redacts Slack tokens', () => {
    expect(redactSensitiveContent('Slack: xoxb-123456789012-abcdef')).toBe('Slack: xox_[REDACTED]');
  });

  it('redacts private key blocks', () => {
    const input = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MbzYLtNj2Vy6
-----END RSA PRIVATE KEY-----`;
    expect(redactSensitiveContent(input)).toBe('[PRIVATE KEY REDACTED]');
  });

  it('redacts sensitive environment variables', () => {
    expect(redactSensitiveContent('API_KEY=abcdef12345678901234')).toBe('API_KEY=[REDACTED]');
    expect(redactSensitiveContent('SECRET_PASSWORD="mysecretpassword123"')).toBe('SECRET_PASSWORD=[REDACTED]');
  });

  it('preserves non-sensitive content', () => {
    expect(redactSensitiveContent('Hello world')).toBe('Hello world');
    expect(redactSensitiveContent('PORT=3000')).toBe('PORT=3000');
  });

  it('handles multiple patterns in same text', () => {
    const input = 'sk-proj-abcdef123456 and AKIAABCDEFGHIJKLMNOP';
    expect(redactSensitiveContent(input)).toBe('sk-proj-[REDACTED] and AKIA[REDACTED]');
  });
});