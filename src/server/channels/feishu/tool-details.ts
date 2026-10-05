import { createHash, randomUUID } from 'node:crypto';
import type { Client } from '@larksuiteoapi/node-sdk';
import { redactSensitiveContent } from '../../../shared/utils/content-filter.js';
import { classifyDefaultError, type BridgeError } from '../errors.js';
import type { InboundMessage } from '../types.js';
import {
  buildFeishuButtonElements,
  buildFeishuCard,
  type FeishuCardElement,
} from './card-builder.js';
import {
  configureFeishuCardBudget,
  fitsFeishuCard,
  getFeishuCardBudget,
  planFeishuCards,
  type FeishuCardBudget,
} from './card-budget.js';
import { editFeishuMessage, sendFeishuMessage } from './sender.js';
import type { FeishuRenderedMessage } from './types.js';
import { isOversizedToolResult } from './tool-display.js';

/** Structural compatibility with ProgressData.timeline, including legacy result names. */
export interface FeishuToolDetailEntry {
  kind?: string;
  toolId?: string;
  toolName?: string;
  inputData?: unknown;
  toolInput?: string;
  input?: string;
  toolResult?: unknown;
  result?: unknown;
  status?: string;
  isError?: boolean;
}

export interface FeishuThinkingDetailEntry {
  thinkingId: string;
  text: string;
  status?: string;
}

export interface FeishuToolDetailsOptions {
  ttlMs?: number;
  maxEntries?: number;
  /** Retained UTF-8 data/offset/scope accounting plus binding reservations, not JS heap size. */
  maxBytes?: number;
  /** Both serialized card and API-envelope budgets; clamped to 3,000–16,000 bytes. */
  pageBytes?: number;
  maxSources?: number;
  maxPending?: number;
  cleanupIntervalMs?: number;
  now?: () => number;
  classifyError?: (error: unknown) => BridgeError;
}

type DetailMessage = FeishuRenderedMessage & { flowDetailUserId?: string };
type Outcome = 'success' | 'failed' | 'interrupted' | 'returned';
interface Scope {
  chatId: string;
  threadId?: string;
  ownerUserId: string;
  replyToMessageId: string;
  replyInThread: boolean;
  receiveIdType?: string;
}
interface Snapshot {
  readonly id: string;
  readonly key: string;
  readonly chatId: string;
  readonly kind: 'tool' | 'thinking';
  /** General full-result snapshots must not be evicted while their source card hides the result. */
  readonly fullResult?: boolean;
  /** Immutable for tools; only the latest redacted full source for thinking. */
  text: string;
  /** Trusted diff ranges in the redacted source; never inferred from source labels. */
  readonly diffRanges?: ReadonlyArray<readonly [number, number]>;
  /** Held separately until a confirmed close, including send retries. */
  frozenText?: string;
  readonly outcome: Outcome;
  readonly expiresAt: number;
  openGeneration: number;
  bytes: number;
  /** Prepaid upper bound for scope/sources/page offsets of a hidden full result. */
  bindingCredit?: number;
  scope?: Readonly<Scope>;
  sources: Set<string>;
  /** UTF-16 offsets are always at Unicode code-point boundaries; no copied page bodies. */
  pages?: ReadonlyArray<readonly [number, number]>;
  detail?: { messageId: string; page: number; state: 'open' | 'placeholder' | 'deleted' };
  /** Fixed once opened: existing navigation must not silently change page boundaries. */
  pageBudget?: string;
  tail: Promise<void>;
  pending: number;
}
interface Action {
  verb: 'open' | 'page' | 'close';
  id: string;
  page?: number;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const ACTION = new RegExp(`^flow_detail:(open|page|close):(${UUID})(?::(0|[1-9][0-9]{0,8}))?$`);
const EXPIRED = '详情快照已过期或服务已重启；请刷新原卡片或重新查询获取完整结果。';
const DENIED = '无权操作此详情，或卡片的聊天、话题、来源消息不匹配。';

function toast(type: 'success' | 'error', content: string): Record<string, unknown> {
  return { toast: { type, content } };
}

/** A rejection reaches the user only as a toast, so this line is the sole way to tell them apart. */
function rejected(verb: string, reason: string, content: string): Record<string, unknown> {
  console.warn(`[feishu] detail ${verb} rejected: ${reason}`);
  return toast('error', content);
}

function parseAction(value: string): Action | undefined {
  const match = ACTION.exec(value);
  if (!match) return undefined;
  const verb = match[1] as Action['verb'];
  if ((verb === 'page') !== (match[3] !== undefined)) return undefined;
  return { verb, id: match[2], page: match[3] === undefined ? undefined : Number(match[3]) };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Canonical serialization for identity; rejects cycles/non-JSON data rather than inventing it. */
function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  const normalize = (item: unknown, depth: number): unknown => {
    if (depth > 100) throw new Error('Snapshot nesting exceeds limit');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item !== 'object' || item === null || ancestors.has(item)) {
      throw new Error('Snapshot must be finite JSON data');
    }
    ancestors.add(item);
    const result = Array.isArray(item)
      ? item.map((child) => normalize(child, depth + 1))
      : Object.fromEntries(
          Object.keys(item)
            .sort()
            .filter((key) => (item as Record<string, unknown>)[key] !== undefined)
            .map((key) => [key, normalize((item as Record<string, unknown>)[key], depth + 1)]),
        );
    ancestors.delete(item);
    return result;
  };
  return JSON.stringify(normalize(value, 0));
}

