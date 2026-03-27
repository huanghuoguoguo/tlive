# IM Display Redesign — "Clean Result" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the terminal-card tree renderer with a clean, counter-based message renderer that shows real-time tool counts during execution and a polished response when done.

**Architecture:** New `MessageRenderer` class replaces `TerminalCardRenderer`. Same flush/editMessage lifecycle, but renders tool counters (`🖥 Bash ×3 · 📖 Read ×2`) instead of tool trees. Permission morphs the same message inline. Bridge-manager wiring updated to match new API.

**Tech Stack:** TypeScript, Vitest, Zod (unchanged), grammy/discord.js/@larksuiteoapi/node-sdk (unchanged)

---

### Task 1: Create MessageRenderer with tests

**Files:**
- Create: `bridge/src/engine/message-renderer.ts`
- Create: `bridge/src/__tests__/message-renderer.test.ts`

- [ ] **Step 1: Write the core test file**

```typescript
// bridge/src/__tests__/message-renderer.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageRenderer } from '../engine/message-renderer.js';
import type { UsageStats } from '../engine/cost-tracker.js';

describe('MessageRenderer', () => {
  let flushCallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    flushCallback = vi.fn().mockImplementation((_content: string, isEdit: boolean) => {
      if (!isEdit) return Promise.resolve('msg-1');
      return Promise.resolve();
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createRenderer(platformLimit = 4096) {
    return new MessageRenderer({
      platformLimit,
      throttleMs: 300,
      flushCallback: flushCallback as any,
    });
  }

  const defaultStats: UsageStats = {
    inputTokens: 9200,
    outputTokens: 2700,
    costUsd: 0.28,
    durationMs: 177000,
  };

  // ─── Phase 1: Executing ─────────────────────────

  describe('executing phase', () => {
    it('shows Starting... before any tool', async () => {
      const r = createRenderer();
      // Renderer starts in executing phase but with no tools
      // Manually trigger a flush to see the initial state
      r.onTextDelta(''); // no-op but starts the lifecycle
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      // No flush expected — renderer waits for first tool or text
      r.dispose();
    });

    it('shows tool counter after first tool starts', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      vi.advanceTimersByTime(1300); // 300ms throttle + 1s tick
      await vi.runAllTimersAsync();
      const content = flushCallback.mock.calls[0][0] as string;
      expect(content).toContain('⏳');
      expect(content).toContain('🖥️ Bash ×1');
      expect(content).toMatch(/\(1 tools? · \d+s\)/);
      r.dispose();
    });

    it('increments counter for same tool type', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      r.onToolStart('Bash');
      r.onToolStart('Bash');
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      const content = flushCallback.mock.calls[0][0] as string;
      expect(content).toContain('🖥️ Bash ×3');
      expect(content).toContain('(3 tools');
      r.dispose();
    });

    it('shows multiple tool types in order of first appearance', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      r.onToolStart('Read');
      r.onToolStart('Bash');
      r.onToolStart('Grep');
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      const content = flushCallback.mock.calls[0][0] as string;
      // Bash appeared first, then Read, then Grep
      const bashIdx = content.indexOf('Bash');
      const readIdx = content.indexOf('Read');
      const grepIdx = content.indexOf('Grep');
      expect(bashIdx).toBeLessThan(readIdx);
      expect(readIdx).toBeLessThan(grepIdx);
      expect(content).toContain('🖥️ Bash ×2');
      expect(content).toContain('📖 Read ×1');
      expect(content).toContain('🔍 Grep ×1');
      expect(content).toContain('(4 tools');
      r.dispose();
    });

    it('uses fallback icon for unknown tools', async () => {
      const r = createRenderer();
      r.onToolStart('CustomTool');
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      const content = flushCallback.mock.calls[0][0] as string;
      expect(content).toContain('🔧 CustomTool ×1');
      r.dispose();
    });

    it('throttles flushes to 300ms', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      r.onToolStart('Read');
      r.onToolStart('Bash');
      // Before throttle expires, no flush
      expect(flushCallback).not.toHaveBeenCalled();
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      // Exactly one flush with all accumulated state
      expect(flushCallback).toHaveBeenCalledTimes(1);
      r.dispose();
    });
  });

  // ─── Phase 2: Permission ─────────────────────────

  describe('permission phase', () => {
    it('morphs to permission request with buttons', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();

      const buttons = [
        { label: '✅ Yes', callbackData: 'perm:allow:123', style: 'primary' },
        { label: '❌ No', callbackData: 'perm:deny:123', style: 'danger' },
      ];
      r.onPermissionNeeded('Bash', 'npm test -- schema.test.ts', '123', buttons);
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();

      const lastCall = flushCallback.mock.calls[flushCallback.mock.calls.length - 1];
      const content = lastCall[0] as string;
      expect(content).toContain('🔐');
      expect(content).toContain('Bash');
      expect(content).toContain('npm test');
      expect(lastCall[2]).toEqual(buttons); // buttons passed through
      r.dispose();
    });

    it('restores tool counter after permission resolved', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      r.onToolStart('Read');
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();

      const buttons = [
        { label: '✅ Yes', callbackData: 'perm:allow:123', style: 'primary' },
        { label: '❌ No', callbackData: 'perm:deny:123', style: 'danger' },
      ];
      r.onPermissionNeeded('Bash', 'npm test', '123', buttons);
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();

      r.onPermissionResolved();
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();

      const lastCall = flushCallback.mock.calls[flushCallback.mock.calls.length - 1];
      const content = lastCall[0] as string;
      expect(content).toContain('⏳');
      expect(content).toContain('Bash ×1');
      expect(content).toContain('Read ×1');
      expect(content).not.toContain('🔐');
      expect(lastCall[2]).toBeUndefined(); // no buttons
      r.dispose();
    });
  });

  // ─── Phase 3: Done ─────────────────────────────

  describe('done phase', () => {
    it('renders response text with footer', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      r.onToolStart('Read');
      r.onTextDelta('Fixed the bug.');
      r.onComplete(defaultStats);
      await vi.runAllTimersAsync();

      const lastCall = flushCallback.mock.calls[flushCallback.mock.calls.length - 1];
      const content = lastCall[0] as string;
      expect(content).toContain('Fixed the bug.');
      expect(content).toContain('───');
      expect(content).toContain('🖥️ Bash ×1');
      expect(content).toContain('📖 Read ×1');
      expect(content).toContain('(2 total)');
      expect(content).toContain('📊');
      expect(content).toContain('$0.28');
      r.dispose();
    });

    it('renders empty response (no text, no separator)', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      r.onToolStart('Edit');
      r.onComplete(defaultStats);
      await vi.runAllTimersAsync();

      const lastCall = flushCallback.mock.calls[flushCallback.mock.calls.length - 1];
      const content = lastCall[0] as string;
      expect(content).not.toContain('───');
      expect(content).toContain('🖥️ Bash ×1');
      expect(content).toContain('✏️ Edit ×1');
      expect(content).toContain('📊');
      r.dispose();
    });

    it('renders stopped state', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      r.onToolStart('Bash');
      r.onToolStart('Bash');
      r.onError('stopped');
      await vi.runAllTimersAsync();

      const lastCall = flushCallback.mock.calls[flushCallback.mock.calls.length - 1];
      const content = lastCall[0] as string;
      expect(content).toContain('⚠️ Stopped');
      expect(content).toContain('───');
      expect(content).toContain('Bash ×3');
      r.dispose();
    });

    it('renders connection error without footer', async () => {
      const r = createRenderer();
      r.onError('Connection lost');
      await vi.runAllTimersAsync();

      const lastCall = flushCallback.mock.calls[flushCallback.mock.calls.length - 1];
      const content = lastCall[0] as string;
      expect(content).toContain('❌');
      expect(content).toContain('Connection lost');
      expect(content).not.toContain('───');
      r.dispose();
    });

    it('does not count hidden tools', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      r.onToolStart('TodoWrite');
      r.onToolStart('TaskCreate');
      r.onToolStart('Read');
      r.onComplete(defaultStats);
      await vi.runAllTimersAsync();

      const lastCall = flushCallback.mock.calls[flushCallback.mock.calls.length - 1];
      const content = lastCall[0] as string;
      expect(content).toContain('Bash ×1');
      expect(content).toContain('Read ×1');
      expect(content).not.toContain('TodoWrite');
      expect(content).not.toContain('TaskCreate');
      expect(content).toContain('(2 total)');
      r.dispose();
    });
  });

  // ─── Flush mechanics ──────────────────────────

  describe('flush mechanics', () => {
    it('sends first flush as new message, subsequent as edits', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      expect(flushCallback.mock.calls[0][1]).toBe(false); // isEdit = false

      r.onToolStart('Read');
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      expect(flushCallback.mock.calls[1][1]).toBe(true); // isEdit = true
      r.dispose();
    });

    it('double-buffers concurrent flushes', async () => {
      let resolveFlush: () => void;
      const slowFlush = vi.fn().mockImplementation(() => {
        return new Promise<string>(resolve => {
          resolveFlush = () => resolve('msg-1');
        });
      });

      const r = new MessageRenderer({
        platformLimit: 4096,
        throttleMs: 300,
        flushCallback: slowFlush as any,
      });

      r.onToolStart('Bash');
      vi.advanceTimersByTime(300);
      await vi.advanceTimersByTimeAsync(0);

      // While first flush is pending, trigger another
      r.onToolStart('Read');
      vi.advanceTimersByTime(300);
      await vi.advanceTimersByTimeAsync(0);

      // Resolve first flush — second should follow
      resolveFlush!();
      await vi.runAllTimersAsync();

      expect(slowFlush).toHaveBeenCalledTimes(2);
      r.dispose();
    });
  });

  // ─── Elapsed time ──────────────────────────────

  describe('elapsed time', () => {
    it('updates elapsed time every second', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      const first = flushCallback.mock.calls[0][0] as string;

      vi.advanceTimersByTime(3000); // 3 seconds
      await vi.runAllTimersAsync();
      const later = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;

      // Time should have advanced
      expect(first).toMatch(/0s|1s/);
      expect(later).toMatch(/[3-4]s/);
      r.dispose();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd bridge && npx vitest run src/__tests__/message-renderer.test.ts`
