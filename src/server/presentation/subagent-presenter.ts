import { createHash } from 'node:crypto';
import type { SubagentSnapshot } from '../../shared/canonical/schema.js';
import { shortPath } from '../../shared/core/path.js';
import type { ProgressData } from '../../shared/formatting/message-types.js';
import type { BaseChannelAdapter } from '../channels/base.js';
import { BridgeError, NetworkError, RateLimitError } from '../channels/errors.js';
import { FEISHU_SNAPSHOT_REFRESH_MS } from '../../shared/feishu-card-config.js';
import { withInboundReplyContext } from '../channels/reply-context.js';
import type { InboundMessage } from '../channels/types.js';
import { getToolIcon } from '../engine/sdk/tool-registry.js';

const UPDATE_INTERVAL_MS = FEISHU_SNAPSHOT_REFRESH_MS;
const MAX_RETRIES = 2;

type TimelineEntry = SubagentSnapshot['timeline'][number];

export interface SubagentFlowPresenterOptions {
  adapter: BaseChannelAdapter;
  inbound: InboundMessage;
  parentTurnId: string;
  cwd?: string;
  model?: string;
  onError?: (error: unknown) => void;
}

interface ChildFlow {
  deliveryId: string;
  messageId?: string;
  snapshot: SubagentSnapshot;
  startedAt: number;
  endedAt?: number;
  nextRequestAt: number;
  pending: boolean;
  inFlight?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  failures: number;
  error?: unknown;
  idleWaiters: Array<() => void>;
}

function isTerminal(status: SubagentSnapshot['status']): boolean {
  return status !== 'queued' && status !== 'running';
}

function identifier(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Own every nested input before asynchronous formatting/delivery can observe it. */
function freezeSnapshot(snapshot: SubagentSnapshot): SubagentSnapshot {
  const cloned = structuredClone(snapshot);
  const seen = new WeakSet<object>();
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  };
  freeze(cloned);
  return cloned;
}

function toolStatus(entry: TimelineEntry): NonNullable<TimelineEntry['status']> {
  return entry.status ?? (entry.toolResult === undefined ? 'running' : 'completed');
}

/** Independent latest-state, single-card streams; never shares the parent's message ID. */
export class SubagentFlowPresenter {
  private readonly adapter: BaseChannelAdapter;
  private readonly inbound: InboundMessage;
  private readonly parentTurnId: string;
  private readonly footerLine?: string;
  private readonly onError?: (error: unknown) => void;
  private readonly children = new Map<string, ChildFlow>();
  private closing = false;
  private disposed = false;
  private finishPromise?: Promise<void>;
  private disposePromise?: Promise<void>;

  constructor(options: SubagentFlowPresenterOptions) {
    this.adapter = options.adapter;
    // Routing/ACL comes exclusively from the trusted parent inbound, not child payloads.
    this.inbound = structuredClone(options.inbound);
    this.parentTurnId = options.parentTurnId;
    this.onError = options.onError;
    // options.model belongs to the parent turn, not the child. Until the snapshot carries
    // verified child model metadata, omit the label instead of misrepresenting an override.
    this.footerLine = options.cwd ? shortPath(options.cwd) : undefined;
  }

  update(snapshot: SubagentSnapshot): void {
    if (this.closing || this.disposed) return;
    const key = JSON.stringify([snapshot.parentToolUseId, snapshot.childId]);
    const existing = this.children.get(key);
    if (existing && isTerminal(existing.snapshot.status) && !isTerminal(snapshot.status)) return;
    let owned: SubagentSnapshot;
    try {
      owned = freezeSnapshot(existing && isTerminal(existing.snapshot.status)
        ? { ...snapshot, status: existing.snapshot.status, error: existing.snapshot.error ?? snapshot.error }
        : snapshot);
    } catch (error) {
      this.reportError(error);
      return;
    }
    const child = existing ?? {
      deliveryId: `${this.parentTurnId}:subagent:${identifier(key)}`,
      snapshot: owned,
      startedAt: Date.now(),
      nextRequestAt: 0,
      pending: false,
      failures: 0,
      idleWaiters: [],
    };
    child.snapshot = owned;
    if (isTerminal(owned.status)) child.endedAt ??= Date.now();
    child.pending = true;
    if (!existing) this.children.set(key, child);
    this.schedule(child);
  }

