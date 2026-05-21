import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebhookServer, type WebhookResponse } from '../../engine/automation/webhook.js';
import type { TurnParams } from '../../providers/base.js';
import {
  allRenderedText,
  createE2EHarness,
  findCallbackData,
  type E2EHarness,
  waitFor,
} from './harness.js';

describe('bridge E2E harness', () => {
  let harness: E2EHarness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('handles a bridge command through the real manager and Feishu formatter', async () => {
    harness = createE2EHarness();

    const handled = await harness.manager.handleInboundMessage(
      harness.adapter,
      harness.adapter.inbound({ text: '/pwd', internalCommand: true }),
      'e2e-pwd',
    );

    expect(handled).toBe(true);
    expect(allRenderedText(harness.adapter)).toContain(harness.root);
    expect(harness.claude.createSession).not.toHaveBeenCalled();
  });

  it('runs a user prompt through a live fake Claude session and persists the SDK session id', async () => {
    harness = createE2EHarness('E2E final answer');

    const handled = await harness.manager.handleInboundMessage(
      harness.adapter,
      harness.adapter.inbound({ text: 'please answer from fake Claude' }),
      'e2e-query',
    );

    const bindings = await harness.store.listBindings();
    expect(handled).toBe(true);
    expect(bindings.some((binding) => binding.sdkSessionId === 'sdk-session-1')).toBe(true);
    expect(harness.claude.prompts[0]).toContain('please answer from fake Claude');
    expect(allRenderedText(harness.adapter)).toContain('E2E final answer');
  });

  it('resolves a Claude tool permission via the same callback path Feishu cards use', async () => {
    harness = createE2EHarness(async (_prompt: string, params?: TurnParams) => {
      const decision = await params?.onPermissionRequest?.(
        'Write',
        { file_path: 'README.md', content: 'updated' },
        'Allow Write?',
      );
      return [
        {
          kind: 'text_delta',
          text: `Permission ${decision}; write completed`,
        },
        {
          kind: 'query_result',
          sessionId: 'sdk-session-with-perm',
          isError: false,
          usage: { inputTokens: 2, outputTokens: 2, costUsd: 0 },
        },
      ];
    });

    const queryPromise = harness.manager.handleInboundMessage(
      harness.adapter,
      harness.adapter.inbound({ text: 'update README after approval' }),
      'e2e-permission',
    );

    const callbackData = await waitFor(() => findCallbackData(harness!.adapter, 'perm:allow:'));
    const callbackHandled = await harness.manager.handleInboundMessage(
      harness.adapter,
      harness.adapter.inbound({
        text: '',
        callbackData,
        messageId: 'permission-callback',
      }),
      'e2e-permission-callback',
    );

    expect(callbackHandled).toBe(true);
    await expect(queryPromise).resolves.toBe(true);
    expect(allRenderedText(harness.adapter)).toContain('write completed');
    expect(harness.adapter.reactions.some((reaction) => reaction.emoji === 'OK')).toBe(true);
  });

  it('injects webhook prompts over HTTP into the bridge with payload expansion', async () => {
    harness = createE2EHarness('Webhook handled');
    const port = await getFreePort();
    const server = new WebhookServer({
      token: 'webhook-token',
      port,
      path: '/webhook',
      bridge: harness.manager,
      sessionStrategy: 'create',
      rateLimitPerMinute: 0,
      defaultWorkdir: harness.root,
    });
    server.start();

    try {
      const response = await postWebhook(`http://127.0.0.1:${port}/webhook`, {
        event: 'ci:failed',
        channelType: 'feishu',
        chatId: 'chat-1',
        prompt: 'Review build {build}',
        payload: { build: 42 },
      });

      expect(response.success).toBe(true);
      expect(response.route).toMatchObject({ channelType: 'feishu', chatId: 'chat-1' });
      expect(harness.claude.prompts.at(-1)).toContain('Review build 42');
      expect(allRenderedText(harness.adapter)).toContain('Webhook handled');
    } finally {
      server.stop();
    }
  });
});

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a test port')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function postWebhook(url: string, body: unknown): Promise<WebhookResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer webhook-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      return await response.json() as WebhookResponse;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError;
}