Expected: FAIL — module `../engine/message-renderer.js` not found

- [ ] **Step 3: Write the MessageRenderer implementation**

```typescript
// bridge/src/engine/message-renderer.ts
import { CostTracker, type UsageStats } from './cost-tracker.js';
import { redactSensitiveContent } from './content-filter.js';
import { getToolIcon } from './tool-registry.js';

/** Tools hidden from display (internal bookkeeping tools) */
const HIDDEN_TOOLS = new Set([
  'ToolSearch', 'TodoRead', 'TodoWrite',
  'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskStop', 'TaskOutput',
]);

type Phase = 'executing' | 'permission' | 'done';

interface PermissionState {
  toolName: string;
  input: string;
  permId: string;
  buttons: Array<{ label: string; callbackData: string; style: string }>;
}

export interface MessageRendererOptions {
  platformLimit: number;
  throttleMs?: number;
  flushCallback: (content: string, isEdit: boolean, buttons?: Array<{ label: string; callbackData: string; style: string }>) => Promise<string | void>;
}

export class MessageRenderer {
  // Tool tracking — ordered map preserves insertion order
  private toolCounts = new Map<string, number>();
  private totalTools = 0;
  private phase: Phase = 'executing';
  private responseText = '';
  private costLine?: string;
  private errorMessage?: string;
  private pendingPermission?: PermissionState;

  // Flush state
  private _messageId?: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private startTime = Date.now();
  private platformLimit: number;
  private throttleMs: number;
  private flushCallback: MessageRendererOptions['flushCallback'];
  private flushing = false;
  private pendingFlush = false;

  get messageId(): string | undefined {
    return this._messageId;
  }

  constructor(options: MessageRendererOptions) {
    this.platformLimit = options.platformLimit;
    this.throttleMs = options.throttleMs ?? 300;
    this.flushCallback = options.flushCallback;
  }

  // ─── Events ────────────────────────────────────

  onToolStart(name: string): void {
    if (HIDDEN_TOOLS.has(name)) return;
    this.toolCounts.set(name, (this.toolCounts.get(name) ?? 0) + 1);
    this.totalTools++;

    // Start elapsed time ticker on first tool
    if (this.totalTools === 1) {
      this.startTime = Date.now();
      this.tickTimer = setInterval(() => this.scheduleFlush(), 1000);
    }

    this.scheduleFlush();
  }

  onToolComplete(_toolUseId: string): void {
    // No-op — counter already incremented on start
  }

  onPermissionNeeded(
    toolName: string,
    input: string,
    permId: string,
    buttons: Array<{ label: string; callbackData: string; style: string }>,
  ): void {
    this.phase = 'permission';
    this.pendingPermission = { toolName, input, permId, buttons };
    this.scheduleFlush();
  }

  onPermissionResolved(): void {
    this.phase = 'executing';
    this.pendingPermission = undefined;
    this.scheduleFlush();
  }

  onTextDelta(text: string): void {
    this.responseText += text;
  }

  onComplete(stats: UsageStats): void {
    this.phase = 'done';
    this.costLine = CostTracker.format(stats);
    this.stopTickTimer();
    this.cancelTimer();
    const content = this.render();
    this.doFlush(content);
  }

  onError(error: string): void {
    this.errorMessage = error;
    this.stopTickTimer();
    this.cancelTimer();
    const content = this.render();
    this.doFlush(content);
  }

  // ─── Accessors ─────────────────────────────────

  getResponseText(): string {
    return this.responseText;
  }

  dispose(): void {
    this.cancelTimer();
    this.stopTickTimer();
  }

  // ─── Render ────────────────────────────────────

  render(): string {
    // Connection error — no footer
    if (this.errorMessage && this.totalTools === 0) {
      return redactSensitiveContent(`❌ ${this.errorMessage}`);
    }

    // Stopped — show partial + footer
    if (this.errorMessage) {
      const parts: string[] = [];
      if (this.responseText.trim()) {
        parts.push(this.responseText.trim());
      } else {
        parts.push('⚠️ Stopped');
      }
      parts.push('───────────────');
      parts.push(this.formatToolSummary('total'));
      return redactSensitiveContent(parts.join('\n'));
    }

    // Permission phase
    if (this.phase === 'permission' && this.pendingPermission) {
      const p = this.pendingPermission;
      const inputTrunc = p.input.length > 80 ? p.input.slice(0, 77) + '...' : p.input;
      return redactSensitiveContent(`🔐 ${p.toolName}: ${inputTrunc}`);
    }

    // Done phase
    if (this.phase === 'done') {
      const parts: string[] = [];
      const hasText = this.responseText.trim().length > 0;

      if (hasText) {
        parts.push(this.responseText.trim());
        parts.push('───────────────');
      }

      parts.push(this.formatToolSummary('total'));
      if (this.costLine) parts.push(this.costLine);

      return redactSensitiveContent(parts.join('\n'));
    }

    // Executing phase
    if (this.totalTools === 0) {
      return '⏳ Starting...';
    }

    const elapsed = Math.round((Date.now() - this.startTime) / 1000);
    return redactSensitiveContent(
      `⏳ ${this.formatToolSummary('elapsed', elapsed)}`
    );
  }

  // ─── Helpers ───────────────────────────────────

  private formatToolSummary(mode: 'elapsed' | 'total', elapsedSec?: number): string {
    const parts: string[] = [];
    for (const [name, count] of this.toolCounts) {
      const icon = getToolIcon(name);
      parts.push(`${icon} ${name} ×${count}`);
    }

    const summary = parts.join(' · ');
    if (mode === 'total') {
      return `${summary} (${this.totalTools} total)`;
    }

    const sec = elapsedSec ?? Math.round((Date.now() - this.startTime) / 1000);
    const timeStr = sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
    return `${summary} (${this.totalTools} tools · ${timeStr})`;
  }

  // ─── Flush mechanics ───────────────────────────

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const content = this.render();
      this.doFlush(content);
    }, this.throttleMs);
  }

  private cancelTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private stopTickTimer(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private async doFlush(content: string): Promise<void> {
    if (!content) return;
    if (this.flushing) {
      this.pendingFlush = true;
      return;
    }
    this.flushing = true;
    try {
      const isEdit = !!this._messageId;
      const buttons = this.pendingPermission?.buttons;
      const result = await this.flushCallback(content, isEdit, buttons);
      if (!isEdit && typeof result === 'string') {
        this._messageId = result;
      }
    } finally {
      this.flushing = false;
      if (this.pendingFlush) {
        this.pendingFlush = false;
        const retryContent = this.render();
        if (retryContent) await this.doFlush(retryContent);
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd bridge && npx vitest run src/__tests__/message-renderer.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add bridge/src/engine/message-renderer.ts bridge/src/__tests__/message-renderer.test.ts
git commit -m "feat: add MessageRenderer — counter-based tool display for IM"
```

