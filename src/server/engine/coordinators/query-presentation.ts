import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage } from '../../channels/types.js';
import { FEISHU_MESSAGE_LIMIT } from '../../channels/limits.js';
import { withInboundReplyContext } from '../../channels/reply-context.js';
import { t } from '../../../shared/i18n/index.js';
import { buildProgressData } from '../messages/progress-builder.js';
import { MessageRenderer, type MessageRendererState } from '../messages/renderer.js';
import { QueryExecutionPresenter } from '../../presentation/query-presenter.js';

export interface QueryTypingHandle {
  stop(): void;
}

interface QueryPresentationFactoryOptions {
  defaultWorkdir: string;
  typingIntervalMs?: number;
}

interface QueryTurnPresentationOptions {
  adapter: BaseChannelAdapter;
  msg: InboundMessage;
  binding: { cwd?: string; sdkSessionId?: string };
  sessionKey: string;
  reactions: { permission: string; processing: string; stalled: string };
  typing: QueryTypingHandle;
  onMessageId: (messageId: string) => void;
}

export interface QueryTurnPresentation {
  renderer: MessageRenderer;
  presenter: QueryExecutionPresenter;
}

/** Owns per-turn IM presentation wiring: typing, renderer, presenter, reactions. */
export class QueryPresentationFactory {
  private readonly typingIntervalMs: number;

  constructor(private readonly options: QueryPresentationFactoryOptions) {
    this.typingIntervalMs = options.typingIntervalMs ?? 4000;
  }

  startTyping(adapter: BaseChannelAdapter, msg: InboundMessage): QueryTypingHandle {
    return new QueryTypingIndicator(adapter, msg.chatId, this.typingIntervalMs).start();
  }

  createTurn(options: QueryTurnPresentationOptions): QueryTurnPresentation {
    const { adapter, msg, binding, sessionKey, reactions, typing, onMessageId } = options;
    let stalledReactionAdded = false;
    let renderer!: MessageRenderer;
    const getProgressMessageId = (): string | undefined => renderer?.messageId;

    const presenter = new QueryExecutionPresenter({
      adapter,
      inbound: msg,
      platformLimit: FEISHU_MESSAGE_LIMIT,
      clearTyping: () => typing.stop(),
      getMessageId: getProgressMessageId,
      sessionKey,
      onMessageId,
    });

    renderer = new MessageRenderer({
      shouldSplitState: (state) => this.shouldSplitProgressBubble(adapter, msg, state),
      platformLimit: FEISHU_MESSAGE_LIMIT,
      throttleMs: 300,
      adaptiveFlush: {
        baseMs: 800,
        minMs: 800,
        maxMs: 4000,
        sizePenaltyStartBytes: 10 * 1024,
        largeSizePenaltyStartBytes: 20 * 1024,
        fastOutputCharsPerSec: 240,
        veryFastOutputCharsPerSec: 480,
        highLatencyMs: 600,
        rateLimitBackoffMs: 2000,
      },
      cwd: binding.cwd || this.options.defaultWorkdir,
      sessionId: binding.sdkSessionId,
      onPermissionReaction: () => {
        if (renderer.messageId) {
          adapter.addReaction(msg.chatId, renderer.messageId, reactions.permission).catch(() => {});
        }
      },
      onPermissionReactionClear: () => {
        if (renderer.messageId) {
          adapter.addReaction(msg.chatId, renderer.messageId, reactions.processing).catch(() => {});
        }
      },
      onProgressStalled: () => {
        if (renderer.messageId && !stalledReactionAdded) {
          stalledReactionAdded = true;
          adapter.addReaction(msg.chatId, renderer.messageId, reactions.stalled).catch(() => {});
        }
      },
      onProgressResumed: () => {
        if (renderer.messageId && stalledReactionAdded) {
          stalledReactionAdded = false;
          adapter.addReaction(msg.chatId, renderer.messageId, reactions.processing).catch(() => {});
        }
      },
      onFlushError: (error, context) => {
        const _locale = adapter.getLocale();
        const phaseText =
          context.phase === 'completed'
            ? t('progress.phaseCompleted')
            : context.phase === 'failed'
              ? t('progress.phaseFailed')
              : t('progress.phaseRunning');
        const notifyMsg = adapter.format({
          type: 'error',
          chatId: msg.chatId,
          data: {
            title: `${t('format.flushErrorTitle')} (${phaseText})`,
            message: `${(error.message || String(error)).slice(0, 150)}\n\n${t('format.flushErrorHint')}`,
          },
        });
        adapter.send(withInboundReplyContext(notifyMsg, msg)).catch(() => {});
      },
      flushCallback: (content, isEdit, buttons, state) =>
        presenter.flush(content, isEdit, buttons, state),
    });

    return { renderer, presenter };
  }

  private shouldSplitProgressBubble(
    adapter: BaseChannelAdapter,
    inbound: InboundMessage,
    state: MessageRendererState,
  ): boolean {
    const _locale = adapter.getLocale();
    const progressData = buildProgressData(state, inbound.text || t('format.continueTask'));
    const outMsg = adapter.format({ type: 'progress', chatId: inbound.chatId, data: progressData });
    return adapter.shouldSplitProgressMessage(outMsg);
  }
}

class QueryTypingIndicator implements QueryTypingHandle {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly adapter: BaseChannelAdapter,
    private readonly chatId: string,
    private readonly intervalMs: number,
  ) {}

  start(): this {
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.tick();
    return this;
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    this.adapter.sendTyping(this.chatId).catch(() => {});
  }
}