function stringField(data: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    if (typeof data[name] === 'string') return data[name] as string;
  }
  return undefined;
}

function signedLines(text: string, prefix: '-' | '+'): string {
  // Empty snippets contain no lines. Preserve blank lines and trailing newlines
  // for non-empty snippets; the sign is display metadata, not file content.
  return text.length === 0
    ? ''
    : text
        .split('\n')
        .map((line) => `${prefix}${line}`)
        .join('\n');
}

interface DetailPart {
  text: string;
  diff?: boolean;
}

function editSections(input: unknown): DetailPart[][] {
  const sections: DetailPart[][] = [];
  const visit = (value: unknown, parentPath?: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, parentPath);
      return;
    }
    const data = object(value);
    if (!data) return;
    const path = stringField(data, ['file_path', 'path', 'filePath']) ?? parentPath;
    const oldText = stringField(data, ['old_string', 'oldText', 'old_text', 'oldString']);
    const newText = stringField(data, ['new_string', 'newText', 'new_text', 'newString']);
    const content = stringField(data, ['content', 'file_content', 'fileContent', 'file content']);
    if (oldText !== undefined || newText !== undefined) {
      const parts: DetailPart[] = [{ text: `${path ? `文件：${path}\n` : ''}替换片段：\n` }];
      for (const [snippet, sign] of [[oldText, '-'], [newText, '+']] as const) {
        if (snippet === undefined) continue;
        const text = signedLines(redactSensitiveContent(snippet), sign);
        if (!text) continue;
        if (parts.length > 1) parts.push({ text: '\n', diff: true });
        parts.push({ text, diff: true });
      }
      sections.push(parts);
    } else if (content !== undefined) {
      sections.push([
        { text: `${path ? `文件：${path}\n` : ''}写入：\n` },
        { text: signedLines(redactSensitiveContent(content), '+'), diff: true },
      ]);
    }
    for (const name of ['edits', 'changes', 'files', 'replacements']) {
      if (Array.isArray(data[name])) visit(data[name], path);
    }
  };
  visit(input);
  return sections;
}

function outcome(entry: FeishuToolDetailEntry): Outcome | undefined {
  const status = entry.status?.toLowerCase();
  if (['running', 'pending', 'queued', 'started', 'waiting'].includes(status ?? ''))
    return undefined;
  if (entry.isError || ['failed', 'error'].includes(status ?? '')) return 'failed';
  if (['interrupted', 'cancelled', 'canceled', 'aborted'].includes(status ?? ''))
    return 'interrupted';
  if (
    entry.isError === false ||
    ['completed', 'success', 'succeeded', 'done'].includes(status ?? '')
  ) {
    return 'success';
  }
  return 'returned';
}

function validIdentifier(value: string | undefined): value is string {
  return !!value && Buffer.byteLength(value, 'utf8') <= 512;
}

function openIds(message: DetailMessage): Set<string> {
  const ids = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const action = parseAction(value);
    if (action?.verb === 'open') ids.add(action.id);
  };
  for (const button of [...(message.feishuButtons ?? []), ...(message.buttons ?? [])]) {
    if (!button.url) add(button.callbackData);
  }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const item = object(value);
    if (!item) return;
    if (item.tag === 'button') {
      add(object(item.value)?.action);
      if (Array.isArray(item.behaviors)) {
        for (const behavior of item.behaviors) {
          const data = object(behavior);
          if (data?.type === 'callback') add(object(data.value)?.action);
        }
      }
    }
    for (const name of ['elements', 'columns', 'actions', 'body']) visit(item[name]);
  };
  visit(message.feishuElements);
  return ids;
}

/**
 * In-memory, owner-bound snapshots. No filesystem access and no model/query dispatch.
 * Call handle before the ordinary callback router; ANY non-undefined result is consumed.
 */
export class FeishuToolDetails {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly keys = new Map<string, string>();
  private readonly now: () => number;
  private readonly classifyError: (error: unknown) => BridgeError;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly pageBytes: number;
  private readonly maxSources: number;
  private readonly maxPending: number;
  private readonly timer?: ReturnType<typeof setInterval>;
  private retainedBytes = 0;
  private disposed = false;

