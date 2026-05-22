import { createServer } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
      harness.adapter.inbound(topicMessage('please answer from fake Claude')),
      'e2e-query',
    );

    const bindings = await harness.store.listBindings();
    expect(handled).toBe(true);
    expect(harness.adapter.typing).toContain('chat-1');
    expect(bindings.some((binding) => binding.sdkSessionId === 'sdk-session-1')).toBe(true);
    expect(harness.claude.prompts[0]).toContain('please answer from fake Claude');
    expect(allRenderedText(harness.adapter)).toContain('E2E final answer');
  });

  it('treats plain workbench text as command-only guidance instead of starting a session', async () => {
    harness = createE2EHarness('This should not run');

    const handled = await harness.manager.handleInboundMessage(
      harness.adapter,
      harness.adapter.inbound({ text: 'please answer from the workbench' }),
      'e2e-workbench-plain-text',
    );

    expect(handled).toBe(true);
    expect(harness.claude.prompts).toHaveLength(0);
    expect(allRenderedText(harness.adapter)).toContain('主窗口只处理 TLive 命令');
  });

  it('polls the adapter loop after manager start and dispatches queued inbound messages', async () => {
    harness = createE2EHarness('Loop final answer');
    await harness.manager.start();

    harness.adapter.push(topicMessage('message from adapter queue'));

    await waitFor(() => allRenderedText(harness!.adapter).includes('Loop final answer'));
    const bindings = await harness.store.listBindings();
    expect(harness.claude.prompts[0]).toContain('message from adapter queue');
    expect(bindings.some((binding) => binding.sdkSessionId === 'sdk-session-1')).toBe(true);
  });

  it('routes follow-up messages through the topic while a turn is active', async () => {
    harness = createE2EHarness(delayedTrace('Long turn finished'));
    await harness.manager.start();

    const first = harness.adapter.push(topicMessage('start a slow task'));
    await waitFor(() => harness!.claude.prompts.length > 0);
    harness.adapter.push({
      text: 'please add this while running',
      threadId: first.threadId,
      scopeId: first.scopeId,
      replyInThread: true,
      replyTargetMessageId: first.messageId,
      threadRootMessageId: first.messageId,
    });

    await waitFor(() => harness!.claude.priorityMessages.length > 0);

    expect(harness.claude.priorityMessages[0]).toMatchObject({
      text: 'please add this while running',
      priority: 'now',
    });
    expect(allRenderedText(harness.adapter)).toContain('已插入当前会话');
    await waitFor(() => allRenderedText(harness!.adapter).includes('Long turn finished'));
  });

  it('stops an active turn from inside the Feishu topic instead of falling back to workbench state', async () => {
    harness = createE2EHarness(delayedTrace('This should eventually finish after stop'));
    await harness.manager.start();

    const first = harness.adapter.push(topicMessage('start a slow task'));
    await waitFor(() => harness!.claude.prompts.length > 0);

    const stopHandled = await harness.manager.handleInboundMessage(
      harness.adapter,
      harness.adapter.inbound({
        text: '/stop',
        threadId: first.threadId,
        scopeId: first.scopeId,
        replyInThread: true,
        replyTargetMessageId: first.messageId,
        threadRootMessageId: first.messageId,
      }),
      'e2e-topic-stop',
    );

    expect(stopHandled).toBe(true);
    expect(harness.claude.interruptCount).toBe(1);
    expect(allRenderedText(harness.adapter)).toContain('Interrupted current execution');
    expect(allRenderedText(harness.adapter)).not.toContain('No active execution to stop');
  });

  it('renders the workbench and handles a new-session button click as a real callback', async () => {
    harness = createE2EHarness();

    const homeHandled = await harness.manager.handleInboundMessage(
      harness.adapter,
      harness.adapter.inbound({ text: '/home' }),
      'e2e-home',
    );
    const newCallback = await waitFor(() => findCallbackData(harness!.adapter, 'action:new'));

    const callbackHandled = await harness.manager.handleInboundMessage(
      harness.adapter,
      harness.adapter.inbound({
        text: '',
        callbackData: newCallback,
        messageId: 'home-card',
      }),
      'e2e-home-new-click',
    );

    const bindings = await harness.store.listBindings();
    expect(homeHandled).toBe(true);
    expect(callbackHandled).toBe(true);
    expect(bindings.some((binding) => binding.provider === 'claude')).toBe(true);
    expect(bindings.some((binding) => binding.chatId.includes('#thread:'))).toBe(true);
  });

  it('shows the topic command palette from a slash typed inside a topic', async () => {
    harness = createE2EHarness();

    const handled = await harness.manager.handleInboundMessage(
      harness.adapter,
      harness.adapter.inbound({
        text: '/',
        threadId: 'thread-1',
        scopeId: 'chat-1#thread:thread-1',
        replyInThread: true,
        replyTargetMessageId: 'topic-root',
      }),
      'e2e-topic-palette',
    );

    expect(handled).toBe(true);
    expect(allRenderedText(harness.adapter)).toContain('当前会话');
  });

  it('keeps topic permission controls scoped through real callback routes', async () => {
    harness = createE2EHarness();
    const topicInbound = {
      text: '/',
      threadId: 'thread-1',
      scopeId: 'chat-1#thread:thread-1',
      replyInThread: true,
      replyTargetMessageId: 'topic-root',
      threadRootMessageId: 'topic-root',
    };

    await harness.manager.handleInboundMessage(
      harness.adapter,
      harness.adapter.inbound(topicInbound),
      'e2e-topic-perm-palette',
    );

    const permissionCallback = await waitFor(() =>
      findLatestCallbackData(harness!.adapter, 'action:perm'),
    );
    expect(permissionCallback).toContain('%24route%3D');

    const statusHandled = await harness.manager.handleInboundMessage(
      harness.adapter,
      harness.adapter.inbound({
        text: '',
        callbackData: permissionCallback,
        messageId: 'topic-perm-button',
      }),
      'e2e-topic-perm-status',
    );

    const statusMessage = harness.adapter.sent.at(-1)?.message;
    expect(statusHandled).toBe(true);
    expect(statusMessage).toMatchObject({ threadId: 'thread-1', replyInThread: true });
    expect(JSON.stringify(statusMessage)).not.toContain('action:home');

    const turnOffCallback = await waitFor(() =>
      findLatestCallbackData(harness!.adapter, 'action:perm:off'),
    );
    expect(turnOffCallback).toContain('%24route%3D');

    const toggleHandled = await harness.manager.handleInboundMessage(
      harness.adapter,
      harness.adapter.inbound({
        text: '',
        callbackData: turnOffCallback,
        messageId: 'topic-perm-off-button',
      }),
      'e2e-topic-perm-off',
    );

    expect(toggleHandled).toBe(true);
    expect(harness.adapter.sent.at(-1)?.message).toMatchObject({
      threadId: 'thread-1',
      replyInThread: true,
    });

    await harness.manager.handleInboundMessage(
      harness.adapter,
      harness.adapter.inbound(topicInbound),
      'e2e-topic-perm-palette-after-toggle',
    );

    expect(allRenderedText(harness.adapter)).toContain('本话题工具调用自动允许');
  });

  it('renders internal workbench operation cards through real commands', async () => {
    harness = createE2EHarness();

    for (const text of ['/help', '/status', '/diagnose', '/perm']) {
      const handled = await harness.manager.handleInboundMessage(
        harness.adapter,
        harness.adapter.inbound({ text, internalCommand: true }),
        `e2e-command-${text.slice(1)}`,
      );
      expect(handled).toBe(true);
    }

    const rendered = allRenderedText(harness.adapter);
    expect(rendered).toContain('帮助');
    expect(rendered).toContain('Bridge');
    expect(rendered).toContain('权限');
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
      harness.adapter.inbound(topicMessage('update README after approval')),
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

  it('renders tool start and tool result events through the progress card path', async () => {
    harness = createE2EHarness([
      {
        kind: 'tool_start',
        id: 'tool-1',
        name: 'Bash',
        input: { command: 'pwd' },
      },
      {
        kind: 'tool_result',
        toolUseId: 'tool-1',
        content: '/tmp/project',
        isError: false,
      },
      {
        kind: 'text_delta',
        text: 'Tool finished',
      },
      {
        kind: 'query_result',
        sessionId: 'sdk-session-tool',
        isError: false,
        usage: { inputTokens: 2, outputTokens: 2, costUsd: 0 },
      },
    ]);

    const handled = await harness.manager.handleInboundMessage(
      harness.adapter,
      harness.adapter.inbound(topicMessage('run pwd')),
      'e2e-tool-events',
    );

    expect(handled).toBe(true);
    const rendered = allRenderedText(harness.adapter);
    expect(rendered).toContain('Bash');
    expect(rendered).toContain('Tool finished');
  });

  it('splits oversized completed output and survives a transient Feishu edit rate limit', async () => {
    harness = createE2EHarness(longRunningTrace('A'.repeat(31_000)));
    harness.adapter.failNextEditWithRateLimit();

    const handled = await harness.manager.handleInboundMessage(
      harness.adapter,
      harness.adapter.inbound(topicMessage('produce a long answer')),
      'e2e-long-output',
    );

    expect(handled).toBe(true);
    expect(harness.adapter.edits[0]).toMatchObject({
      chatId: 'chat-1',
      messageId: expect.stringMatching(/^out-/),
    });
    expect(harness.adapter.sent.length).toBeGreaterThan(1);
    expect(allRenderedText(harness.adapter)).toContain('AAA');
  });

  it('retries with a fresh session when the provider reports a stale session', async () => {
    let attempts = 0;
    harness = createE2EHarness(() => {
      attempts += 1;
      if (attempts === 1) {
        return [{ kind: 'error', message: 'No conversation found for session' }];
      }
      return [
        { kind: 'text_delta', text: 'Recovered with a fresh session' },
        {
          kind: 'query_result',
          sessionId: 'sdk-session-recovered',
          isError: false,
          usage: { inputTokens: 2, outputTokens: 2, costUsd: 0 },
        },
      ];
    });

    const handled = await harness.manager.handleInboundMessage(
      harness.adapter,
      harness.adapter.inbound(topicMessage('resume stale session')),
      'e2e-stale-session',
    );

    expect(handled).toBe(true);
    expect(attempts).toBe(2);
    expect(allRenderedText(harness.adapter)).toContain('Recovered with a fresh session');
    expect(allRenderedText(harness.adapter)).toContain('旧会话无法恢复');
  });

  it('continues an existing topic session from the workbench resume command', async () => {
    harness = createE2EHarness('Topic session established');
    const topicScopeId = 'chat-1#thread:resume-thread';

    await harness.manager.handleInboundMessage(
      harness.adapter,
      harness.adapter.inbound({
        text: 'start in topic',
        threadId: 'resume-thread',
        scopeId: topicScopeId,
        replyInThread: true,
        replyTargetMessageId: 'topic-root',
        threadRootMessageId: 'topic-root',
      }),
      'e2e-topic-start',
    );

    const handled = await harness.manager.handleInboundMessage(
      harness.adapter,
      harness.adapter.inbound({
        text: '/continue claude:sdk-session-1',
        internalCommand: true,
        messageId: 'workbench-card',
      }),
      'e2e-topic-resume',
    );

    expect(handled).toBe(true);
    expect(allRenderedText(harness.adapter)).toContain('已回到 Claude 会话');
    expect(harness.adapter.sent.some((entry) => entry.message.threadId === 'resume-thread')).toBe(true);
  });

  it('answers an AskUserQuestion option through the Feishu callback path', async () => {
    harness = createE2EHarness(async (_prompt: string, params?: TurnParams) => {
      const answers = await params?.onAskUserQuestion?.([
        {
          question: 'Pick a target',
          header: 'Target',
          options: [{ label: 'README' }, { label: 'package.json' }],
          multiSelect: false,
        },
      ]);
      return [
        {
          kind: 'text_delta',
          text: `Question answered: ${answers?.['Pick a target']}`,
        },
        {
          kind: 'query_result',
          sessionId: 'sdk-session-question',
          isError: false,
          usage: { inputTokens: 3, outputTokens: 3, costUsd: 0 },
        },
      ];
    });

    const queryPromise = harness.manager.handleInboundMessage(
      harness.adapter,
      harness.adapter.inbound(topicMessage('ask me a question first')),
      'e2e-question',
    );

    const callbackData = await waitFor(() => {
      const found = findCallbackData(harness!.adapter, 'perm:allow:');
      return found?.includes(':askq:') ? found : undefined;
    });
    const callbackHandled = await harness.manager.handleInboundMessage(
      harness.adapter,
      harness.adapter.inbound({
        text: '',
        callbackData,
        messageId: 'question-card',
      }),
      'e2e-question-callback',
    );

    expect(callbackHandled).toBe(true);
    await expect(queryPromise).resolves.toBe(true);
    expect(allRenderedText(harness.adapter)).toContain('Question answered: README');
  });

  it('confirms a deferred tool through the Feishu callback path', async () => {
    harness = createE2EHarness(async (_prompt: string, params?: TurnParams) => {
      const result = await params?.onDeferredTool?.('EnterPlanMode', {});
      return [
        {
          kind: 'text_delta',
          text: `Deferred tool ${result?.behavior}`,
        },
        {
          kind: 'query_result',
          sessionId: 'sdk-session-deferred',
          isError: false,
          usage: { inputTokens: 3, outputTokens: 3, costUsd: 0 },
        },
      ];
    });

    const queryPromise = harness.manager.handleInboundMessage(
      harness.adapter,
      harness.adapter.inbound(topicMessage('enter plan mode')),
      'e2e-deferred',
    );

    const formCallback = await waitFor(() => findCallbackData(harness!.adapter, 'form:'));
    const callbackData = `${formCallback}:{"_deferred_input":""}`;
    const callbackHandled = await harness.manager.handleInboundMessage(
      harness.adapter,
      harness.adapter.inbound({
        text: '',
        callbackData,
        messageId: 'deferred-card',
      }),
      'e2e-deferred-callback',
    );

    expect(callbackHandled).toBe(true);
    await expect(queryPromise).resolves.toBe(true);
    expect(allRenderedText(harness.adapter)).toContain('Deferred tool allow');
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
      projects: [
        {
          name: 'project-a',
          workdir: harness.root,
          agentSettingSources: ['user'],
          webhookDefaultChat: { channelType: 'feishu', chatId: 'chat-1' },
        },
      ],
    });
    server.start();

    try {
      const response = await postWebhook(`http://127.0.0.1:${port}/webhook`, {
        event: 'ci:failed',
        projectName: 'project-a',
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

  it('sends files over the webhook file API into the channel adapter', async () => {
    harness = createE2EHarness();
    await writeFile(join(harness.root, 'report.txt'), 'hello from e2e\n');
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
      const response = await postJson<{ success: boolean; filename?: string; error?: string }>(
        `http://127.0.0.1:${port}/api/files/send`,
        {
          file_path: 'report.txt',
          caption: 'attached report',
          channelType: 'feishu',
          chatId: 'chat-1',
        },
      );

      expect(response).toMatchObject({ success: true, filename: 'report.txt' });
      const sentWithMedia = harness.adapter.sent.find((entry) => entry.message.media);
      expect(sentWithMedia?.message.media).toMatchObject({
        type: 'file',
        filename: 'report.txt',
        mimeType: 'text/plain',
      });
      expect(sentWithMedia?.message.text).toContain('attached report');
    } finally {
      server.stop();
    }
  });
});

function topicMessage(text: string) {
  return {
    text,
    threadId: 'thread-1',
    scopeId: 'chat-1#thread:thread-1',
    replyInThread: true,
    replyTargetMessageId: 'topic-root',
    threadRootMessageId: 'topic-root',
  };
}

async function* longRunningTrace(text: string): AsyncIterable<import('../../canonical/schema.js').CanonicalEvent> {
  yield {
    kind: 'tool_start',
    id: 'tool-long',
    name: 'Bash',
    input: { command: 'generate long answer' },
  };
  await new Promise((resolve) => setTimeout(resolve, 20));
  yield {
    kind: 'tool_result',
    toolUseId: 'tool-long',
    content: 'done',
    isError: false,
  };
  yield { kind: 'text_delta', text };
  yield {
    kind: 'query_result',
    sessionId: 'sdk-session-long',
    isError: false,
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
  };
}

async function* delayedTrace(text: string): AsyncIterable<import('../../canonical/schema.js').CanonicalEvent> {
  yield {
    kind: 'tool_start',
    id: 'tool-delay',
    name: 'Bash',
    input: { command: 'sleep 1' },
  };
  await new Promise((resolve) => setTimeout(resolve, 250));
  yield { kind: 'text_delta', text };
  yield {
    kind: 'query_result',
    sessionId: 'sdk-session-delayed',
    isError: false,
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
  };
}

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
  return postJson<WebhookResponse>(url, body);
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
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
      return await response.json() as T;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError;
}

function findLatestCallbackData(
  adapter: NonNullable<E2EHarness['adapter']>,
  prefix: string,
): string | undefined {
  for (const entry of [...adapter.edits].reverse()) {
    const found = findCallbackInObject(entry.message, prefix);
    if (found) return found;
  }
  for (const entry of [...adapter.sent].reverse()) {
    const found = findCallbackInObject(entry.message, prefix);
    if (found) return found;
  }
  return undefined;
}

function findCallbackInObject(value: unknown, prefix: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCallbackInObject(item, prefix);
      if (found) return found;
    }
    return undefined;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (
      (key === 'action' || key === 'callbackData') &&
      typeof nested === 'string' &&
      nested.startsWith(prefix)
    ) {
      return nested;
    }
    if (typeof nested === 'object') {
      const found = findCallbackInObject(nested, prefix);
      if (found) return found;
    }
  }
  return undefined;
}
