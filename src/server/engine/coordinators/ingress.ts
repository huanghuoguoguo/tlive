import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BaseChannelAdapter } from '../../channels/base.js';
import type { FileAttachment, InboundMessage } from '../../channels/types.js';
import { conversationScopeId } from '../../channels/conversation-context.js';
import { getTliveRuntimeDir } from '../../../shared/core/path.js';
import { chatKey as buildChatKey } from '../../../shared/core/key.js';

interface BufferedAttachments {
  attachments: FileAttachment[];
  timestamp: number;
}

interface IngressCoordinatorOptions {
  chatIdFile?: string;
  attachmentTtlMs?: number;
  persistDebounceMs?: number;
}

/**
 * Owns low-level ingress state that would otherwise bloat BridgeManager:
 * - last active chat tracking for automation routing
 * - attachment buffering/merge on multi-part IM messages
 * - long IM message coalescing with single-message pushback
 */
export class IngressCoordinator {
  private lastChatId = new Map<string, string>();
  private pendingAttachments = new Map<string, BufferedAttachments>();
  private coalescePushback = new Map<string, InboundMessage>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly chatIdFile: string;
  private readonly attachmentTtlMs: number;
  private readonly persistDebounceMs: number;

  private static readonly TG_MSG_LIMIT = 4096;
  private static readonly MAX_ATTACHMENTS = 5;
  private static readonly MAX_TOTAL_ATTACHMENT_BYTES = 10 * 1024 * 1024;

  constructor(options: IngressCoordinatorOptions = {}) {
    this.chatIdFile = options.chatIdFile ?? join(getTliveRuntimeDir(), 'chat-ids.json');
    this.attachmentTtlMs = options.attachmentTtlMs ?? 10 * 60_000;
    this.persistDebounceMs = options.persistDebounceMs ?? 1000;
    this.loadPersistedChatIds();
  }