  constructor(options: FeishuToolDetailsOptions = {}) {
    const positive = (value: number | undefined, fallback: number): number =>
      value !== undefined && Number.isFinite(value) && value > 0
        ? Math.max(1, Math.floor(value))
        : fallback;
    this.now = options.now ?? Date.now;
    this.classifyError = options.classifyError ?? classifyDefaultError;
    this.ttlMs = positive(options.ttlMs, 30 * 60_000);
    this.maxEntries = positive(options.maxEntries, 128);
    this.maxBytes = positive(options.maxBytes, 8 * 1024 * 1024);
    this.pageBytes = Math.max(3000, Math.min(16_000, positive(options.pageBytes, 16_000)));
    this.maxSources = Math.min(64, positive(options.maxSources, 32));
    this.maxPending = Math.min(32, positive(options.maxPending, 16));
    if (options.cleanupIntervalMs !== 0) {
      this.timer = setInterval(
        () => this.prune(),
        Math.min(this.ttlMs, positive(options.cleanupIntervalMs, 60_000)),
      );
      this.timer.unref();
    }
  }

  /** Read-only operational counters; no snapshot content is exposed. */
  get stats(): Readonly<{ entries: number; bytes: number }> {
    this.prune();
    return { entries: this.snapshots.size, bytes: this.retainedBytes };
  }

  register(chatId: string, entry: FeishuToolDetailEntry): string | undefined {
    this.prune();
    if (this.disposed || !validIdentifier(chatId) || !validIdentifier(entry.toolId))
      return undefined;
    const result = entry.toolResult !== undefined ? entry.toolResult : entry.result;
    const state = outcome(entry);
    // A completed flag alone is NOT a completed result snapshot. Empty string/null are real results.
    if (result === undefined || state === undefined || (entry.kind && entry.kind !== 'tool')) {
      return undefined;
    }
    try {
      const fullResult = isOversizedToolResult(result);
      let input = entry.inputData;
      if (input === undefined) {
        const raw = entry.toolInput ?? entry.input;
        if (!fullResult) {
          if (!raw) return undefined;
          input = JSON.parse(raw);
        } else if (raw !== undefined) {
          // Generic tools may supply plain input summaries rather than JSON.
          try {
            input = JSON.parse(raw);
          } catch {
            input = raw;
          }
        }
      }
      const serialized = canonicalJson({
        chatId,
        toolId: entry.toolId,
        toolName: entry.toolName ?? '',
        input,
        result,
        outcome: state,
        status: entry.status ?? '',
      });
      if (Buffer.byteLength(serialized, 'utf8') > this.maxBytes) return undefined;
      const key = createHash('sha256').update(serialized).digest('hex');
      const existing = this.keys.get(key);
      if (existing) {
        // A pending callback can pin an expired entry past prune. Never return a dead button.
        return this.snapshots.get(existing)!.expiresAt > this.now() ? existing : undefined;
      } // Rendering repeatedly must not renew TTL or allocate snapshots.
      // Clone via JSON first. Mutating the caller's input/results cannot change these strings.
      const cloned = JSON.parse(serialized) as {
        input: unknown;
        result: unknown;
        toolName: string;
      };
      const sections = fullResult ? [] : editSections(cloned.input);
      if (!fullResult && sections.length === 0) return undefined;
      const labels: Record<Outcome, string> = {
        success: '工具执行成功 · 本次改动',
        failed: '工具执行失败 · 拟改动内容',
        interrupted: '工具执行中断 · 拟改动内容',
        returned: '工具结果已返回',
      };
      const resultText =
        typeof cloned.result === 'string' ? cloned.result : JSON.stringify(cloned.result, null, 2);
      let text = '';
      const diffRanges: Array<readonly [number, number]> = [];
      const append = (part: DetailPart): void => {
        const value = redactSensitiveContent(part.text);
        const start = text.length;
        text += value;
        if (!part.diff || !value) return;
        const previous = diffRanges.at(-1);
        if (previous?.[1] === start)
          diffRanges[diffRanges.length - 1] = Object.freeze([previous[0], text.length]);
        else diffRanges.push(Object.freeze([start, text.length]));
      };
      if (fullResult) {
        const states: Record<Outcome, string> = {
          success: '工具执行成功',
          failed: '工具执行失败',
          interrupted: '工具执行中断',
          returned: '工具结果已返回',
        };
        const inputText =
          cloned.input === undefined
            ? '(未提供输入)'
            : typeof cloned.input === 'string'
              ? cloned.input
              : JSON.stringify(cloned.input, null, 2);
        append({
          text: `${states[state]}\n工具：${cloned.toolName}\n状态：${entry.status ?? state}\n\n工具输入快照：\n${inputText}`,
        });
      } else {
        append({ text: `${labels[state]}\n工具：${cloned.toolName}\n\n` });
        sections.forEach((section, index) => {
          if (index) append({ text: '\n\n' });
          section.forEach(append);
        });
      }
      append({ text: `\n\n工具结果快照：\n${resultText}` });
      const id = randomUUID();
      // Once the result leaves the card, later scope/offset allocation must not fail from
      // cache pressure. At worst there is one page per UTF-16 unit (+ the empty page),
      // all sources are 512 bytes and the bounded, JSON-escaped scope fits within 16 KiB.
      const bindingCredit = fullResult
        ? (text.length + 1) * 16 + this.maxSources * 512 + 16_384
        : 0;
      const bytes =
        Buffer.byteLength(text + id + key + chatId, 'utf8') +
        640 +
        diffRanges.length * 16 +
        bindingCredit;
      // Admission failure leaves the source renderer with its full result. Do not evict
      // other still-live snapshots just to publish a new button.
      if (!this.reserve(bytes, true, undefined, !fullResult)) return undefined;
      const snapshot: Snapshot = {
        id,
        key,
        chatId,
        kind: 'tool',
        fullResult,
        bindingCredit,
        text,
        diffRanges: Object.freeze(diffRanges),
        outcome: state,
        expiresAt: this.now() + this.ttlMs,
        openGeneration: 0,
        bytes,
        sources: new Set(),
        tail: Promise.resolve(),
        pending: 0,
      };
      this.snapshots.set(id, snapshot);
      this.keys.set(key, id);
      this.retainedBytes += bytes;
      return id;
    } catch {
      return undefined;
    }
  }

