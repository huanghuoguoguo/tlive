import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { CanonicalEvent } from '../../canonical/schema.js';
import { BaseChannelAdapter } from '../../channels/base.js';
import type {
  InboundMessage,
  SendResult,
  StreamingCardSession,
  ThreadStartResult,
} from '../../channels/types.js';
import { FeishuFormatter } from '../../channels/feishu/formatter.js';
import { FEISHU_POLICY } from '../../channels/feishu/policy.js';
import type { FeishuRenderedMessage } from '../../channels/feishu/types.js';
import type { Config } from '../../config.js';
import { BridgeManager } from '../../engine/coordinators/bridge-manager.js';
import type { LiveSession, StreamChatResult, TurnParams } from '../../providers/base.js';
import type { ClaudeSDKProvider } from '../../providers/claude-sdk.js';
import { JsonFileStore } from '../../store/json-file.js';

type Scenario =
  | string
  | CanonicalEvent[]
  | ((prompt: string, params?: TurnParams) => Promise<CanonicalEvent[]> | CanonicalEvent[]);

export interface SentMessage {
  id: string;
  message: FeishuRenderedMessage;
}

export class TestFeishuAdapter extends BaseChannelAdapter<FeishuRenderedMessage> {
  readonly channelType = 'feishu' as const;
  protected readonly policy = FEISHU_POLICY;
  readonly sent: SentMessage[] = [];
  readonly edits: Array<{ chatId: string; messageId: string; message: FeishuRenderedMessage }> = [];
  readonly typing: string[] = [];
  readonly reactions: Array<{ chatId: string; messageId: string; emoji: string }> = [];
  private queue: InboundMessage[] = [];
  private nextMessageSeq = 1;

  constructor(private readonly authorizedUsers = new Set(['user-1', 'webhook'])) {
    super();
    this.formatter = new FeishuFormatter('zh');
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async consumeOne(): Promise<InboundMessage | null> {
    return this.queue.shift() ?? null;
  }

  push(message: Partial<InboundMessage> & Pick<InboundMessage, 'text'>): InboundMessage {
    const full: InboundMessage = {
      channelType: 'feishu',
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: `in-${this.nextMessageSeq++}`,
      ...message,
    };
    this.queue.push(full);
    return full;
  }

  inbound(message: Partial<InboundMessage> & Pick<InboundMessage, 'text'>): InboundMessage {
    return {
      channelType: 'feishu',
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: `in-${this.nextMessageSeq++}`,
      ...message,
    };
  }

  async send(message: FeishuRenderedMessage): Promise<SendResult> {
    const id = `out-${this.nextMessageSeq++}`;
    this.sent.push({ id, message });
    return { messageId: id, success: true };
  }

  async editMessage(
    chatId: string,
    messageId: string,
    message: FeishuRenderedMessage,
  ): Promise<void> {
    this.edits.push({ chatId, messageId, message });
    const existing = this.sent.find((entry) => entry.id === messageId);
    if (existing) {
      existing.message = message;
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    this.typing.push(chatId);
  }

  validateConfig(): string | null {
    return null;
  }

  isAuthorized(userId: string): boolean {
    return this.authorizedUsers.has(userId);
  }

  async addReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    this.reactions.push({ chatId, messageId, emoji });
  }

  async removeReaction(_chatId: string, _messageId: string): Promise<void> {}

  async startThreadFromMessage(
    _chatId: string,
    messageId: string,
    _text?: string,
  ): Promise<ThreadStartResult | null> {
    return {
      threadId: `thread-${messageId}`,
      rootMessageId: messageId,
      messageId: `topic-${messageId}`,
    };
  }

  createStreamingSession(): StreamingCardSession | null {
    return null;
  }
}

class FakeLiveSession implements LiveSession {
  isAlive = true;
  isTurnActive = false;
  private callbacks: { onTurnComplete?: () => void } = {};

  constructor(
    private readonly scenario: Scenario,
    private readonly nextSessionId: () => string,
    private readonly onPrompt: (prompt: string) => void,
  ) {}

  startTurn(prompt: string, params?: TurnParams): StreamChatResult {
    this.isTurnActive = true;
    this.onPrompt(prompt);
    const stream = new ReadableStream<CanonicalEvent>({
      start: (controller) => {
        void (async () => {
          try {
            for (const event of await resolveScenario(this.scenario, prompt, params, this.nextSessionId)) {
              controller.enqueue(event);
            }
          } catch (error) {
            controller.enqueue({
              kind: 'error',
              message: error instanceof Error ? error.message : String(error),
            });
          } finally {
            this.isTurnActive = false;
            this.callbacks.onTurnComplete?.();
            controller.close();
          }
        })();
      },
    });
    return { stream };
  }

  steerTurn(_text: string): void {}

  async sendWithPriority(_text: string, _priority: 'now' | 'next' | 'later'): Promise<void> {}

  async interruptTurn(): Promise<void> {
    this.isTurnActive = false;
  }

  close(): void {
    this.isAlive = false;
  }