---

### Task 2: Wire MessageRenderer into BridgeManager

**Files:**
- Modify: `bridge/src/engine/bridge-manager.ts`

This task replaces all `TerminalCardRenderer` usage with `MessageRenderer` in the bridge-manager. The key changes are in `handleInboundMessage()` where the renderer is created and wired.

- [ ] **Step 1: Write integration test**

```typescript
// Add to bridge/src/__tests__/message-renderer.test.ts at the end

describe('MessageRenderer integration', () => {
  it('full lifecycle: tools → permission → more tools → done', async () => {
    const r = createRenderer();

    // Tools
    r.onToolStart('Read');
    r.onToolStart('Read');
    r.onToolStart('Grep');
    vi.advanceTimersByTime(300);
    await vi.runAllTimersAsync();

    let content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
    expect(content).toContain('⏳');
    expect(content).toContain('Read ×2');
    expect(content).toContain('Grep ×1');

    // Permission
    const buttons = [
      { label: '✅ Yes', callbackData: 'perm:allow:abc', style: 'primary' },
      { label: '❌ No', callbackData: 'perm:deny:abc', style: 'danger' },
    ];
    r.onPermissionNeeded('Bash', 'npm test', 'abc', buttons);
    vi.advanceTimersByTime(300);
    await vi.runAllTimersAsync();

    content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
    expect(content).toContain('🔐');
    expect(content).toContain('Bash: npm test');

    // Resolve
    r.onPermissionResolved();
    r.onToolStart('Bash');
    vi.advanceTimersByTime(300);
    await vi.runAllTimersAsync();

    content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
    expect(content).toContain('⏳');
    expect(content).toContain('Bash ×1');
    expect(content).toContain('Read ×2');
    expect(content).toContain('(4 tools');

    // Complete
    r.onTextDelta('Done! Fixed the null check.');
    r.onComplete(defaultStats);
    await vi.runAllTimersAsync();

    content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
    expect(content).toContain('Done! Fixed the null check.');
    expect(content).toContain('───');
    expect(content).toContain('Bash ×1');
    expect(content).toContain('Read ×2');
    expect(content).toContain('Grep ×1');
    expect(content).toContain('(4 total)');
    expect(content).toContain('$0.28');

    r.dispose();
  });
});
```