  /** Replace the live source, not its identity or an already-open browsing snapshot. */
  registerThinking(chatId: string, entry: FeishuThinkingDetailEntry): string | undefined {
    this.prune();
    if (
      this.disposed ||
      !validIdentifier(chatId) ||
      !validIdentifier(entry.thinkingId) ||
      typeof entry.text !== 'string'
    )
      return undefined;
    const key = `thinking:${createHash('sha256')
      .update(canonicalJson({ chatId, thinkingId: entry.thinkingId }))
      .digest('hex')}`;
    const text = redactSensitiveContent(entry.text);
    const textBytes = Buffer.byteLength(text, 'utf8');
    const existingId = this.keys.get(key);
    if (existingId) {
      const snapshot = this.snapshots.get(existingId)!;
      // Pending callbacks pin expired entries; never renew/rebind one while they finish.
      if (snapshot.expiresAt <= this.now()) return undefined;
      const extra = textBytes - Buffer.byteLength(snapshot.text, 'utf8');
      if (extra > 0 && !this.reserve(extra, false, snapshot.id)) return undefined;
      snapshot.text = text;
      snapshot.bytes += extra;
      this.retainedBytes += extra;
      return snapshot.id;
    }
    const id = randomUUID();
    const bytes = textBytes + Buffer.byteLength(id + key + chatId, 'utf8') + 640;
    if (!this.reserve(bytes, true)) return undefined;
    const snapshot: Snapshot = {
      id,
      key,
      chatId,
      kind: 'thinking',
      text,
      outcome: 'returned',
      expiresAt: this.now() + this.ttlMs,
      openGeneration: 0,
      bytes,
      sources: new Set(),
      tail: Promise.resolve(),
      pending: 0,
    };
    this.snapshots.set(id, snapshot);
    this.keys.set(key, id);
    this.retainedBytes += bytes;
    return id;
  }

  bind(message: DetailMessage, messageIds: string[]): void {
    this.prune();
    if (
      this.disposed ||
      !validIdentifier(message.flowDetailUserId) ||
      !validIdentifier(message.chatId) ||
      (message.threadId !== undefined && !validIdentifier(message.threadId)) ||
      (message.receiveIdType !== undefined && !validIdentifier(message.receiveIdType))
    )
      return;
    const sources = [...new Set(messageIds.filter(validIdentifier))].slice(0, this.maxSources);
    const replyToMessageId = message.replyToMessageId ?? sources[0];
    if (!validIdentifier(replyToMessageId) || sources.length === 0) return;
    if (message.threadId && message.replyInThread === false) return;
    const scope: Scope = {
      chatId: message.chatId,
      threadId: message.threadId,
      ownerUserId: message.flowDetailUserId,
      replyToMessageId,
      replyInThread: !!message.threadId || !!message.replyInThread,
      receiveIdType: message.receiveIdType,
    };
    for (const id of openIds(message)) {
      const snapshot = this.snapshots.get(id);
      if (!snapshot || snapshot.chatId !== message.chatId || snapshot.expiresAt <= this.now())
        continue;
      if (snapshot.scope && canonicalJson(snapshot.scope) !== canonicalJson(scope)) continue;
      const nextSources = new Set([...snapshot.sources, ...sources].slice(0, this.maxSources));
      // Thinking offsets are allocated only on open, against frozen text/client budgets.
      const pages =
        snapshot.pages ?? (snapshot.kind === 'tool' ? this.paginate(snapshot, scope) : undefined);
      if (snapshot.kind === 'tool' && !pages) continue;
      const extra =
        Buffer.byteLength(
          [...nextSources].filter((source) => !snapshot.sources.has(source)).join(''),
          'utf8',
        ) +
        (snapshot.scope
          ? 0
          : Buffer.byteLength(canonicalJson(scope), 'utf8') + (pages?.length ?? 0) * 16);
      if (!this.allocateMetadata(snapshot, extra)) continue;
      snapshot.scope ??= Object.freeze({ ...scope });
      snapshot.pages ??= pages;
      snapshot.sources = nextSources;
    }
  }