  setLifecycleCallbacks(callbacks: { onTurnComplete?: () => void }): void {
    this.callbacks = callbacks;
  }
}

export class FakeClaudeProvider {
  readonly prompts: string[] = [];
  readonly createSession = vi.fn((params: { workingDirectory: string; sessionId?: string }) => {
    void params;
    return new FakeLiveSession(this.scenario, () => this.nextSessionId(), (prompt) => {
      this.prompts.push(prompt);
    });
  });
  readonly streamChat = vi.fn((params: { prompt: string }) => {
    const session = new FakeLiveSession(this.scenario, () => this.nextSessionId(), (prompt) => {
      this.prompts.push(prompt);
    });
    return session.startTurn(params.prompt);
  });
  private sessionSeq = 1;

  constructor(private scenario: Scenario = 'Fake Claude response') {}

  setScenario(scenario: Scenario): void {
    this.scenario = scenario;
  }

  getDefaultSettingSources(): Array<'user' | 'project' | 'local'> {
    return ['user', 'project', 'local'];
  }

  private nextSessionId(): string {
    return `sdk-session-${this.sessionSeq++}`;
  }
}

export interface E2EHarness {
  root: string;
  store: JsonFileStore;
  adapter: TestFeishuAdapter;
  claude: FakeClaudeProvider;
  manager: BridgeManager;
  cleanup(): Promise<void>;
}

export function createE2EHarness(scenario?: Scenario): E2EHarness {
  const root = mkdtempSync(join(tmpdir(), 'tlive-e2e-'));
  const previousHome = process.env.TLIVE_HOME;
  process.env.TLIVE_HOME = join(root, 'home');

  const store = new JsonFileStore(join(root, 'store'));
  const adapter = new TestFeishuAdapter();
  const claude = new FakeClaudeProvider(scenario);
  const config = testConfig(root);
  const manager = new BridgeManager({
    store,
    llm: claude as unknown as ClaudeSDKProvider,
    defaultWorkdir: root,
    config,
  });
  manager.registerAdapter(adapter);

  return {
    root,
    store,
    adapter,
    claude,
    manager,
    cleanup: async () => {
      await manager.stop();
      if (previousHome === undefined) {
        delete process.env.TLIVE_HOME;
      } else {
        process.env.TLIVE_HOME = previousHome;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export async function waitFor<T>(
  probe: () => T | undefined | false | null,
  timeoutMs = 2000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = probe();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for E2E condition');
}

export function allRenderedText(adapter: TestFeishuAdapter): string {
  return [
    ...adapter.sent.map((entry) => stringifyMessage(entry.message)),
    ...adapter.edits.map((entry) => stringifyMessage(entry.message)),
  ].join('\n');
}

export function findCallbackData(adapter: TestFeishuAdapter, prefix: string): string | undefined {
  for (const entry of adapter.sent) {
    const callback = findInObject(entry.message, prefix);
    if (callback) return callback;
  }
  for (const entry of adapter.edits) {
    const callback = findInObject(entry.message, prefix);
    if (callback) return callback;
  }
  return undefined;
}

function testConfig(root: string): Config {
  return {
    port: 8080,
    token: 'test-token',
    provider: 'claude',
    defaultWorkdir: root,
    defaultModel: '',
    agentSettingSources: ['user', 'project', 'local'],
    codex: {
      model: '',
      codexPath: '',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      skipGitRepoCheck: false,
    },
    webhook: {
      enabled: false,
      token: 'webhook-token',
      port: 0,
      path: '/webhook',
      sessionStrategy: 'create',
      rateLimitPerMinute: 0,
    },
    exec: {
      enabled: false,
      allowedCommands: [],
      timeout: 30_000,
      logExec: true,
    },
    feishu: {
      appId: 'cli_test_app',
      appSecret: 'secret',
      verificationToken: 'verify',
      encryptKey: '',
      webhookPort: 0,
      allowedUsers: ['user-1', 'webhook'],
      autoPinTopics: false,
    },
    ui: {
      doneButtons: ['home'],
    },
  };
}

async function resolveScenario(
  scenario: Scenario,
  prompt: string,
  params: TurnParams | undefined,
  nextSessionId: () => string,
): Promise<CanonicalEvent[]> {
  if (typeof scenario === 'function') {
    return scenario(prompt, params);
  }
  if (Array.isArray(scenario)) {
    return scenario;
  }
  return [
    { kind: 'text_delta', text: scenario },
    {
      kind: 'query_result',
      sessionId: nextSessionId(),
      isError: false,
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    },
  ];
}

function stringifyMessage(message: FeishuRenderedMessage): string {
  return JSON.stringify(message);
}

function findInObject(value: unknown, prefix: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findInObject(item, prefix);
      if (found) return found;
    }
    return undefined;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (key === 'action' && typeof nested === 'string' && nested.startsWith(prefix)) {
      return nested;
    }
    if (key === 'callbackData' && typeof nested === 'string' && nested.startsWith(prefix)) {
      return nested;
    }
    if (typeof nested === 'object') {
      const found = findInObject(nested, prefix);
      if (found) return found;
    }
  }
  return undefined;
}