  /** Drain only this call's already-consumed states, without closing other child streams. */
  async flushTool(parentToolUseId: string): Promise<void> {
    const children = [...this.children.values()].filter(child => child.snapshot.parentToolUseId === parentToolUseId);
    for (const child of children) this.schedule(child);
    await Promise.all(children.map(child => this.waitForIdle(child)));
    const errors = children.filter(child => child.error !== undefined).map(child => child.error);
    if (errors.length) throw new AggregateError(errors, 'Subagent progress delivery failed');
  }

  /**
   * Seal all streams and await final deliveries, including bounded network retries.
   * Like the parent renderer, unfinished work is Stopped/Interrupted, never success.
   * The optional flag is compatible with callers passing the parent's stop state;
   * even finish(false) interrupts children still queued/running when the parent ends.
   * Rejects if a child's latest state remains undelivered; onError also reports attempts.
   */
  finish(_interrupted = false): Promise<void> {
    if (this.finishPromise) return this.finishPromise;
    if (this.disposed) return this.disposePromise ?? Promise.resolve();
    this.closing = true;
    for (const child of this.children.values()) {
      if (!isTerminal(child.snapshot.status)) {
        child.snapshot = freezeSnapshot({
          ...child.snapshot,
          status: 'interrupted',
          error: 'Interrupted',
          timeline: child.snapshot.timeline.map((entry) => ({
            ...entry,
            status: entry.status === 'running' ||
              (entry.kind === 'tool' && toolStatus(entry) === 'running')
              ? 'interrupted' : entry.status,
          })),
        });
        child.endedAt = Date.now();
        child.pending = true;
      }
      this.schedule(child);
    }
    this.finishPromise = Promise.all([...this.children.values()].map((child) => this.waitForIdle(child)))
      .then(() => {
        const errors = [...this.children.values()].filter((child) => child.error !== undefined)
          .map((child) => child.error);
        if (errors.length) throw new AggregateError(errors, 'Subagent progress delivery failed');
      });
    return this.finishPromise;
  }