  async handle(
    message: InboundMessage,
    client: Client,
    authorized: boolean,
  ): Promise<Record<string, unknown> | undefined> {
    const callback = message.callbackData;
    if (!callback?.startsWith('flow_detail:')) return undefined;
    // Consume malformed detail callbacks too: they must never fall through to the model.
    const action = parseAction(callback);
    if (!action) return rejected('action', 'malformed-callback', '无效的详情操作。');
    if (!authorized) return rejected(action.verb, 'unauthorized-operator', DENIED);
    this.prune();
    const snapshot = this.snapshots.get(action.id);
    if (this.disposed) return rejected(action.verb, 'disposed', EXPIRED);
    if (!snapshot) return rejected(action.verb, 'unknown-snapshot', EXPIRED);
    if (snapshot.expiresAt <= this.now()) return rejected(action.verb, 'expired-snapshot', EXPIRED);
    const denial = this.permitDenial(snapshot, message, action);
    if (denial) return rejected(action.verb, denial, DENIED);
    if (snapshot.pending >= this.maxPending)
      return rejected(action.verb, 'queue-full', '详情正在处理，请稍后重试。');
    snapshot.pending++;
    const work = snapshot.tail.then(async () => {
      // Revalidate after waiting: a previous queued close/reopen may change the target.
      if (this.disposed || this.snapshots.get(action.id) !== snapshot)
        return rejected(action.verb, 'gone-after-queue', EXPIRED);
      if (snapshot.expiresAt <= this.now())
        return rejected(action.verb, 'expired-after-queue', EXPIRED);
      const queued = this.permitDenial(snapshot, message, action);
      if (queued) return rejected(action.verb, queued, DENIED);
      try {
        return await this.perform(snapshot, action, client);
      } catch (error) {
        // Never leak SDK payloads (which may include content, tokens, or unrelated IDs) in toasts.
        const reason = redactSensitiveContent(
          error instanceof Error ? error.message : String(error),
        ).slice(0, 200);
        console.warn(
          `[feishu] detail ${action.verb} failed: ${this.classifyError(error).name}: ${reason}`,
        );
        return toast(
          'error',
          action.verb === 'close'
            ? '详情关闭失败；撤回和已关闭占位更新均未成功，请重试。'
            : '详情操作失败，未确认完成；请重试。',
        );
      }
    });
    snapshot.tail = work.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await work;
    } finally {
      snapshot.pending--;
      this.prune();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.snapshots.clear();
    this.keys.clear();
    this.retainedBytes = 0;
  }

  /** Why this callback may not drive this snapshot, or undefined when it may. Reasons are log-only. */
  private permitDenial(
    snapshot: Snapshot,
    message: InboundMessage,
    action: Action,
  ): string | undefined {
    const scope = snapshot.scope;
    if (!scope) return 'never-bound';
    if (snapshot.kind === 'tool' && !snapshot.pages) return 'unpaginated';
    if (message.channelType !== 'feishu') return 'foreign-channel';
    if (message.chatId !== scope.chatId) return 'other-chat';
    if (message.threadId !== undefined && message.threadId !== scope.threadId) return 'other-topic';
    if (message.userId !== scope.ownerUserId) return 'other-owner';
    if (!message.messageId) return 'sourceless-callback';
    // card.action.trigger documents chat/message IDs, but not thread_id. The exact
    // server-bound source/detail message anchors its topic when that field is absent.
    // An explicitly conflicting topic is still rejected above; never route from callback data.
    if (action.verb === 'open')
      return snapshot.sources.has(message.messageId) ? undefined : 'foreign-source-message';
    return message.messageId === snapshot.detail?.messageId ? undefined : 'not-the-detail-message';
  }

