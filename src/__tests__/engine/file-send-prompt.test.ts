import { afterEach, describe, expect, it } from 'vitest';
import {
  buildFileSendSystemPrompt,
  configureFileSendEnvironment,
  FILE_SEND_TOKEN_ENV,
  FILE_SEND_URL_ENV,
} from '../../engine/automation/file-send-prompt.js';

describe('file send system prompt', () => {
  afterEach(() => {
    delete process.env[FILE_SEND_URL_ENV];
    delete process.env[FILE_SEND_TOKEN_ENV];
  });

  it('is disabled without webhook token', () => {
    expect(buildFileSendSystemPrompt({ enabled: true, port: 8081, token: '' })).toBeUndefined();
    configureFileSendEnvironment({ enabled: true, port: 8081, token: '' });
    expect(process.env[FILE_SEND_URL_ENV]).toBeUndefined();
    expect(process.env[FILE_SEND_TOKEN_ENV]).toBeUndefined();
  });

  it('uses environment variables instead of embedding the token in the prompt', () => {
    const prompt = buildFileSendSystemPrompt({
      enabled: true,
      port: 8081,
      token: 'secret-token',
    });

    expect(prompt).toContain('/api/files/send');
    expect(prompt).toContain(FILE_SEND_URL_ENV);
    expect(prompt).toContain(FILE_SEND_TOKEN_ENV);
    expect(prompt).not.toContain('secret-token');
  });

  it('exports endpoint and token to the Claude subprocess environment', () => {
    configureFileSendEnvironment({
      enabled: true,
      port: 8081,
      token: 'secret-token',
    });

    expect(process.env[FILE_SEND_URL_ENV]).toBe('http://127.0.0.1:8081/api/files/send');
    expect(process.env[FILE_SEND_TOKEN_ENV]).toBe('secret-token');
  });
});
