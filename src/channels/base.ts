import type {
  ChannelType,
  InboundMessage,
  RenderedMessage,
  SendResult,
  StreamingCardSession,
} from './types.js';
import type { CardResolutionData, FormattableMessage } from '../formatting/message-types.js';
import type { MessageFormatter } from '../formatting/message-formatter.js';
import type { Button } from '../ui/types.js';
import type { ProgressPhase, ProgressTraceStats, PermissionDecision } from '../ui/policy.js';
import type { ChannelPolicy } from '../ui/channel-policy.js';
import { DEFAULT_CHANNEL_POLICY } from '../ui/channel-policy.js';
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

  /** Create a streaming card/message session when the platform supports it. */
  createStreamingSession(
    _chatId: string,
    _receiveIdType?: string,
    _replyToMessageId?: string,
    _header?: { template: string; title: string },
  ): StreamingCardSession | null {
    return null;
  }

  /** Whether a rendered progress message should be split into a new bubble on this platform. */
  shouldSplitProgressMessage(_message: TRendered): boolean {
    return false;
  }

  // --- Capability checks ---

  /** Whether this platform supports pairing flow (requestPairing method). */
  supportsPairing(): boolean {
    return false;
  }

  /** Whether this platform supports streaming responses (streaming cards). */
  supportsStreaming(): boolean {
    return false;
  }

  // --- Policy support ---

  /** Platform behavior policy. Default is Telegram-like behavior. */
  protected policy: ChannelPolicy = DEFAULT_CHANNEL_POLICY;

  /** Set the policy for this adapter. */
  setPolicy(policy: ChannelPolicy): void {
    this.policy = policy;
  }

  /** Get the policy for this adapter. */
  getPolicy(): ChannelPolicy {
    return this.policy;
  }

  /** Whether this platform should render a progress update for the given phase. */
  shouldRenderProgressPhase(phase: ProgressPhase): boolean {
    return this.policy.progress.shouldRenderPhase(phase);
  }

  /** Whether a completed trace should be split into trace + summary cards. */
  shouldSplitCompletedTrace(stats: ProgressTraceStats): boolean {
    return this.policy.progress.shouldSplitCompletedTrace(stats);
  }

  /** Platform reaction set used for lifecycle/status updates. */
  getLifecycleReactions(): { processing: string; done: string; error: string; stalled: string; permission: string } {
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

  /** Send code output (bash command result, etc.) using platform-appropriate formatting. */
  async sendCodeOutput(chatId: string, text: string): Promise<SendResult> {
    const formatted = this.formatCodeOutput(text);
    // Use 'html' for Telegram (native HTML), 'text' for others
    if (this.channelType === 'telegram') {
      return this.send({ chatId, html: formatted } as TRendered);
    }
    return this.send({ chatId, text: formatted } as TRendered);
  }

  // --- Formatting support ---

  /** Platform-specific message formatter. Override in subclass. */
  protected formatter!: MessageFormatter<TRendered>;

  /** Set the formatter for this adapter */
  setFormatter(formatter: MessageFormatter<TRendered>): void {
    this.formatter = formatter;
  }

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

  /** Format raw markdown content into a platform-appropriate message (HTML for Telegram, text for others). */
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

  // --- Broadcast preparation (OCP: platform-specific broadcast handling) ---

  /**
   * Prepare a message for broadcast on this platform.
   * Override to add platform-specific fields (e.g., Feishu's receiveIdType).
   * Default implementation returns the message unchanged.
   */
  prepareBroadcast(msg: TRendered): TRendered {
    return msg;
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

// Use globalThis to share the registry across module instances (for dynamic imports)
const GLOBAL_KEY = '__tlive_adapter_registry__';

type AdapterRegistry = Map<ChannelType, () => BaseChannelAdapter>;

function getRegistry(): AdapterRegistry {
  if (!(globalThis as any)[GLOBAL_KEY]) {
    (globalThis as any)[GLOBAL_KEY] = new Map<ChannelType, () => BaseChannelAdapter>();
  }
  return (globalThis as any)[GLOBAL_KEY];
}

export function registerAdapterFactory(type: ChannelType, factory: () => BaseChannelAdapter): void {
  getRegistry().set(type, factory);
}

export function createAdapter(type: ChannelType): BaseChannelAdapter {
  const factory = getRegistry().get(type);
  if (!factory) throw new Error(`Unknown channel type: ${type}`);
  return factory();
}

export function getRegisteredTypes(): ChannelType[] {
  return Array.from(getRegistry().keys());
}