  private async perform(
    snapshot: Snapshot,
    action: Action,
    client: Client,
  ): Promise<Record<string, unknown>> {
    const scope = snapshot.scope!;
    const budget = getFeishuCardBudget(client);
    const budgetKey = canonicalJson(budget);
    const detail = snapshot.detail;
    if (action.verb !== 'close') {
      if (snapshot.pageBudget && snapshot.pageBudget !== budgetKey) {
        throw new Error('Detail budget changed; refusing to reinterpret existing navigation');
      }
      if (snapshot.kind === 'thinking') {
        if (action.verb === 'open' && snapshot.frozenText === undefined) {
          const text = snapshot.text;
          const pages = this.paginate(snapshot, scope, budget, text);
          if (!pages) throw new Error('Thinking detail cannot fit the configured card budget');
          // Count both held contents even when the frozen text equals the live source.
          const extra = Buffer.byteLength(text, 'utf8') + pages.length * 16;
          if (!this.reserve(extra, false, snapshot.id)) {
            throw new Error('Thinking browsing snapshot budget exhausted');
          }
          snapshot.frozenText = text;
          snapshot.pages = pages;
          snapshot.pageBudget = budgetKey;
          snapshot.bytes += extra;
          this.retainedBytes += extra;
        }
      } else if (!snapshot.pageBudget) {
        // bind has no client. Finalize offsets against the actual configured client
        // before sending, otherwise the shared sender could emit overflow cards.
        const pages = this.paginate(snapshot, scope, budget);
        if (!pages) throw new Error('Detail cannot fit the configured card budget');
        const extra = (pages.length - snapshot.pages!.length) * 16;
        if (!this.allocateMetadata(snapshot, extra)) {
          throw new Error('Detail offset budget exhausted');
        }
        snapshot.pages = pages;
        snapshot.pageBudget = budgetKey;
      }
    }
    const safeClient = checkedClient(client, scope);
    if (action.verb === 'open') {
      if (detail?.state === 'open') return toast('success', '详情已打开，请查看原详情卡。');
      const card = this.card(snapshot, scope, 0, snapshot.pages!.length);
      if (detail?.state === 'placeholder') {
        await editFeishuMessage(safeClient, detail.messageId, card, this.classifyError);
        detail.state = 'open';
        detail.page = 0;
      } else {
        const result = await sendFeishuMessage(safeClient, card, this.classifyError);
        if (!result.success || !validIdentifier(result.messageId))
          throw new Error('No confirmed detail message');
        snapshot.detail = { messageId: result.messageId, page: 0, state: 'open' };
        // Detail IDs have a fixed accounting allowance in each snapshot's base bytes.
      }
      return toast('success', '详情已打开。');
    }
    if (!detail) return toast('error', DENIED);
    if (action.verb === 'page') {
      const page = action.page!;
      if (detail.state !== 'open' || !snapshot.pages || page >= snapshot.pages.length) {
        return toast('error', '详情已关闭或页码无效，请从原卡片重新打开。');
      }
      if (detail.page !== page) {
        await editFeishuMessage(
          safeClient,
          detail.messageId,
          this.card(snapshot, scope, page, snapshot.pages!.length),
          this.classifyError,
        );
        detail.page = page;
      }
      return toast('success', '详情页已更新。');
    }
    if (detail.state !== 'open') return toast('success', '详情已关闭。');
    try {
      const result = await client.im.message.delete({ path: { message_id: detail.messageId } });
      assertSdkSuccess(result);
      detail.state = 'deleted';
      snapshot.openGeneration++;
      this.releaseThinkingView(snapshot);
      return toast('success', '详情已撤回；平台可能保留撤回提示。');
    } catch {
      const placeholder: FeishuRenderedMessage = {
        ...scopeRoute(scope),
        feishuHeader: {
          template: 'blue',
          title: snapshot.kind === 'thinking' ? '思考详情' : '工具详情',
        },
        feishuElements: [
          plain(
            snapshot.kind === 'thinking'
              ? '思考详情已关闭；可从原卡片重新打开最新全文。'
              : '详情已关闭；可从原工具卡片重新打开。',
          ),
        ],
      };
      await editFeishuMessage(safeClient, detail.messageId, placeholder, this.classifyError);
      detail.state = 'placeholder';
      this.releaseThinkingView(snapshot);
    }
    return toast('success', '详情未能撤回，已更新为关闭占位；可从原卡片重新打开。');
  }

  private releaseThinkingView(snapshot: Snapshot): void {
    if (snapshot.kind !== 'thinking' || snapshot.frozenText === undefined) return;
    const bytes = Buffer.byteLength(snapshot.frozenText, 'utf8') + snapshot.pages!.length * 16;
    snapshot.frozenText = undefined;
    snapshot.pages = undefined;
    snapshot.pageBudget = undefined;
    snapshot.bytes -= bytes;
    // dispose may have cleared the store while a close SDK request was in flight.
    if (this.snapshots.get(snapshot.id) === snapshot) this.retainedBytes -= bytes;
  }

  private card(
    snapshot: Snapshot,
    scope: Scope,
    page: number,
    total: number,
    content?: string,
    offset?: number,
  ): FeishuRenderedMessage {
    const bounds = snapshot.pages?.[page];
    const text = snapshot.frozenText ?? snapshot.text;
    const body = content ?? (bounds ? text.slice(bounds[0], bounds[1]) : '');
    return {
      ...scopeRoute(scope),
      deliveryId: `${snapshot.id}:open:${snapshot.openGeneration}`,
      feishuHeader: {
        template: snapshot.outcome === 'failed' ? 'red' : 'blue',
        title:
          snapshot.kind === 'thinking'
            ? '思考详情 · 打开时快照'
            : snapshot.fullResult
              ? '工具详情 · 快照'
              : '工具编辑详情 · 快照',
      },
      feishuElements:
        snapshot.kind === 'thinking'
          ? [
              plain(
                `第 ${page + 1} / ${total} 页 · 只展示当前页 · 打开时冻结；关闭后重开查看最新全文`,
              ),
              plain(body),
            ]
          : [
              plain(`${page + 1} / ${total}`),
              ...editElements(snapshot, body, offset ?? bounds?.[0] ?? 0),
            ],
      feishuButtons: [
        ...(page > 0
          ? [{ label: '上一页', callbackData: `flow_detail:page:${snapshot.id}:${page - 1}` }]
          : []),
        ...(page + 1 < total
          ? [{ label: '下一页', callbackData: `flow_detail:page:${snapshot.id}:${page + 1}` }]
          : []),
        { label: '关闭详情', callbackData: `flow_detail:close:${snapshot.id}`, style: 'danger' },
      ],
    };
  }

