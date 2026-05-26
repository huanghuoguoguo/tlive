import type {
  ChannelType,
  InboundMessage,
  PinnedTopicMetadata,
  RenderedMessage,
  SendResult,
  StreamingCardSession,
  ThreadStartResult,
} from './types.js';
import type {
  CardResolutionData,
  FormattableMessage,
} from '../../shared/formatting/message-types.js';
import type { MessageFormatter } from '../../shared/formatting/message-formatter.js';
import type { Button } from '../../shared/ui/types.js';
import type {
  ChannelPolicy,
  PermissionDecision,
  ProgressPhase,
  ProgressTraceStats,
} from './policy.js';
import type { BridgeError } from './errors.js';
import { classifyDefaultError } from './errors.js';

export abstract class BaseChannelAdapter<TRendered extends RenderedMessage = RenderedMessage> {
  abstract readonly channelType: ChannelType;
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract consumeOne(): Promise<InboundMessage | null>;
  abstract send(message: TRendered): Promise<SendResult>;
  abstract editMessage(chatId: string, messageId: string, message: TRendered): Promise<void>;
  abstract sendTyping(chatId: string): Promise<void>;
  abstract validateConfig(): string | null;
  abstract isAuthorized(userId: string, chatId: string): boolean;

  /** Delete a message. Override in adapters that support deletion. */
  async deleteMessage(_chatId: string, _messageId: string): Promise<void> {}

  /** Add a reaction emoji to a message. Override in adapters that support reactions. */
  async addReaction(_chatId: string, _messageId: string, _emoji: string): Promise<void> {}

  /** Remove all bot reactions from a message. */
  async removeReaction(_chatId: string, _messageId: string): Promise<void> {}

  /** Start a platform topic/thread from an existing user message. */
  async startThreadFromMessage(
    _chatId: string,
    _messageId: string,
    _text?: string,
  ): Promise<ThreadStartResult | null> {
    return null;
  }

  /** Start a platform topic/thread with a freshly posted title/root message. */
  async startThreadWithTitle(
    _chatId: string,
    _title: string,
    _text?: string,
  ): Promise<ThreadStartResult | null> {
    return null;
  }

  /** Resolve TLive metadata from a pinned platform topic entry, when supported. */
  async findPinnedTopicMetadata(
    _chatId: string,
    _threadId: string,
  ): Promise<PinnedTopicMetadata | null> {
    return null;
  }

  /** Publish a platform-readable metadata entry for a topic and pin it when supported. */
  async publishTopicMetadata(
    _chatId: string,
    _rootMessageId: string,
    _text: string,
  ): Promise<string | null> {
    return null;
  }

  /** Create a streaming card/message session when the platform supports it. */
  createStreamingSession(
    _chatId: string,
    _receiveIdType?: string,
    _replyToMessageId?: string,
    _header?: { template: string; title: string },
    _replyInThread?: boolean,
  ): StreamingCardSession | null {
    return null;
  }

  /** Whether a rendered progress message should be split into a new bubble on this platform. */
  shouldSplitProgressMessage(_message: TRendered): boolean {
    return false;
  }

  // --- Policy support ---

  /** Platform behavior policy. Concrete adapters must make this explicit. */
  protected abstract readonly policy: ChannelPolicy;

  /** Whether this platform should render a progress update for the given phase. */
  shouldRenderProgressPhase(phase: ProgressPhase): boolean {
    return this.policy.progress.shouldRenderPhase(phase);
  }

  /** Whether a completed trace should be split into trace + summary cards. */
  shouldSplitCompletedTrace(stats: ProgressTraceStats): boolean {
    return this.policy.progress.shouldSplitCompletedTrace(stats);
  }

  /** Platform reaction set used for lifecycle/status updates. */
  getLifecycleReactions(): {
    processing: string;
    done: string;
    error: string;
    stalled: string;
    permission: string;
  } {
    const r = this.policy.reactions;
    return {
      processing: r.processing,
      done: r.done,
      error: r.error,
      stalled: r.stalled,
      permission: r.permission,
    };
  }

  /** Platform reaction for a text-based permission decision. */
  getPermissionDecisionReaction(decision: PermissionDecision): string {
    return this.policy.reactions.getPermissionDecision(decision);
  }

  /** Format code output for this platform using the policy. */
  formatCodeOutput(text: string): string {
    return this.policy.format.formatCodeOutput(text);
  }

  // --- Formatting support ---

  /** Platform-specific message formatter. Override in subclass. */
  protected formatter!: MessageFormatter<TRendered>;

  /** Get the locale for this adapter */
  getLocale(): 'en' | 'zh' {
    return this.policy.locale;
  }

  /**
   * Format a semantic message for this platform.
   * Uses the platform-specific formatter to render the message.
   */
  format(msg: FormattableMessage): TRendered {
    return this.formatter.format(msg);
  }

  /**
   * Format and send a semantic message in one call.
   */
  async sendFormatted(msg: FormattableMessage): Promise<SendResult> {
    return this.send(this.format(msg));
  }

  /** Format a card resolution and edit an existing message. */
  editCardResolution(chatId: string, messageId: string, data: CardResolutionData): Promise<void> {
    const outMsg = this.format({ type: 'cardResolution', chatId, data });
    return this.editMessage(chatId, messageId, outMsg);
  }

  /** Format raw markdown content into a platform-appropriate message. */
  formatContent(chatId: string, content: string, buttons?: Button[]): TRendered {
    return this.formatter.formatContent(chatId, content, buttons);
  }

  // --- Error classification (OCP: platform-specific error handling) ---

  /**
   * Classify a platform-specific error into a typed BridgeError.
   * Override in subclass to handle platform-specific error formats.
   * Default implementation handles common network errors.
   */
  classifyError(err: unknown): BridgeError {
    return classifyDefaultError(err);
  }

  // --- Bot info (for status display) ---

  /**
   * Get bot information for display.
   * Override in subclass to return platform-specific bot info.
   */
  getBotInfo(): { appId?: string; name?: string } {
    return {};
  }
}
