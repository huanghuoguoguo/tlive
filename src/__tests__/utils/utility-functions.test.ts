import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatSize, formatRelativeTime } from '../../formatting/session-format.js';
import { redactSensitiveContent } from '../../utils/content-filter.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('formatSize', () => {
  it('formats representative byte units', () => {
    const cases = [
      [0, '0B'],
      [1023, '1023B'],
      [1024, '1.0KB'],
      [1024 * 1023, '1023.0KB'],
      [1024 * 1024, '1.0MB'],
      [1024 * 1024 * 10, '10.0MB'],
    ] as const;

    for (const [size, expected] of cases) {
      expect(formatSize(size)).toBe(expected);
    }
  });
});

describe('formatRelativeTime', () => {
  it('formats zh and en relative times from a fixed clock', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const cases = [
      [0, 'zh', '刚刚'],
      [30_000, 'zh', '刚刚'],
      [60_000, 'zh', '1分钟前'],
      [59 * 60_000, 'zh', '59分钟前'],
      [60 * 60_000, 'zh', '1小时前'],
      [24 * 60 * 60_000, 'zh', '1天前'],
      [0, 'en', 'just now'],
      [60_000, 'en', '1 min ago'],
      [5 * 60_000, 'en', '5 min ago'],
      [60 * 60_000, 'en', '1h ago'],
      [24 * 60 * 60_000, 'en', '1d ago'],
    ] as const;

    for (const [ageMs, locale, expected] of cases) {
      expect(formatRelativeTime(Date.now() - ageMs, locale)).toBe(expected);
    }
  });
});

describe('redactSensitiveContent', () => {
  it('strips terminal escapes and redacts supported secret families', () => {
    const cases = [
      ['\u001B[32mSuccess\u001B[0m', 'Success'],
      ['Key: sk-proj-abcdefgh123456', 'Key: sk-proj-[REDACTED]'],
      ['Key: sk-abcdefghijklmnopqrstuvwxyz123456', 'Key: sk-[REDACTED]'],
      ['Key: sk-ant-api03-abcdefgh123456', 'Key: sk-ant-[REDACTED]'],
      ['AWS: AKIAABCDEFGHIJKLMNOP', 'AWS: AKIA[REDACTED]'],
      ['Token: ghp_abcdefghijklmnopqrstuvwxyz1234567890', 'Token: ghp_[REDACTED]'],
      ['Slack: xoxb-123456789012-abcdef', 'Slack: xox_[REDACTED]'],
      ['API_KEY=abcdef12345678901234', 'API_KEY=[REDACTED]'],
      ['SECRET_PASSWORD="mysecretpassword123"', 'SECRET_PASSWORD=[REDACTED]'],
    ] as const;

    for (const [input, expected] of cases) {
      expect(redactSensitiveContent(input)).toBe(expected);
    }
  });

  it('redacts private key blocks and multiple secrets without damaging normal text', () => {
    const privateKey = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MbzYLtNj2Vy6
-----END RSA PRIVATE KEY-----`;
    expect(redactSensitiveContent(privateKey)).toBe('[PRIVATE KEY REDACTED]');
    expect(redactSensitiveContent('sk-proj-abcdef123456 and AKIAABCDEFGHIJKLMNOP'))
      .toBe('sk-proj-[REDACTED] and AKIA[REDACTED]');
    expect(redactSensitiveContent('Hello world\nPORT=3000')).toBe('Hello world\nPORT=3000');
  });
});
