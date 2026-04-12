import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BaseChannelAdapter } from '../../channels/base.js';
import type { FileAttachment, InboundMessage } from '../../channels/types.js';
import { getTliveRuntimeDir } from '../../utils/path.js';

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
 * - last active chat tracking for hook routing
 * - attachment buffering/merge on multi-part IM messages
 * - long Telegram message coalescing with single-message pushback
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
    this.attachmentTtlMs = options.attachmentTtlMs ?? 60_000;
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
    return adapter.consumeOne();
  }

  async coalesceMessages(adapter: BaseChannelAdapter, first: InboundMessage): Promise<InboundMessage> {
    if (!first.text || first.callbackData) return first;
    if (first.text.length < IngressCoordinator.TG_MSG_LIMIT - 200) return first;

    const parts: string[] = [first.text];
    const deadline = Date.now() + 500;

    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const next = await adapter.consumeOne();
      if (!next) continue;

      if (next.userId === first.userId
        && next.chatId === first.chatId
        && next.text
        && !next.callbackData
        && !next.text.startsWith('/')) {
        parts.push(next.text);
        console.log(`[${adapter.channelType}] Coalesced message part (${next.text.length} chars)`);
      } else {
        this.coalescePushback.set(adapter.channelType, next);
        break;
      }
    }

    if (parts.length === 1) return first;
    console.log(`[${adapter.channelType}] Merged ${parts.length} message parts (${parts.reduce((sum, part) => sum + part.length, 0)} chars total)`);
    return { ...first, text: parts.join('\n') };
  }

  prepareAttachments(msg: InboundMessage): { handled: boolean; message: InboundMessage } {
    const key = this.attachmentKey(msg.channelType, msg.chatId);

    if (msg.attachments?.length && !msg.text && !msg.callbackData) {
      const attachments = this.fitAttachmentBudget(msg.attachments);
      if (attachments.length > 0) {
        this.pendingAttachments.set(key, {
          attachments,
          timestamp: Date.now(),
        });
        console.log(`[${msg.channelType}] Buffered ${attachments.length} attachment(s), waiting for text`);
      }
      return { handled: true, message: msg };
    }

    if (msg.text && !msg.callbackData) {
      const pending = this.pendingAttachments.get(key);
      if (pending && Date.now() - pending.timestamp < this.attachmentTtlMs) {
        console.log(`[${msg.channelType}] Merged ${pending.attachments.length} buffered attachment(s) with text`);
        const merged: InboundMessage = {
          ...msg,
          attachments: [...(msg.attachments || []), ...pending.attachments],
        };
        this.pendingAttachments.delete(key);
        return { handled: false, message: merged };
      }
      this.pendingAttachments.delete(key);
    }

    return { handled: false, message: msg };
  }

  private attachmentKey(channelType: string, chatId: string): string {
    return `${channelType}:${chatId}`;
  }

  private fitAttachmentBudget(attachments: FileAttachment[]): FileAttachment[] {
    let kept = attachments.slice(0, IngressCoordinator.MAX_ATTACHMENTS);
    const totalBytes = kept.reduce((sum, attachment) => sum + attachment.base64Data.length, 0);
    if (totalBytes <= IngressCoordinator.MAX_TOTAL_ATTACHMENT_BYTES) {
      return kept;
    }

    let budget = IngressCoordinator.MAX_TOTAL_ATTACHMENT_BYTES;
    kept = kept.filter(attachment => {
      if (attachment.base64Data.length <= budget) {
        budget -= attachment.base64Data.length;
        return true;
      }
      return false;
    });
    console.warn(`[ingress] Attachment buffer exceeded 10MB limit, kept ${kept.length}`);
    return kept;
  }
}