  private paginate(
    snapshot: Snapshot,
    scope: Scope,
    budget?: FeishuCardBudget,
    text = snapshot.frozenText ?? snapshot.text,
  ): ReadonlyArray<readonly [number, number]> | undefined {
    const pages: Array<readonly [number, number]> = [];
    let start = 0;
    let end = 0;
    let size = 0;
    // Measure the worst page index and BOTH navigation buttons, not only the first page.
    const sample = this.card(snapshot, scope, 999_999_997, 999_999_999, '');
    const baseline = serializedBudget(sample);
    const limit = Math.min(this.pageBytes, budget?.maxBytes ?? this.pageBytes);
    // The shared planner reserves space for final status/footer changes.
    const plannerReserve = budget ? Math.min(512, Math.floor(budget.maxBytes * 0.15)) : 0;
    const available = limit - baseline - 64 - plannerReserve;
    if (budget && !fitsFeishuCard(serializedCard(sample), budget)) return undefined;
    if (available < 32) return undefined;
    // Outer API content is a JSON string containing card JSON. Count its double escaping.
    for (const point of text) {
      const cost = Buffer.byteLength(JSON.stringify(JSON.stringify(point)), 'utf8') - 6;
      if (end > start && size + cost > available) {
        pages.push(Object.freeze([start, end] as const));
        start = end;
        size = 0;
      }
      end += point.length;
      size += cost;
    }
    pages.push(Object.freeze([start, end] as const));
    const fits = (from: number, to: number, index: number, total: number): boolean => {
      const message = this.card(snapshot, scope, index, total, text.slice(from, to), from);
      const card = serializedCard(message);
      return (
        serializedBudget(message) <= limit &&
        (!budget ||
          (fitsFeishuCard(card, budget) && planFeishuCards(JSON.parse(card), budget).length === 1))
      );
    };
    // Synthetic fences and multiple metadata/code components have real costs. Shrink
    // failing candidates, never silently drop source or let the sender add sibling cards.
    const checked: Array<readonly [number, number]> = [];
    for (const [from, to] of pages) {
      let cursor = from;
      do {
        let stop = to;
        while (!fits(cursor, stop, 999_999_997, 999_999_999)) {
          let next = cursor + Math.floor((stop - cursor) / 2);
          if (
            next > cursor &&
            /[\uDC00-\uDFFF]/.test(text[next]) &&
            /[\uD800-\uDBFF]/.test(text[next - 1])
          )
            next--;
          if (next <= cursor) return undefined;
          stop = next;
        }
        checked.push(Object.freeze([cursor, stop] as const));
        cursor = stop;
      } while (cursor < to);
    }
    for (let index = 0; index < checked.length; index++) {
      if (!fits(checked[index][0], checked[index][1], index, checked.length)) return undefined;
    }
    return Object.freeze(checked);
  }

  private allocateMetadata(snapshot: Snapshot, extra: number): boolean {
    const credit = snapshot.bindingCredit ?? 0;
    // Keep the unused reservation until expiry: later bind calls may authorize more sources,
    // and the first click can require more offsets under the actual client's smaller budget.
    const charge = snapshot.fullResult ? Math.max(0, extra - credit) : extra;
    if (charge > 0 && !this.reserve(charge, false, snapshot.id, !snapshot.fullResult)) return false;
    if (snapshot.fullResult) snapshot.bindingCredit = Math.max(0, credit - extra);
    snapshot.bytes += charge;
    this.retainedBytes += charge;
    return true;
  }

  private remove(snapshot: Snapshot): void {
    this.snapshots.delete(snapshot.id);
    this.keys.delete(snapshot.key);
    this.retainedBytes -= snapshot.bytes;
  }

  private prune(): void {
    for (const snapshot of this.snapshots.values()) {
      if (snapshot.pending === 0 && snapshot.expiresAt <= this.now()) this.remove(snapshot);
    }
  }