  /** Cancel scheduled work; wait for already-issued requests, without creating final cards. */
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.closing = true;
    for (const child of this.children.values()) {
      if (child.timer !== undefined) clearTimeout(child.timer);
      child.timer = undefined;
      child.pending = false;
      this.notifyIdle(child);
    }
    this.disposePromise = Promise.all([...this.children.values()].map((child) => this.waitForIdle(child)))
      .then(() => { this.children.clear(); });
    return this.disposePromise;
  }

  private schedule(child: ChildFlow): void {
    if (this.disposed || child.inFlight || child.timer !== undefined || !child.pending) return;
    const delay = Math.max(0, child.nextRequestAt - Date.now());
    if (delay > 0) {
      child.timer = setTimeout(() => {
        child.timer = undefined;
        this.schedule(child);
      }, delay);
      return;
    }
    // Throttle from request start, not response arrival. A slow request has no backlog.
    child.nextRequestAt = Date.now() + UPDATE_INTERVAL_MS;
    child.pending = false;
    const snapshot = child.snapshot;
    child.inFlight = this.deliver(child, snapshot).finally(() => {
      child.inFlight = undefined;
      this.schedule(child);
      this.notifyIdle(child);
    });
  }

  private async deliver(child: ChildFlow, snapshot: SubagentSnapshot): Promise<void> {
    try {
      const data = this.progressData(child, snapshot);
      const message = {
        ...withInboundReplyContext(this.adapter.format({
          type: 'progress', chatId: this.inbound.chatId, data,
        }), this.inbound),
        deliveryId: child.deliveryId,
        flowDetailUserId: this.inbound.userId,
      };
      if (child.messageId !== undefined) {
        // No edit-to-send fallback: failures must not create a second logical flow.
        await this.adapter.editMessage(this.inbound.chatId, child.messageId, message);
      } else {
        const result = await this.adapter.send(message);
        if (!result.success || !result.messageId) {
          throw new NetworkError('Subagent send returned no confirmed message ID');
        }
        child.messageId = result.messageId;
      }
      child.failures = 0;
      child.error = undefined;
    } catch (error) {
      child.error = error;
      child.failures++;
      this.reportError(error);
      // The adapter's stable delivery ID also covers committed sends with lost responses.
      // Retrying always renders the newest snapshot, not a queued historical copy.
      const retry = this.retryPolicy(error);
      if (retry.delayMs > 0) child.nextRequestAt = Math.max(child.nextRequestAt, Date.now() + retry.delayMs);
      if (!this.disposed && child.failures <= MAX_RETRIES && retry.retryable) {
        child.pending = true;
      }
    }
  }

  private retryPolicy(error: unknown): { retryable: boolean; delayMs: number } {
    try {
      const classified = error instanceof BridgeError ? error : this.adapter.classifyError(error);
      return { retryable: classified.retryable, delayMs: classified instanceof RateLimitError
        ? Math.max(2000, classified.retryAfterMs) : 0 };
    } catch (classificationError) {
      this.reportError(classificationError);
      return { retryable: false, delayMs: 0 };
    }
  }

  private reportError(error: unknown): void {
    if (!this.onError) {
      console.warn('[subagent-presenter] progress delivery failed', error);
      return;
    }
    try {
      this.onError(error);
    } catch (handlerError) {
      console.warn('[subagent-presenter] error handler failed', handlerError, error);
    }
  }

  private waitForIdle(child: ChildFlow): Promise<void> {
    if (!child.inFlight && !child.pending && child.timer === undefined) return Promise.resolve();
    return new Promise((resolve) => { child.idleWaiters.push(resolve); });
  }

  private notifyIdle(child: ChildFlow): void {
    if (child.inFlight || child.pending || child.timer !== undefined) return;
    for (const resolve of child.idleWaiters.splice(0)) resolve();
  }

  private progressData(child: ChildFlow, snapshot: SubagentSnapshot): ProgressData {
    const terminal = isTerminal(snapshot.status);
    const timeline: NonNullable<ProgressData['timeline']> = snapshot.timeline.map((entry) => ({
      ...entry,
      blockId: `${child.deliveryId}:block:${identifier(entry.blockId)}`,
      toolId: entry.kind === 'tool'
        ? `${child.deliveryId}:tool:${identifier(entry.toolId ?? entry.blockId)}` : undefined,
      status: entry.kind === 'tool' ? toolStatus(entry) : entry.status,
      isError: entry.status === 'failed' || entry.status === 'interrupted',
    }));
    const tools = timeline.filter((entry) => entry.kind === 'tool');
    const counts = new Map<string, number>();
    for (const entry of tools) {
      const name = entry.toolName ?? '';
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const newestTools = [...tools].reverse();
    const current = terminal ? undefined : newestTools.find((entry) => entry.status === 'running');
    const errorMessage = snapshot.status === 'interrupted' ? snapshot.error || 'Interrupted'
      : snapshot.status === 'failed' ? snapshot.error ||
        newestTools.find((entry) => entry.status === 'failed')?.toolResult ||
        (this.adapter.getLocale() === 'zh' ? '子代理执行失败' : 'Subagent failed')
      : snapshot.error;
    return {
      subagent: {
        agentName: snapshot.agentName,
        task: snapshot.task,
        parentToolUseId: snapshot.parentToolUseId,
        childId: snapshot.childId,
      },
      turnId: child.deliveryId,
      phase: snapshot.status === 'queued' ? 'starting'
        : snapshot.status === 'running' ? 'executing'
        : snapshot.status === 'completed' ? 'completed' : 'failed',
      taskSummary: snapshot.task,
      elapsedSeconds: Math.floor(((child.endedAt ?? Date.now()) - child.startedAt) / 1000),
      // Only real timeline model text, never task/status placeholders or fake deltas.
      renderedText: timeline.filter((entry) => entry.kind === 'text').map((entry) => entry.text ?? '').join(''),
      thinkingText: timeline.filter((entry) => entry.kind === 'thinking').map((entry) => entry.text ?? '').join(''),
      timeline,
      toolLogs: tools.map((entry) => ({
        name: entry.toolName ?? '',
        input: entry.toolInput ?? '',
        toolId: entry.toolId,
        inputData: entry.inputData,
        status: entry.status,
        result: entry.toolResult,
        isError: entry.isError,
      })),
      currentTool: current ? { name: current.toolName ?? '', input: current.toolInput ?? '', elapsed: 0 } : null,
      totalTools: tools.length,
      toolSummary: [...counts].map(([name, count]) => `${getToolIcon(name)} ${name} ×${count}`).join(' · '),
      errorMessage,
      footerLine: this.footerLine,
      todoItems: [],
      // Children do not own session/stop/home buttons; details are added by the formatter.
      actionButtons: [],
    };
  }
}
