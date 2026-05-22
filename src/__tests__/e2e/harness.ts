import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { CanonicalEvent } from '../../canonical/schema.js';
import { BaseChannelAdapter } from '../../channels/base.js';
import { RateLimitError } from '../../channels/errors.js';
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
import type { LiveSession, MessagePriority, StreamChatResult, TurnParams } from '../../providers/base.js';
import type { ClaudeSDKProvider } from '../../providers/claude-sdk.js';
import { JsonFileStore } from '../../store/json-file.js';

type Scenario =
  | string
  | CanonicalEvent[]
  | AsyncIterable<CanonicalEvent>
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
  private editRateLimitFailures = 0;
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
    if (this.editRateLimitFailures > 0) {
      this.editRateLimitFailures -= 1;
      throw new RateLimitError('fake Feishu edit rate limit', 1);
    }
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

  failNextEditWithRateLimit(times = 1): void {
    this.editRateLimitFailures += times;
  }
}

class FakeLiveSession implements LiveSession {
  isAlive = true;
  isTurnActive = false;
  readonly runtimeInfo = {
    provider: 'claude' as const,
    displayName: 'Claude',
    model: 'fake-claude',
  };
  private callbacks: { onTurnComplete?: () => void } = {};

  constructor(
    private readonly scenario: Scenario,
    private readonly nextSessionId: () => string,
    private readonly onPrompt: (prompt: string) => void,
    private readonly onPriorityMessage: (text: string, priority: MessagePriority) => void,
    private readonly onInterrupt: () => void,
  ) {}

  startTurn(prompt: string, params?: TurnParams): StreamChatResult {
    this.isTurnActive = true;
    this.onPrompt(prompt);
    const stream = new ReadableStream<CanonicalEvent>({
      start: (controller) => {
        void (async () => {
          try {
            for await (const event of resolveScenarioStream(
              this.scenario,
              prompt,
              params,
              this.nextSessionId,
            )) {
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
    return {
      stream,
      controls: {
        interrupt: () => this.interruptTurn(),
        stopTask: async () => {},
      },
    };
  }

  steerTurn(_text: string): void {}

  async sendWithPriority(text: string, priority: MessagePriority): Promise<void> {
    this.onPriorityMessage(text, priority);
  }

  async interruptTurn(): Promise<void> {
    this.onInterrupt();
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
  readonly kind = 'claude' as const;
  readonly displayName = 'Claude';
  readonly capabilities = {
    runtimeMode: 'interactive',
    nativeSteer: true,
    nativeQueue: true,
    interactivePermissions: true,
    askUserQuestion: true,
    deferredTools: true,
    settingSources: true,
    sessionResume: true,
    imageInputs: true,
  };
  readonly prompts: string[] = [];
  readonly priorityMessages: Array<{ text: string; priority: MessagePriority }> = [];
  interruptCount = 0;
  readonly createSession = vi.fn((params: { workingDirectory: string; sessionId?: string }) => {
    void params;
    return new FakeLiveSession(
      this.scenario,
      () => this.nextSessionId(),
      (prompt) => {
        this.prompts.push(prompt);
      },
      (text, priority) => {
        this.priorityMessages.push({ text, priority });
      },
      () => {
        this.interruptCount += 1;
      },
    );
  });
  readonly streamChat = vi.fn((params: { prompt: string }) => {
    const session = new FakeLiveSession(
      this.scenario,
      () => this.nextSessionId(),
      (prompt) => {
        this.prompts.push(prompt);
      },
      (text, priority) => {
        this.priorityMessages.push({ text, priority });
      },
      () => {
        this.interruptCount += 1;
      },
    );
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
    getExecutionClients: () => [
      {
        clientId: 'local',
        name: 'local',
        online: true,
        isDefault: true,
        isLocal: true,
        activeTurns: 0,
        maxConcurrency: 1,
        workspaces: [{ path: root, isDefault: true }],
        providers: [{ kind: 'claude', displayName: 'Claude', available: true, isDefault: true }],
        version: 'test',
      },
    ],
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
    remote: {
      server: {
        enabled: false,
        localClientEnabled: true,
        port: 8787,
        path: '/tlive',
        token: 'remote-token',
        providers: ['claude', 'codex'],
        heartbeatIntervalMs: 30_000,
        clientTimeoutMs: 90_000,
      },
      client: {
        serverUrl: 'ws://127.0.0.1:8787/tlive',
        token: 'remote-token',
        clientId: 'test-client',
        name: 'test-client',
        providers: ['claude', 'codex'],
        workspaces: [root],
        maxConcurrency: 1,
        reconnectIntervalMs: 3000,
      },
    },
  };
}

async function* resolveScenarioStream(
  scenario: Scenario,
  prompt: string,
  params: TurnParams | undefined,
  nextSessionId: () => string,
): AsyncIterable<CanonicalEvent> {
  if (typeof scenario === 'function') {
    yield* await scenario(prompt, params);
    return;
  }
  if (isAsyncIterable(scenario)) {
    yield* scenario;
    return;
  }
  if (Array.isArray(scenario)) {
    yield* scenario;
    return;
  }
  yield { kind: 'text_delta', text: scenario };
  yield {
    kind: 'query_result',
    sessionId: nextSessionId(),
    isError: false,
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
  };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<CanonicalEvent> {
  return !!value && typeof value === 'object' && Symbol.asyncIterator in value;
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

  if (
    prefix === 'form:' &&
    (value as { form_action_type?: unknown }).form_action_type === 'submit' &&
    typeof (value as { name?: unknown }).name === 'string'
  ) {
    return `form:${(value as { name: string }).name}`;
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
