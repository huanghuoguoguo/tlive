import type { PendingPermissions } from '../permissions/gateway.js';
import type { PermissionBroker } from '../permissions/broker.js';
import type { BaseChannelAdapter } from '../channels/base.js';
import { truncate } from '../utils/string.js';

/**
 * Coordinates all permission-related state and resolution logic.
 *
 * Owns the 6 Maps that track pending permissions, hook deduplication,
 * and message routing for permission flows.
 *
 * Extracted from BridgeManager to isolate permission bookkeeping.
 */
export class PermissionCoordinator {
  private gateway: PendingPermissions;
  private broker: PermissionBroker;

  /** Track pending SDK permission IDs per chat for text-based resolution (key: stateKey, value: permId) */
  private pendingSdkPerms = new Map<string, string>();
  /** Deduplicate hook permission resolutions (with timestamp for TTL cleanup) */
  private resolvedHookIds = new Map<string, number>();
  /** Store original permission card text for card updates after approval (with timestamp) */
  private hookPermissionTexts = new Map<string, { text: string; ts: number }>();
  /** Track permission messages for text-based approval */
  private permissionMessages = new Map<string, { permissionId: string; sessionId: string; timestamp: number }>();
  /** Latest permission per channel type for single-pending shortcut */
  private latestPermission = new Map<string, { permissionId: string; sessionId: string; messageId: string }>();
  /** Track hook messages for reply routing (permission-adjacent) */
  private hookMessages = new Map<string, { sessionId: string; timestamp: number }>();
  /** Store AskUserQuestion data for answer resolution */
  private hookQuestionData = new Map<string, { questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string }>; multiSelect: boolean }>; ts: number; contextSuffix?: string }>();

  /** Track multi-select toggled options per hookId (key: hookId, value: Set of selected indices) */
  private toggledSelections = new Map<string, Set<number>>();

  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  /** Dynamic session whitelist — tools approved via "Allow {tool}" button */
  private allowedTools = new Set<string>();
  /** Dynamic Bash prefix whitelist — commands approved via "Allow Bash(prefix *)" */
  private allowedBashPrefixes = new Set<string>();

  constructor(gateway: PendingPermissions, broker: PermissionBroker) {
    this.gateway = gateway;
    this.broker = broker;
  }

  /** Expose the PendingPermissions gateway instance */
  getGateway(): PendingPermissions {
    return this.gateway;
  }

  /** Expose the PermissionBroker instance */
  getBroker(): PermissionBroker {
    return this.broker;
  }

  // --- SDK permission tracking ---

  getPendingSdkPerm(chatKey: string): string | undefined {
    return this.pendingSdkPerms.get(chatKey);
  }

  setPendingSdkPerm(chatKey: string, permId: string): void {
    this.pendingSdkPerms.set(chatKey, permId);
  }

  clearPendingSdkPerm(chatKey: string): void {
    this.pendingSdkPerms.delete(chatKey);
  }

  // --- Parse permission text ---

  /** Parse text as a permission decision */
  parsePermissionText(text: string): string | null {
    const t = text.trim().toLowerCase();
    if (['allow', 'a', 'yes', 'y', '允许', '通过'].includes(t)) return 'allow';
    if (['deny', 'd', 'no', 'n', '拒绝', '否'].includes(t)) return 'deny';
    if (['always', '始终允许'].includes(t)) return 'allow_always';
    return null;
  }

  // --- SDK permission resolution ---

  /** Try to resolve an SDK permission via gateway for a given chat. Returns true if resolved. */
  tryResolveByText(chatKey: string, decision: string): boolean {
    const pendingPermId = this.pendingSdkPerms.get(chatKey);
    if (!pendingPermId) return false;
    const gwDecision = decision === 'deny' ? 'deny' as const
      : decision === 'allow_always' ? 'allow_always' as const
      : 'allow' as const;
    if (this.gateway.resolve(pendingPermId, gwDecision)) {
      this.pendingSdkPerms.delete(chatKey);
      return true;
    }
    return false;
  }

  // --- Hook message tracking ---

  /** Track a hook message for reply routing */
  trackHookMessage(messageId: string, sessionId: string): void {
    this.hookMessages.set(messageId, { sessionId: sessionId || '', timestamp: Date.now() });
  }

  /** Check if a message is a tracked hook message */
  isHookMessage(messageId: string): boolean {
    return this.hookMessages.has(messageId);
  }

  /** Get a hook message entry */
  getHookMessage(messageId: string): { sessionId: string; timestamp: number } | undefined {
    return this.hookMessages.get(messageId);
  }

  // --- Permission message tracking ---

  /** Track a permission message for text-based approval (Feishu) */
  trackPermissionMessage(messageId: string, permissionId: string, sessionId: string, channelType: string): void {
    this.permissionMessages.set(messageId, { permissionId, sessionId, timestamp: Date.now() });
    this.latestPermission.set(channelType, { permissionId, sessionId, messageId });
  }

  /** Get the latest pending AskUserQuestion for a channel type */
  getLatestPendingQuestion(channelType: string): { hookId: string; sessionId: string; messageId: string } | null {
    const latest = this.latestPermission.get(channelType);
    if (!latest) return null;
    // Check if this permission has question data (i.e., it's an AskUserQuestion)
    if (!this.hookQuestionData.has(latest.permissionId)) return null;
    // Check not already resolved
    if (this.resolvedHookIds.has(latest.permissionId)) return null;
    return {
      hookId: latest.permissionId,
      sessionId: latest.sessionId,
      messageId: latest.messageId,
    };
  }

  /** Store AskUserQuestion data for later answer resolution */
  storeQuestionData(hookId: string, questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string }>; multiSelect: boolean }>, contextSuffix?: string): void {
    this.hookQuestionData.set(hookId, { questions, ts: Date.now(), contextSuffix });
  }

  /** Get stored AskUserQuestion data (for option count validation) */
  getQuestionData(hookId: string): { questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string }>; multiSelect: boolean }> } | undefined {
    return this.hookQuestionData.get(hookId);
  }

  /** Store original permission card text for later card update */
  storeHookPermissionText(hookId: string, text: string): void {
    this.hookPermissionTexts.set(hookId, { text, ts: Date.now() });
    // Cleanup handled by periodic timer via startPruning()
  }

  /** Start periodic cleanup of stale entries (call from BridgeManager.start) */
  startPruning(intervalMs = 30 * 60 * 1000): void {
    this.stopPruning();
    this.pruneTimer = setInterval(() => this.pruneStaleEntries(), intervalMs);
  }

  /** Stop periodic cleanup (call from BridgeManager.stop) */
  stopPruning(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  /** Clean up stale entries older than 1 hour */
  pruneStaleEntries(): void {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [id, ts] of this.resolvedHookIds) {
      if (ts < cutoff) this.resolvedHookIds.delete(id);
    }
    for (const [id, entry] of this.hookPermissionTexts) {
      if (entry.ts < cutoff) this.hookPermissionTexts.delete(id);
    }
    for (const [id, entry] of this.hookQuestionData) {
      if (entry.ts < cutoff) {
        this.hookQuestionData.delete(id);
        this.toggledSelections.delete(id);
      }
    }
    // Also clean up hookMessages and permissionMessages (24h cutoff)
    const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
    for (const [id, entry] of this.hookMessages) {
      if (entry.timestamp < cutoff24h) this.hookMessages.delete(id);
    }
    for (const [id, entry] of this.permissionMessages) {
      if (entry.timestamp < cutoff24h) this.permissionMessages.delete(id);
    }
  }

  // --- Hook permission resolution (text-based) ---

  /** Find a hook permission entry for text-based resolution. Returns the entry or undefined. */
  findHookPermission(replyToMessageId: string | undefined, channelType: string): { permissionId: string; sessionId: string; timestamp: number } | undefined {
    let permEntry = replyToMessageId ? this.permissionMessages.get(replyToMessageId) : undefined;
    if (!permEntry) {
      if (this.permissionMessages.size === 1) {
        const latest = this.latestPermission.get(channelType);
        if (latest) permEntry = this.permissionMessages.get(latest.messageId);
      }
    }
    return permEntry;
  }

  /** Count of pending permission messages (used for "multiple pending" check) */
  pendingPermissionCount(): number {
    return this.permissionMessages.size;
  }

  /** Resolve a hook permission (simplified - Go Core removed) */
  async resolveHookPermission(permissionId: string, _decision: string, _channelType: string): Promise<void> {
    // Deduplicate: skip if already resolved (race between button and text)
    if (this.resolvedHookIds.has(permissionId)) return;
    this.resolvedHookIds.set(permissionId, Date.now());

    // Clean up tracking maps
    for (const [id, e] of this.permissionMessages) {
      if (e.permissionId === permissionId) this.permissionMessages.delete(id);
    }
    const latest = this.latestPermission.get(channelType);
    if (latest?.permissionId === permissionId) this.latestPermission.delete(channelType);
  }

  // --- Hook callback resolution (button-based) ---

  /** Handle hook button callback. Returns result for adapter to edit the card. */
  async resolveHookCallback(
    hookId: string,
    decision: string,
    sessionId: string,
    messageId: string,
    adapter: BaseChannelAdapter,
    chatId: string,
  ): Promise<boolean> {
    // Deduplicate: skip if already resolved
    if (this.resolvedHookIds.has(hookId)) return true;
    this.resolvedHookIds.set(hookId, Date.now());

    const resolution = decision === 'deny' ? 'denied' : 'approved';
    const labels: Record<string, string> = {
      allow: '✅ Allowed',
      allow_always: '📌 Always Allowed',
      deny: '❌ Denied',
    };
    const label = labels[decision] || '✅ Allowed';

    // AskUserQuestion cards use hookQuestionData, not hookPermissionTexts
    if (this.hookQuestionData.has(hookId)) {
      this.hookQuestionData.delete(hookId);
      const outMsg = adapter.format({
        type: 'cardResolution',
        chatId,
        data: {
          resolution: decision === 'deny' ? 'denied' : 'approved',
          label: decision === 'deny' ? '❌ Skipped' : label,
        },
      });
      await adapter.editMessage(chatId, messageId, outMsg);
    } else {
      const originalText = this.hookPermissionTexts.get(hookId)?.text || '';
      this.hookPermissionTexts.delete(hookId);
      const outMsg = adapter.format({
        type: 'cardResolution',
        chatId,
        data: {
          resolution,
          label,
          originalText,
        },
      });
      await adapter.editMessage(chatId, messageId, outMsg);
    }
    // Track confirmation message for reply routing
    if (sessionId) {
      this.trackHookMessage(messageId, sessionId);
    }
    return true;
  }

  /** Handle AskUserQuestion answer callback — resolve hook with selected answer */
  async resolveAskQuestion(
    hookId: string,
    optionIndex: number,
    sessionId: string,
    messageId: string,
    adapter: BaseChannelAdapter,
    chatId: string,
  ): Promise<boolean> {
    if (this.resolvedHookIds.has(hookId)) return true;
    // Mark resolved immediately to prevent double-click races (async yields below)
    this.resolvedHookIds.set(hookId, Date.now());

    const questionData = this.hookQuestionData.get(hookId);
    if (!questionData) {
      await adapter.send({ chatId, text: '❌ Question data not found' });
      return true;
    }

    const q = questionData.questions[0];
    const selected = q.options[optionIndex];
    if (!selected) {
      await adapter.send({ chatId, text: `❌ Invalid option (1-${q.options.length})` });
      return true;
    }

    const ctx = questionData.contextSuffix || '';
    this.hookQuestionData.delete(hookId);
    const outMsg = adapter.format({
      type: 'cardResolution',
      chatId,
      data: {
        resolution: 'selected',
        label: `✅ Selected: ${selected.label}`,
        contextSuffix: ctx ? ` Terminal${ctx}` : undefined,
      },
    });
    await adapter.editMessage(chatId, messageId, outMsg);
    if (sessionId) {
      this.trackHookMessage(messageId, sessionId);
    }
    return true;
  }

  /** Toggle a multi-select option. Returns the current selection set for re-rendering. */
  toggleMultiSelectOption(hookId: string, optionIndex: number): Set<number> | null {
    const questionData = this.hookQuestionData.get(hookId);
    if (!questionData) return null;
    const q = questionData.questions[0];
    if (!q || optionIndex < 0 || optionIndex >= q.options.length) return null;

    let selected = this.toggledSelections.get(hookId);
    if (!selected) {
      selected = new Set();
      this.toggledSelections.set(hookId, selected);
    }
    if (selected.has(optionIndex)) selected.delete(optionIndex);
    else selected.add(optionIndex);
    return selected;
  }

  /** Get current toggled selections for a hookId */
  getToggledSelections(hookId: string): Set<number> {
    return this.toggledSelections.get(hookId) ?? new Set();
  }

  /** Clean up toggle state and question data for a hookId */
  cleanupQuestion(hookId: string): void {
    this.hookQuestionData.delete(hookId);
    this.toggledSelections.delete(hookId);
  }

  /** Submit multi-select: resolve hook with all toggled options */
  async resolveMultiSelect(
    hookId: string,
    sessionId: string,
    messageId: string,
    adapter: BaseChannelAdapter,
    chatId: string,
  ): Promise<boolean> {
    if (this.resolvedHookIds.has(hookId)) return true;

    const questionData = this.hookQuestionData.get(hookId);
    if (!questionData) {
      await adapter.send({ chatId, text: '❌ Question data not found' });
      return true;
    }
    const selected = this.toggledSelections.get(hookId) ?? new Set<number>();
    if (selected.size === 0) {
      await adapter.send({ chatId, text: '⚠️ No options selected' });
      return true;
    }

    this.resolvedHookIds.set(hookId, Date.now());
    const q = questionData.questions[0];
    // Join selected labels with comma (per Claude Code docs)
    const selectedLabels = [...selected].sort((a, b) => a - b).map(i => q.options[i]?.label).filter(Boolean);

    const ctx = questionData.contextSuffix || '';
    this.hookQuestionData.delete(hookId);
    this.toggledSelections.delete(hookId);
    const outMsg = adapter.format({
      type: 'cardResolution',
      chatId,
      data: {
        resolution: 'answered',
        label: `✅ Selected: ${selectedLabels.join(', ')}`,
        contextSuffix: ctx ? ` Terminal${ctx}` : undefined,
      },
    });
    await adapter.editMessage(chatId, messageId, outMsg);
    if (sessionId) {
      this.trackHookMessage(messageId, sessionId);
    }
    return true;
  }

  /** Handle AskUserQuestion skip — resolve hook with allow + empty answers.
   *  Hook API has no "skip" concept: deny = hard error, allow + empty = graceful skip. */
  async resolveAskQuestionSkip(
    hookId: string,
    sessionId: string,
    messageId: string,
    adapter: BaseChannelAdapter,
    chatId: string,
  ): Promise<boolean> {
    if (this.resolvedHookIds.has(hookId)) return true;

    const questionData = this.hookQuestionData.get(hookId);
    if (!questionData) {
      await adapter.send({ chatId, text: '❌ Question data not found' });
      return true;
    }

    this.resolvedHookIds.set(hookId, Date.now());

    const ctx = questionData.contextSuffix || '';
    this.hookQuestionData.delete(hookId);
    const outMsg = adapter.format({
      type: 'cardResolution',
      chatId,
      data: {
        resolution: 'skipped',
        label: '⏭ Skipped',
        contextSuffix: ctx ? ` Terminal${ctx}` : undefined,
      },
    });
    await adapter.editMessage(chatId, messageId, outMsg);
    if (sessionId) {
      this.trackHookMessage(messageId, sessionId);
    }
    return true;
  }

  /** Handle AskUserQuestion free text reply — resolve hook with text as answer */
  async resolveAskQuestionWithText(
    hookId: string,
    text: string,
    sessionId: string,
    messageId: string,
    adapter: BaseChannelAdapter,
    chatId: string,
  ): Promise<boolean> {
    if (this.resolvedHookIds.has(hookId)) return true;

    const questionData = this.hookQuestionData.get(hookId);
    if (!questionData) {
      await adapter.send({ chatId, text: '❌ Question data not found' });
      return true;
    }

    this.resolvedHookIds.set(hookId, Date.now());

    const ctx = questionData.contextSuffix || '';
    this.hookQuestionData.delete(hookId);
    const outMsg = adapter.format({
      type: 'cardResolution',
      chatId,
      data: {
        resolution: 'answered',
        label: `✅ Answer: ${truncate(text, 50)}`,
        contextSuffix: ctx ? ` Terminal${ctx}` : undefined,
      },
    });
    await adapter.editMessage(chatId, messageId, outMsg);
    if (sessionId) {
      this.trackHookMessage(messageId, sessionId);
    }
    return true;
  }

  // --- Dynamic session whitelist ---

  /** Check if a tool is allowed by the dynamic session whitelist */
  isToolAllowed(toolName: string, toolInput: Record<string, unknown>): boolean {
    if (this.allowedTools.has(toolName)) return true;
    if (toolName === 'Bash') {
      const cmd = typeof toolInput.command === 'string' ? toolInput.command : '';
      const prefix = this.extractBashPrefix(cmd);
      if (prefix && this.allowedBashPrefixes.has(prefix)) return true;
    }
    return false;
  }

  /** Add a tool to the session whitelist */
  addAllowedTool(toolName: string): void {
    this.allowedTools.add(toolName);
  }

  /** Add a Bash command prefix to the session whitelist */
  addAllowedBashPrefix(prefix: string): void {
    this.allowedBashPrefixes.add(prefix);
  }

  /** Extract the first word of a Bash command as a prefix */
  extractBashPrefix(command: string): string {
    return command.trim().split(/\s+/)[0] || '';
  }

  /** Clear the dynamic session whitelist (called on /new or session expiry) */
  clearSessionWhitelist(): void {
    this.allowedTools.clear();
    this.allowedBashPrefixes.clear();
  }

  // --- Broker callback delegation ---

  /** Delegate to broker for perm:allow/deny/allow_session callbacks */
  handleBrokerCallback(callbackData: string): boolean {
    return this.broker.handlePermissionCallback(callbackData);
  }
}