  private loadPersistedChatIds(): void {
    try {
      const data = JSON.parse(readFileSync(this.chatIdFile, 'utf-8'));
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'string') {
          this.lastChatId.set(key, value);
        }
      }
    } catch {
      // No saved chat IDs yet.
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flushChatIds();
    }, this.persistDebounceMs);
  }

  private flushChatIds(): void {
    try {
      mkdirSync(dirname(this.chatIdFile), { recursive: true });
      writeFileSync(this.chatIdFile, JSON.stringify(Object.fromEntries(this.lastChatId)));
    } catch {
      // Non-fatal persistence failure.
    }
  }

  getLastChatId(channelType: string): string {
    return this.lastChatId.get(channelType) ?? '';
  }

  recordChat(channelType: string, chatId: string): void {
    this.lastChatId.set(channelType, chatId);
    this.schedulePersist();
  }

  recordDeliveryTarget(msg: InboundMessage): void {
    if (!msg.chatId) return;
    this.recordChat(msg.channelType, msg.chatId);
  }

  dispose(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      this.flushChatIds();
    }
  }

  pruneStaleState(): void {
    const now = Date.now();
    for (const [key, entry] of this.pendingAttachments) {
      if (now - entry.timestamp > this.attachmentTtlMs) {
        this.pendingAttachments.delete(key);
      }
    }
  }

  async getNextMessage(adapter: BaseChannelAdapter): Promise<InboundMessage | null> {
    const pushedBack = this.coalescePushback.get(adapter.channelType);
    if (pushedBack) {
      this.coalescePushback.delete(adapter.channelType);
      return pushedBack;
    }

    const next = await adapter.consumeOne();
    return next;
  }

  async coalesceMessages(
    adapter: BaseChannelAdapter,
    first: InboundMessage,
  ): Promise<InboundMessage> {
    if (!first.text || first.callbackData) return first;
    if (first.text.length < IngressCoordinator.TG_MSG_LIMIT - 200) return first;

    const parts: string[] = [first.text];
    const deadline = Date.now() + 500;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const next = await adapter.consumeOne();
      if (!next) continue;

      if (
        next.userId === first.userId &&
        conversationScopeId(next) === conversationScopeId(first) &&
        next.text &&
        !next.callbackData &&
        !next.text.startsWith('/')
      ) {
        parts.push(next.text);
        console.log(`[${adapter.channelType}] Coalesced message part (${next.text.length} chars)`);
      } else {
        this.coalescePushback.set(adapter.channelType, next);
        break;
      }
    }

    if (parts.length === 1) return first;
    console.log(
      `[${adapter.channelType}] Merged ${parts.length} message parts (${parts.reduce((sum, part) => sum + part.length, 0)} chars total)`,
    );
    return { ...first, text: parts.join('\n') };
  }

  /**
   * Feishu delivers each image of a multi-image post as its own attachment-only message,
   * so the buffer accumulates across messages until the text that gives them a question
   * arrives. Replacing it here would silently keep only the last image.
   */
  prepareAttachments(msg: InboundMessage): {
    handled: boolean;
    message: InboundMessage;
    droppedAttachments: number;
    keptAttachments: number;
  } {
    const key = this.attachmentKey(msg.channelType, conversationScopeId(msg));

    if (msg.attachments?.length && !msg.text && !msg.callbackData) {
      const pending = this.takePendingAttachments(key);
      const { kept, dropped } = this.fitAttachmentBudget([...pending, ...msg.attachments]);
      if (kept.length > 0) {
        this.pendingAttachments.set(key, {
          attachments: kept,
          // Refreshed per message: a burst of images must not expire between sends.
          timestamp: Date.now(),
        });
      }
      console.log(
        `[${msg.channelType}] Buffered ${kept.length} attachment(s), waiting for text${
          dropped > 0 ? ` (dropped ${dropped} over budget)` : ''
        }`,
      );
      return {
        handled: true,
        message: msg,
        droppedAttachments: dropped,
        keptAttachments: kept.length,
      };
    }

    if (msg.text && !msg.callbackData) {
      const pending = this.takePendingAttachments(key);
      if (pending.length > 0) {
        const { kept, dropped } = this.fitAttachmentBudget([
          ...pending,
          ...(msg.attachments || []),
        ]);
        console.log(
          `[${msg.channelType}] Merged ${pending.length} buffered attachment(s) with text`,
        );
        return {
          handled: false,
          message: { ...msg, attachments: kept },
          droppedAttachments: dropped,
          keptAttachments: kept.length,
        };
      }
    }

    return { handled: false, message: msg, droppedAttachments: 0, keptAttachments: 0 };
  }

  private attachmentKey(channelType: string, chatId: string): string {
    return buildChatKey(channelType, chatId);
  }

  /**
   * Drains the buffer for a chat. A buffer older than the TTL is discarded rather than
   * merged into an unrelated later message.
   */
  private takePendingAttachments(key: string): FileAttachment[] {
    const pending = this.pendingAttachments.get(key);
    if (!pending) return [];
    this.pendingAttachments.delete(key);
    if (Date.now() - pending.timestamp >= this.attachmentTtlMs) {
      console.log(
        `[ingress] Discarded ${pending.attachments.length} stale attachment(s) older than ${Math.round(
          this.attachmentTtlMs / 1000,
        )}s`,
      );
      return [];
    }
    return pending.attachments;
  }

  private fitAttachmentBudget(attachments: FileAttachment[]): {
    kept: FileAttachment[];
    dropped: number;
  } {
    let kept = attachments.slice(0, IngressCoordinator.MAX_ATTACHMENTS);
    const totalBytes = kept.reduce((sum, attachment) => sum + attachment.base64Data.length, 0);
    if (totalBytes <= IngressCoordinator.MAX_TOTAL_ATTACHMENT_BYTES) {
      return { kept, dropped: attachments.length - kept.length };
    }

    let budget = IngressCoordinator.MAX_TOTAL_ATTACHMENT_BYTES;
    kept = kept.filter((attachment) => {
      if (attachment.base64Data.length <= budget) {
        budget -= attachment.base64Data.length;
        return true;
      }
      return false;
    });
    console.warn(
      `[ingress] Attachment buffer exceeded 10MB limit, kept ${kept.length} of ${attachments.length}`,
    );
    return { kept, dropped: attachments.length - kept.length };
  }
}
