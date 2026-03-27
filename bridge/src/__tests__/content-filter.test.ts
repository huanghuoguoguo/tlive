import { describe, it, expect } from 'vitest';
import { redactSensitiveContent } from '../engine/content-filter.js';

describe('content-filter', () => {
  describe('API keys', () => {
    it('redacts OpenAI API keys', () => {
      const input = 'key is sk-proj-abc123def456ghi789jkl012mno345pqr678';
      const result = redactSensitiveContent(input);
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('abc123def456');
    });

    it('redacts Anthropic API keys', () => {
      const input = 'ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890';
      const result = redactSensitiveContent(input);
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('abcdefghijklmnop');
    });

    it('redacts AWS access keys', () => {
      const input = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
      const result = redactSensitiveContent(input);
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
    });

    it('redacts AWS secret keys', () => {
      const input = 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
      const result = redactSensitiveContent(input);
      expect(result).toContain('[REDACTED]');
    });

    it('redacts GitHub tokens', () => {
      const input = 'token: ghp_1234567890abcdefghijklmnopqrstuvwxyz';
      const result = redactSensitiveContent(input);
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('ghp_1234567890');
    });

    it('redacts GitHub fine-grained tokens', () => {
      const input = 'github_pat_11ABCDEF0abcdefghijklmnop1234567890abcdefghijklmnopqrstuvwxyz1234567890ab';
      const result = redactSensitiveContent(input);
      expect(result).toContain('[REDACTED]');
    });

    it('redacts Slack tokens', () => {
      const input = 'SLACK_TOKEN=xoxb-1234567890-1234567890123-abcdefghijklmnopqrstuvwx';
      const result = redactSensitiveContent(input);
      expect(result).toContain('[REDACTED]');
    });

    it('redacts generic Bearer tokens', () => {
      const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
      const result = redactSensitiveContent(input);
      expect(result).toContain('[REDACTED]');
    });
  });

  describe('private keys', () => {
    it('redacts PEM private keys', () => {
      const input = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQ...\n-----END RSA PRIVATE KEY-----';
      const result = redactSensitiveContent(input);
      expect(result).toContain('[PRIVATE KEY REDACTED]');
      expect(result).not.toContain('MIIEpAIBAAKCAQ');
    });

    it('redacts EC private keys', () => {
      const input = '-----BEGIN EC PRIVATE KEY-----\nabc123...\n-----END EC PRIVATE KEY-----';
      const result = redactSensitiveContent(input);
      expect(result).toContain('[PRIVATE KEY REDACTED]');
    });
  });

  describe('environment variable patterns', () => {
    it('redacts PASSWORD= assignments', () => {
      const input = 'DB_PASSWORD=supersecret123!@#';
      const result = redactSensitiveContent(input);
      expect(result).toContain('DB_PASSWORD=');
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('supersecret123');
    });

    it('redacts SECRET= assignments', () => {
      const input = 'JWT_SECRET="my-super-secret-key-12345"';
      const result = redactSensitiveContent(input);
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('my-super-secret-key');
    });

    it('redacts TOKEN= assignments', () => {
      const input = 'DISCORD_TOKEN=NzA5NTg2.YrxAkQ.abc123def456';
      const result = redactSensitiveContent(input);
      expect(result).toContain('[REDACTED]');
    });
  });

  describe('preserves normal content', () => {
    it('does not redact normal text', () => {
      const input = 'This is a normal message about fixing a bug';
      expect(redactSensitiveContent(input)).toBe(input);
    });

    it('does not redact normal code', () => {
      const input = 'function add(a: number, b: number): number { return a + b; }';
      expect(redactSensitiveContent(input)).toBe(input);
    });

    it('does not redact short strings after =', () => {
      const input = 'PORT=3000';
      expect(redactSensitiveContent(input)).toBe(input);
    });

    it('does not redact non-sensitive env vars', () => {
      const input = 'NODE_ENV=production';
      expect(redactSensitiveContent(input)).toBe(input);
    });

    it('preserves surrounding text', () => {
      const input = 'Found key: sk-proj-abc123xyz789 in config';
      const result = redactSensitiveContent(input);
      expect(result).toContain('Found key:');
      expect(result).toContain('in config');
      expect(result).toContain('[REDACTED]');
    });
  });

  describe('multiple redactions', () => {
    it('redacts multiple secrets in one string', () => {
      const input = 'OPENAI_KEY=sk-proj-abc123\nANTHROPIC_KEY=sk-ant-api03-xyz789';
      const result = redactSensitiveContent(input);
      expect(result).not.toContain('abc123');
      expect(result).not.toContain('xyz789');
      const redactCount = (result.match(/\[REDACTED\]/g) || []).length;
      expect(redactCount).toBeGreaterThanOrEqual(2);
    });
  });
});