- [ ] **Step 2: Run test to verify it passes with current implementation**

Run: `cd bridge && npx vitest run src/__tests__/message-renderer.test.ts`
Expected: PASS

- [ ] **Step 3: Update bridge-manager imports and renderer creation**

In `bridge/src/engine/bridge-manager.ts`, replace:

```typescript
// OLD
import { TerminalCardRenderer, type VerboseLevel } from './terminal-card-renderer.js';
```

with:

```typescript
// NEW
import { MessageRenderer } from './message-renderer.js';
```

Replace the renderer construction block (around line 516-569) — from `const platformLimits` through the end of `flushCallback`:

```typescript
    const platformLimits: Record<string, number> = { telegram: 4096, discord: 2000, feishu: 30000 };
    const renderer = new MessageRenderer({
      platformLimit: platformLimits[adapter.channelType] ?? 4096,
      throttleMs: 300,
      flushCallback: async (content, isEdit, buttons) => {
        // Feishu streaming path
        if (feishuSession) {
          if (!isEdit) {
            try {
              const messageId = await feishuSession.start(downgradeHeadings(content));
              clearInterval(typingInterval);
              return messageId;
            } catch {
              feishuSession = null;
            }
          } else {
            feishuSession.update(downgradeHeadings(content)).catch(() => {});
            return;
          }
        }
        // Non-streaming path
        let outMsg: OutboundMessage;
        if (adapter.channelType === 'telegram') {
          outMsg = { chatId: msg.chatId, html: markdownToTelegram(content), threadId };
        } else if (adapter.channelType === 'discord') {
          outMsg = { chatId: msg.chatId, text: content, threadId };
        } else {
          outMsg = { chatId: msg.chatId, text: content };
        }
        if (buttons?.length) {
          outMsg.buttons = buttons.map(b => ({ ...b, style: b.style as 'primary' | 'danger' | 'default' }));
        }
        if (!isEdit) {
          if (adapter.channelType === 'discord' && !threadId && 'createThread' in adapter) {
            const result = await adapter.send(outMsg);
            clearInterval(typingInterval);
            const preview = (msg.text || 'Claude').slice(0, 80);
            const newThreadId = await (adapter as any).createThread(msg.chatId, result.messageId, `💬 ${preview}`);
            if (newThreadId) {
              threadId = newThreadId;
              this.state.setThread(msg.channelType, msg.chatId, newThreadId);
            }
            return result.messageId;
          }
          const result = await adapter.send(outMsg);
          clearInterval(typingInterval);
          return result.messageId;
        } else {
          await adapter.editMessage(msg.chatId, renderer.messageId!, outMsg);
        }
      },
    });
```

