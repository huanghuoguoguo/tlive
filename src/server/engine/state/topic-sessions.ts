import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentProviderKind } from '../../../shared/providers/kinds.js';
import { normalizeAgentProviderKind } from '../../../shared/providers/kinds.js';

export interface TopicSessionRecord {
  channelType: string;
  /** Real platform chat id used for sending messages. */
  chatId: string;
  /** Logical topic scope id, for example chat_id#thread:thread_id. */
  scopeId: string;
  threadId: string;
  rootMessageId?: string;
  lastMessageId?: string;
  sdkSessionId?: string;
  provider?: AgentProviderKind;
  clientId?: string;
  cwd?: string;
  title?: string;
  preview?: string;
  createdAt: string;
  updatedAt: string;
}

export type TopicSessionUpsert = Partial<Pick<TopicSessionRecord, 'createdAt' | 'updatedAt'>> &
  Omit<TopicSessionRecord, 'createdAt' | 'updatedAt'>;

/**
 * Persistent index from agent sessions to Feishu topics.
 *
 * ChannelBinding remains the internal runtime binding, but this index is the
 * user-facing conversation map: one provider session should continue in one topic.
 */
export class TopicSessionManager {
  private records = new Map<string, TopicSessionRecord>();
  private persistPath: string | undefined;

  constructor(runtimeDir?: string) {
    if (runtimeDir) {
      this.persistPath = join(runtimeDir, 'topic-sessions.json');
      this.loadPersisted();
    }
  }

  upsert(input: TopicSessionUpsert): TopicSessionRecord {
    const now = new Date().toISOString();
    if (input.sdkSessionId) {
      const inputProvider = normalizeAgentProviderKind(input.provider);
      for (const [scopeId, record] of this.records) {
        if (
          scopeId !== input.scopeId &&
          record.sdkSessionId === input.sdkSessionId &&
          normalizeAgentProviderKind(record.provider) === inputProvider
        ) {
          this.records.delete(scopeId);
        }
      }
    }

    const existing = this.records.get(input.scopeId);
    const record: TopicSessionRecord = {
      ...existing,
      ...input,
      createdAt: input.createdAt ?? existing?.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };
    this.records.set(record.scopeId, record);
    this.savePersisted();
    return record;
  }

  findByScope(scopeId: string): TopicSessionRecord | undefined {
    return this.records.get(scopeId);
  }

  findBySdkSessionId(sdkSessionId: string | undefined): TopicSessionRecord | undefined {
    if (!sdkSessionId) return undefined;
    for (const record of this.records.values()) {
      if (record.sdkSessionId === sdkSessionId) return record;
    }
    return undefined;
  }

  findBySdkSession(
    provider: AgentProviderKind | undefined,
    sdkSessionId: string | undefined,
  ): TopicSessionRecord | undefined {
    if (!sdkSessionId) return undefined;
    const expectedProvider = normalizeAgentProviderKind(provider);
    for (const record of this.records.values()) {
      if (
        record.sdkSessionId === sdkSessionId &&
        normalizeAgentProviderKind(record.provider) === expectedProvider
      ) {
        return record;
      }
    }
    return undefined;
  }

  listRecent(
    limit = 10,
    opts: { channelType?: string; chatId?: string } = {},
  ): TopicSessionRecord[] {
    return [...this.records.values()]
      .filter((record) => !opts.channelType || record.channelType === opts.channelType)
      .filter((record) => !opts.chatId || record.chatId === opts.chatId)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, limit);
  }

  count(opts: { channelType?: string; chatId?: string } = {}): number {
    return [...this.records.values()]
      .filter((record) => !opts.channelType || record.channelType === opts.channelType)
      .filter((record) => !opts.chatId || record.chatId === opts.chatId).length;
  }

  updateLastMessage(scopeId: string, messageId: string): void {
    const record = this.records.get(scopeId);
    if (!record) return;
    record.lastMessageId = messageId;
    record.updatedAt = new Date().toISOString();
    this.records.set(scopeId, record);
    this.savePersisted();
  }

  private loadPersisted(): void {
    if (!this.persistPath) return;
    try {
      const data: Record<string, TopicSessionRecord> = JSON.parse(
        readFileSync(this.persistPath, 'utf-8'),
      );
      for (const [scopeId, record] of Object.entries(data)) {
        if (
          record &&
          typeof record.chatId === 'string' &&
          typeof record.scopeId === 'string' &&
          typeof record.threadId === 'string'
        ) {
          this.records.set(scopeId, record);
        }
      }
    } catch {
      // File doesn't exist or is invalid.
    }
  }

  private savePersisted(): void {
    if (!this.persistPath) return;
    const data: Record<string, TopicSessionRecord> = {};
    for (const [scopeId, record] of this.records) {
      data[scopeId] = record;
    }
    try {
      mkdirSync(join(this.persistPath, '..'), { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
    } catch (err) {
      console.warn('[topic-session] Failed to persist state:', err);
    }
  }
}