  private reserve(bytes: number, newEntry: boolean, protectedId?: string, evict = true): boolean {
    if (bytes > this.maxBytes) return false;
    for (const snapshot of this.snapshots.values()) {
      if (
        this.retainedBytes + bytes <= this.maxBytes &&
        (!newEntry || this.snapshots.size < this.maxEntries)
      )
        break;
      if (evict && snapshot.pending === 0 && snapshot.id !== protectedId && !snapshot.fullResult)
        this.remove(snapshot);
    }
    return (
      this.retainedBytes + bytes <= this.maxBytes &&
      (!newEntry || this.snapshots.size < this.maxEntries)
    );
  }
}

/** Each page closes its own fence; only trusted ranges are Markdown. */
function editElements(snapshot: Snapshot, text: string, offset: number): FeishuCardElement[] {
  const elements: FeishuCardElement[] = [];
  let cursor = offset;
  const end = offset + text.length;
  for (const [from, to] of snapshot.diffRanges ?? []) {
    const start = Math.max(offset, from);
    const stop = Math.min(end, to);
    if (stop <= start) continue;
    if (start > cursor) elements.push(plain(text.slice(cursor - offset, start - offset)));
    const source = text.slice(start - offset, stop - offset);
    let length = 3;
    for (const match of source.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
    const fence = '`'.repeat(length);
    elements.push({ tag: 'markdown', content: `${fence}diff\n${source}\n${fence}` });
    cursor = stop;
  }
  if (cursor < end || elements.length === 0) elements.push(plain(text.slice(cursor - offset)));
  return elements;
}

function plain(content: string): FeishuCardElement {
  return { tag: 'div', text: { tag: 'plain_text', content } };
}

function scopeRoute(scope: Scope): FeishuRenderedMessage {
  return {
    chatId: scope.chatId,
    threadId: scope.threadId,
    receiveIdType: scope.receiveIdType,
    replyToMessageId: scope.replyToMessageId,
    replyInThread: scope.replyInThread,
    feishuSingleCard: true,
  };
}

function serializedCard(message: FeishuRenderedMessage): string {
  return buildFeishuCard({
    header: message.feishuHeader as Parameters<typeof buildFeishuCard>[0]['header'],
    elements: [
      ...((message.feishuElements ?? []) as FeishuCardElement[]),
      ...buildFeishuButtonElements(message.feishuButtons),
    ],
  });
}

function serializedBudget(message: FeishuRenderedMessage): number {
  const content = serializedCard(message);
  const envelope = {
    path: { message_id: message.replyToMessageId },
    params: { receive_id_type: message.receiveIdType ?? 'chat_id' },
    data: {
      receive_id: message.chatId,
      root_id: message.replyToMessageId,
      reply_in_thread: message.replyInThread,
      msg_type: 'interactive',
      uuid: '0'.repeat(36),
      content,
    },
  };
  return Math.max(
    Buffer.byteLength(content, 'utf8'),
    Buffer.byteLength(JSON.stringify(envelope), 'utf8'),
  );
}

function assertSdkSuccess(value: unknown): void {
  if (object(value)?.code !== 0) throw new Error('Feishu SDK did not confirm success');
}

/**
 * sender historically falls back from expired/unsupported thread replies into the chat.
 * This scoped facade forbids that fallback and checks SDK *resolved* errors for all writes.
 * It still uses the public send/edit functions and their shared capacity checks.
 */
const scopedClients = new WeakMap<Client, WeakMap<Scope, Client>>();
function checkedClient(client: Client, scope: Scope): Client {
  let cache = scopedClients.get(client);
  if (!cache) {
    cache = new WeakMap();
    scopedClients.set(client, cache);
  }
  const cached = cache.get(scope);
  if (cached) {
    configureFeishuCardBudget(cached, getFeishuCardBudget(client));
    return cached;
  }
  type Write = (request: any) => Promise<unknown>;
  const wrap =
    (operation: 'create' | 'reply' | 'patch'): Write =>
    async (request) => {
      if (
        operation === 'create' &&
        (scope.replyInThread || request.data?.root_id !== scope.replyToMessageId)
      ) {
        throw new Error('Refusing a detail send outside its bound reply route');
      }
      if (
        operation === 'reply' &&
        (request.path?.message_id !== scope.replyToMessageId ||
          request.data?.reply_in_thread !== scope.replyInThread)
      ) {
        throw new Error('Refusing a detail reply outside its bound route');
      }
      const result = await (client.im.message[operation] as Write)(request);
      assertSdkSuccess(result);
      const threadId = object(object(result)?.data)?.thread_id;
      if (
        operation === 'reply' &&
        scope.threadId &&
        threadId !== undefined &&
        threadId !== scope.threadId
      ) {
        throw new Error('Feishu returned a different detail thread');
      }
      return result;
    };
  const scopedClient = {
    im: {
      message: {
        create: wrap('create'),
        reply: wrap('reply'),
        patch: wrap('patch'),
        delete: async (request: any) => {
          const result = await client.im.message.delete(request);
          assertSdkSuccess(result);
          return result;
        },
      },
    },
  } as unknown as Client;
  configureFeishuCardBudget(scopedClient, getFeishuCardBudget(client));
  cache.set(scope, scopedClient);
  return scopedClient;
}