Note: removed `feishuHeader` from non-streaming Feishu path — the new design has no card header. Removed `windowSize`, `verboseLevel` options — no longer needed.

- [ ] **Step 4: Update event callbacks**

Replace the event callbacks (around line 650-668) — simplify to match new API:

```typescript
        onTextDelta: (delta) => renderer.onTextDelta(delta),
        onToolStart: (event) => {
          renderer.onToolStart(event.name);
        },
        onToolResult: (_event) => {
          // No-op — MessageRenderer counts on start, not complete
        },
        onAgentStart: (_data) => {
          renderer.onToolStart('Agent');
        },
        onAgentProgress: (_data) => {
          // No-op — flat display
        },
        onAgentComplete: (_data) => {
          // No-op — flat display
        },
```

- [ ] **Step 5: Update verbose level 0 path**

The old code had separate level 0/1 paths. Now there's only one path. Replace the verbose-level-0 delivery block (around line 702-719):

```typescript
      // Deliver final response via delivery layer for long outputs
      if (!renderer.messageId) {
        // No message sent during execution (rare: zero tools, instant response)
        const responseText = renderer.getResponseText().trim() || result.text.trim();
        if (!completedStats) {
          const usage = {
            input_tokens: result.usage?.inputTokens ?? 0,
            output_tokens: result.usage?.outputTokens ?? 0,
            cost_usd: result.usage?.costUsd,
          };
          completedStats = costTracker.finish(usage);
        }
        const costLine = CostTracker.format(completedStats);
        const fullText = responseText ? `${responseText}\n${costLine}` : costLine;
        const deliverTarget = threadId && adapter.channelType === 'discord' ? threadId : msg.chatId;
        await this.delivery.deliver(adapter, deliverTarget, fullText, {
          platformLimit: platformLimits[adapter.channelType] ?? 4096,
        });
      }
```

Also update `onQueryResult`:

```typescript
        onQueryResult: (event) => {
          if (event.permissionDenials?.length) {
            console.warn(`[bridge] Permission denials: ${event.permissionDenials.map(d => d.toolName).join(', ')}`);
          }
          const usage = { input_tokens: event.usage.inputTokens, output_tokens: event.usage.outputTokens, cost_usd: event.usage.costUsd };
          completedStats = costTracker.finish(usage);
          renderer.onComplete(completedStats);
        },
```

- [ ] **Step 6: Remove unused imports and variables**

Remove:
- `windowSizes` constant
- `verboseLevel` variable usage (no longer passed to renderer)
- `toolIdMap` variable (no longer needed)
- `type VerboseLevel` from import

Keep the `verboseLevel` fetch for the state manager (it still controls future features).

- [ ] **Step 7: Run full test suite**

Run: `cd bridge && npx vitest run`
Expected: All tests PASS (some old terminal-card tests may fail — that's expected, handled in Task 4)

- [ ] **Step 8: Commit**

```bash
git add bridge/src/engine/bridge-manager.ts
git commit -m "feat: wire MessageRenderer into bridge-manager, replace TerminalCardRenderer"
```

---

### Task 3: Add permission timeout fallback

**Files:**
- Modify: `bridge/src/engine/message-renderer.ts`
- Modify: `bridge/src/__tests__/message-renderer.test.ts`

- [ ] **Step 1: Write timeout test**

Add to `message-renderer.test.ts` in the permission phase describe block:

```typescript
    it('emits timeout reminder after 60s', async () => {
      let reminderCalled = false;
      const r = new MessageRenderer({
        platformLimit: 4096,
        throttleMs: 300,
        flushCallback: flushCallback as any,
        onPermissionTimeout: (toolName, input, buttons) => {
          reminderCalled = true;
          expect(toolName).toBe('Bash');
          expect(input).toContain('npm test');
          expect(buttons).toHaveLength(2);
        },
      });

      r.onToolStart('Bash');
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();

      const buttons = [
        { label: '✅ Yes', callbackData: 'perm:allow:123', style: 'primary' },
        { label: '❌ No', callbackData: 'perm:deny:123', style: 'danger' },
      ];
      r.onPermissionNeeded('Bash', 'npm test', '123', buttons);

      // Before 60s — no reminder
      vi.advanceTimersByTime(59000);
      await vi.runAllTimersAsync();
      expect(reminderCalled).toBe(false);

      // At 60s — reminder fires
      vi.advanceTimersByTime(1000);
      await vi.runAllTimersAsync();
      expect(reminderCalled).toBe(true);

      r.onPermissionResolved();
      r.dispose();
    });

    it('does not fire timeout if permission resolved before 60s', async () => {
      let reminderCalled = false;
      const r = new MessageRenderer({
        platformLimit: 4096,
        throttleMs: 300,
        flushCallback: flushCallback as any,
        onPermissionTimeout: () => { reminderCalled = true; },
      });

      r.onToolStart('Bash');
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();

      const buttons = [
        { label: '✅ Yes', callbackData: 'perm:allow:123', style: 'primary' },
        { label: '❌ No', callbackData: 'perm:deny:123', style: 'danger' },
      ];
      r.onPermissionNeeded('Bash', 'npm test', '123', buttons);
      vi.advanceTimersByTime(30000);
      r.onPermissionResolved();
      vi.advanceTimersByTime(60000);
      await vi.runAllTimersAsync();
      expect(reminderCalled).toBe(false);

      r.dispose();
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd bridge && npx vitest run src/__tests__/message-renderer.test.ts`
Expected: FAIL — `onPermissionTimeout` not in options type

- [ ] **Step 3: Add timeout to MessageRenderer**

Add `onPermissionTimeout` to `MessageRendererOptions`:

```typescript
export interface MessageRendererOptions {
  platformLimit: number;
  throttleMs?: number;
  flushCallback: (content: string, isEdit: boolean, buttons?: Array<{ label: string; callbackData: string; style: string }>) => Promise<string | void>;
  /** Called when permission waits >60s without response */
  onPermissionTimeout?: (toolName: string, input: string, buttons: Array<{ label: string; callbackData: string; style: string }>) => void;
}
```

Add private field and wire it:

```typescript
  private onPermissionTimeout?: MessageRendererOptions['onPermissionTimeout'];
  private permissionTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: MessageRendererOptions) {
    // ... existing ...
    this.onPermissionTimeout = options.onPermissionTimeout;
  }
```

In `onPermissionNeeded`, after setting state, add:

```typescript
    // Start 60s timeout
    this.clearPermissionTimeout();
    if (this.onPermissionTimeout) {
      this.permissionTimeoutTimer = setTimeout(() => {
        if (this.pendingPermission) {
          this.onPermissionTimeout!(
            this.pendingPermission.toolName,
            this.pendingPermission.input,
            this.pendingPermission.buttons,
          );
        }
      }, 60_000);
    }
```

In `onPermissionResolved`, add:

```typescript
    this.clearPermissionTimeout();
```

Add helper:

```typescript
  private clearPermissionTimeout(): void {
    if (this.permissionTimeoutTimer) {
      clearTimeout(this.permissionTimeoutTimer);
      this.permissionTimeoutTimer = null;
    }
  }
```

In `dispose`, add: `this.clearPermissionTimeout();`

- [ ] **Step 4: Run tests**

Run: `cd bridge && npx vitest run src/__tests__/message-renderer.test.ts`
Expected: All PASS

- [ ] **Step 5: Wire timeout in bridge-manager**

In `bridge-manager.ts`, add `onPermissionTimeout` to the `MessageRenderer` constructor options:

```typescript
      onPermissionTimeout: async (toolName, input, buttons) => {
        const inputTrunc = input.length > 80 ? input.slice(0, 77) + '...' : input;
        const text = `⚠️ Permission pending — ${toolName}: ${inputTrunc}`;
        const chatId = threadId && adapter.channelType === 'discord' ? threadId : msg.chatId;
        await adapter.send({
          chatId,
          text: adapter.channelType === 'telegram' ? markdownToTelegram(text) : text,
          html: adapter.channelType === 'telegram' ? markdownToTelegram(text) : undefined,
          buttons: buttons.map(b => ({ ...b, style: b.style as 'primary' | 'danger' | 'default' })),
          threadId,
        }).catch(() => {});
      },
```

- [ ] **Step 6: Commit**

```bash
git add bridge/src/engine/message-renderer.ts bridge/src/__tests__/message-renderer.test.ts bridge/src/engine/bridge-manager.ts
git commit -m "feat: add 60s permission timeout fallback reminder"
```

---

### Task 4: Handle permission reminder resolution display

**Files:**
- Modify: `bridge/src/engine/bridge-manager.ts`

When a timeout reminder message is sent and later the permission is resolved (via the main message or the reminder's buttons), update the reminder to show `Bash: npm test ✅` or `Bash: npm test ❌`.

- [ ] **Step 1: Track reminder message ID in bridge-manager**

Add a variable before the renderer construction:

```typescript
    let permissionReminderMsgId: string | undefined;
    let permissionReminderTool: string | undefined;
    let permissionReminderInput: string | undefined;
```

In the `onPermissionTimeout` callback, capture the message ID:

```typescript
      onPermissionTimeout: async (toolName, input, buttons) => {
        permissionReminderTool = toolName;
        permissionReminderInput = input.length > 80 ? input.slice(0, 77) + '...' : input;
        const text = `⚠️ Permission pending — ${toolName}: ${permissionReminderInput}`;
        const chatId = threadId && adapter.channelType === 'discord' ? threadId : msg.chatId;
        try {
          const result = await adapter.send({
            chatId,
            text: adapter.channelType === 'telegram' ? markdownToTelegram(text) : text,
            html: adapter.channelType === 'telegram' ? markdownToTelegram(text) : undefined,
            buttons: buttons.map(b => ({ ...b, style: b.style as 'primary' | 'danger' | 'default' })),
            threadId,
          });
          permissionReminderMsgId = result.messageId;
        } catch { /* non-fatal */ }
      },
```

- [ ] **Step 2: Edit reminder on permission resolution**

In the `sdkPermissionHandler`, after `renderer.onPermissionResolved()`, add:

```typescript
          // Update timeout reminder message if it was sent
          if (permissionReminderMsgId) {
            const icon = result.behavior === 'deny' ? '❌' : '✅';
            const label = `${permissionReminderTool}: ${permissionReminderInput} ${icon}`;
            adapter.editMessage(msg.chatId, permissionReminderMsgId, {
              chatId: msg.chatId,
              text: label,
            }).catch(() => {});
            permissionReminderMsgId = undefined;
          }
```

- [ ] **Step 3: Run test suite**

Run: `cd bridge && npx vitest run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add bridge/src/engine/bridge-manager.ts
git commit -m "feat: update permission reminder message on resolution"
```

---

### Task 5: Clean up old TerminalCardRenderer

**Files:**
- Delete: `bridge/src/engine/terminal-card-renderer.ts`
- Rewrite: `bridge/src/__tests__/terminal-card-renderer.test.ts`

- [ ] **Step 1: Verify no remaining imports of TerminalCardRenderer**

Run: `cd bridge && grep -r "terminal-card-renderer\|TerminalCardRenderer" src/ --include='*.ts' -l`
Expected: Only `__tests__/terminal-card-renderer.test.ts` (if any)

- [ ] **Step 2: Delete old renderer**

```bash
rm bridge/src/engine/terminal-card-renderer.ts
```

- [ ] **Step 3: Delete or rename old test file**

```bash
rm bridge/src/__tests__/terminal-card-renderer.test.ts
```

- [ ] **Step 4: Run full test suite**

Run: `cd bridge && npx vitest run`
Expected: All PASS (old test file removed, no broken imports)

- [ ] **Step 5: Commit**

```bash
git add -u bridge/src/engine/terminal-card-renderer.ts bridge/src/__tests__/terminal-card-renderer.test.ts
git commit -m "chore: remove old TerminalCardRenderer and its tests"
```

---

### Task 6: Long output overflow handling

**Files:**
- Modify: `bridge/src/engine/bridge-manager.ts`

When the final rendered content exceeds platform limits, split the response and send overflow as additional messages with footer on the last one.

- [ ] **Step 1: Write overflow test**

Add to `message-renderer.test.ts`:

```typescript
  describe('platform limit overflow', () => {
    it('render returns content even when exceeding platform limit', async () => {
      const r = createRenderer(200); // very small limit
      const longText = 'A'.repeat(300);
      r.onToolStart('Bash');
      r.onTextDelta(longText);
      r.onComplete(defaultStats);
      await vi.runAllTimersAsync();

      const lastCall = flushCallback.mock.calls[flushCallback.mock.calls.length - 1];
      const content = lastCall[0] as string;
      // Renderer no longer truncates — bridge-manager handles overflow
      expect(content.length).toBeGreaterThan(200);
      expect(content).toContain(longText);
      r.dispose();
    });
  });
```

- [ ] **Step 2: Run test to verify it fails (renderer still truncates)**

Run: `cd bridge && npx vitest run src/__tests__/message-renderer.test.ts`
Expected: FAIL — old `applyPlatformLimit` truncates

Wait — the `MessageRenderer` from Task 1 doesn't have `applyPlatformLimit`. It delegates overflow to bridge-manager. So this test should PASS. Verify.

- [ ] **Step 3: Update bridge-manager flushCallback to handle overflow**

In the `flushCallback` of `MessageRenderer` construction in bridge-manager, modify the done-phase flush to handle overflow:

```typescript
      flushCallback: async (content, isEdit, buttons) => {
        // Check if content exceeds platform limit — split into chunks
        const limit = platformLimits[adapter.channelType] ?? 4096;
        if (!isEdit && content.length > limit) {
          // This is the final render — use delivery layer for chunking
          const deliverTarget = threadId && adapter.channelType === 'discord' ? threadId : msg.chatId;
          await this.delivery.deliver(adapter, deliverTarget, content, { platformLimit: limit });
          clearInterval(typingInterval);
          return 'overflow'; // Signal that message was sent
        }

        // ... rest of existing flushCallback ...
```

Actually, the flushCallback doesn't know the phase. Better approach: handle overflow in the bridge-manager after `renderer.onComplete()` fires, by checking if the rendered content exceeds limits. The simpler approach is to handle it in the `onQueryResult` callback.

Replace the approach: In `onQueryResult`, after `renderer.onComplete(completedStats)`, the flush is triggered internally. If the content is too long, the `doFlush` sends it as-is — and `editMessage` may fail or truncate on some platforms.

Better: remove `applyPlatformLimit` from `MessageRenderer` entirely (already done in Task 1). Then in bridge-manager's flushCallback, detect overflow and route to delivery layer:

In the flushCallback, wrap the edit path:

```typescript
        if (!isEdit) {
          // ... existing send logic (unchanged) ...
        } else {
          // Check if content exceeds platform limit
          const limit = platformLimits[adapter.channelType] ?? 4096;
          if (content.length > limit) {
            // Overflow: send remaining as new messages, footer on last
            const chunks = chunkByParagraph(content, limit);
            // Edit first chunk into existing message
            const firstOutMsg: OutboundMessage = adapter.channelType === 'telegram'
              ? { chatId: msg.chatId, html: markdownToTelegram(chunks[0]), threadId }
              : adapter.channelType === 'discord'
                ? { chatId: msg.chatId, text: chunks[0], threadId }
                : { chatId: msg.chatId, text: chunks[0] };
            await adapter.editMessage(msg.chatId, renderer.messageId!, firstOutMsg);
            // Send remaining chunks as new messages
            for (let i = 1; i < chunks.length; i++) {
              const target = threadId && adapter.channelType === 'discord' ? threadId : msg.chatId;
              const overflowMsg: OutboundMessage = adapter.channelType === 'telegram'
                ? { chatId: target, html: markdownToTelegram(chunks[i]) }
                : { chatId: target, text: chunks[i] };
              await adapter.send(overflowMsg);
            }
          } else {
            await adapter.editMessage(msg.chatId, renderer.messageId!, outMsg);
          }
        }
```

Add import at top of bridge-manager:

```typescript
import { chunkByParagraph } from '../delivery/delivery.js';
```

- [ ] **Step 4: Run full test suite**

Run: `cd bridge && npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bridge/src/engine/bridge-manager.ts bridge/src/__tests__/message-renderer.test.ts
git commit -m "feat: handle long output overflow with chunk splitting"
```

---

### Task 7: End-to-end manual verification

**Files:** None (manual testing)

- [ ] **Step 1: Run full test suite one final time**

Run: `cd bridge && npx vitest run`
Expected: All PASS, no skipped tests

- [ ] **Step 2: Verify no stale imports**

Run: `cd bridge && grep -r "TerminalCardRenderer\|terminal-card-renderer" src/ --include='*.ts'`
Expected: No results

- [ ] **Step 3: Verify TypeScript compilation**

Run: `cd bridge && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit any remaining fixes**

If any issues found, fix and commit with descriptive message.
