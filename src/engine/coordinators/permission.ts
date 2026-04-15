import type { PendingPermissions } from '../../permissions/gateway.js';
import type { PermissionBroker } from '../../permissions/broker.js';
import type { BaseChannelAdapter } from '../../channels/base.js';
import type { PermissionDecision as TextPermissionDecision } from '../../ui/policy.js';
import { SdkPermTracker } from './sdk-perm-tracker.js';
import { HookResolver } from './hook-resolver.js';
import { QuestionResolver } from './question-resolver.js';
import { SessionWhitelist } from './session-whitelist.js';

type PermissionDecision = TextPermissionDecision | 'cancelled';

/**
 * Coordinates all permission-related state and resolution logic.
 *
 * This is now a facade that delegates to specialized sub-components:
 * - SdkPermTracker: SDK permission tracking + text-based approval
 * - HookResolver: Hook deduplication + callback resolution
 * - QuestionResolver: AskUserQuestion + multi-select toggle
 * - SessionWhitelist: Dynamic tool/Bash prefix whitelist
 *
 * All public method signatures remain unchanged for backward compatibility.
 */
export class PermissionCoordinator {
  private sdkTracker: SdkPermTracker;
  private hookResolver: HookResolver;
  private questionResolver: QuestionResolver;
  private whitelist: SessionWhitelist;
  private broker: PermissionBroker;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(gateway: PendingPermissions, broker: PermissionBroker) {
    this.sdkTracker = new SdkPermTracker(gateway);
    this.hookResolver = new HookResolver();
    this.questionResolver = new QuestionResolver();
    this.whitelist = new SessionWhitelist();
    this.broker = broker;
  }

  // --- Sub-component accessors (for fine-grained access) ---

  get sdk(): SdkPermTracker {
    return this.sdkTracker;
  }

  get hooks(): HookResolver {
    return this.hookResolver;
  }

  get questions(): QuestionResolver {
    return this.questionResolver;
  }

  get sessionWhitelist(): SessionWhitelist {
    return this.whitelist;
  }

  // --- Gateway/Broker access (preserved for backward compatibility) ---

  getGateway(): PendingPermissions {
    return this.sdkTracker.getGateway();
  }

  getBroker(): PermissionBroker {
    return this.broker;
  }

  // --- SDK permission tracking (delegated to SdkPermTracker) ---

  getPendingSdkPerm(chatKey: string): string | undefined {
    return this.sdkTracker.getPendingSdkPerm(chatKey);
  }

  setPendingSdkPerm(chatKey: string, permId: string): void {
    this.sdkTracker.setPendingSdkPerm(chatKey, permId);
  }

  clearPendingSdkPerm(chatKey: string): void {
    this.sdkTracker.clearPendingSdkPerm(chatKey);
  }

  notePermissionPending(
    chatKey: string,
    permissionId: string,
    sessionId: string | undefined,
    toolName: string,
    input: string,
  ): void {
    this.sdkTracker.notePermissionPending(chatKey, permissionId, sessionId, toolName, input);
  }

  notePermissionResolved(
    chatKey: string,
    sessionId: string | undefined,
    toolName: string,
    decision: PermissionDecision,
    permissionId?: string,
  ): void {
    this.sdkTracker.notePermissionResolved(chatKey, sessionId, toolName, decision, permissionId);
  }

  clearPendingPermissionSnapshot(chatKey: string, permissionId?: string): void {
    this.sdkTracker.clearPendingPermissionSnapshot(chatKey, permissionId);
  }

  getPermissionStatus(chatKey: string, sessionId?: string): {
    rememberedTools: number;
    rememberedBashPrefixes: number;
    pending?: { toolName: string; input: string };
    lastDecision?: { toolName: string; decision: PermissionDecision };
  } {
    const status = this.sdkTracker.getPermissionStatus(chatKey, sessionId);
    // Fill in whitelist counts
    return {
      rememberedTools: this.whitelist.getAllowedToolsSize(sessionId),
      rememberedBashPrefixes: this.whitelist.getAllowedBashPrefixesSize(sessionId),
      pending: status.pending,
      lastDecision: status.lastDecision,
    };
  }

  parsePermissionText(text: string): TextPermissionDecision | null {
    return this.sdkTracker.parsePermissionText(text);
  }

  tryResolveByText(chatKey: string, decision: TextPermissionDecision): boolean {
    return this.sdkTracker.tryResolveByText(chatKey, decision);
  }

  // --- Hook message tracking (delegated to HookResolver) ---

  trackHookMessage(messageId: string, sessionId: string): void {
    this.hookResolver.trackHookMessage(messageId, sessionId);
  }

  isHookMessage(messageId: string): boolean {
    return this.hookResolver.isHookMessage(messageId);
  }

  getHookMessage(messageId: string): { sessionId: string; timestamp: number } | undefined {
    return this.hookResolver.getHookMessage(messageId);
  }

  // --- Permission message tracking (delegated to SdkPermTracker) ---

  trackPermissionMessage(messageId: string, permissionId: string, sessionId: string, channelType: string): void {
    this.sdkTracker.trackPermissionMessage(messageId, permissionId, sessionId, channelType);
  }

  getLatestPendingQuestion(channelType: string): { hookId: string; sessionId: string; messageId: string } | null {
    const latest = this.sdkTracker.getLatestPermission().get(channelType);
    if (!latest) return null;
    // Check if this permission has question data (i.e., it's an AskUserQuestion)
    if (!this.questionResolver.hasQuestionData(latest.permissionId)) return null;
    // Check not already resolved
    if (this.hookResolver.isResolved(latest.permissionId)) return null;
    return {
      hookId: latest.permissionId,
      sessionId: latest.sessionId,
      messageId: latest.messageId,
    };
  }

  // --- Question data (delegated to QuestionResolver) ---

  storeQuestionData(
    hookId: string,
    questions: Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect: boolean;
    }>,
    contextSuffix?: string,
  ): void {
    this.questionResolver.storeQuestionData(hookId, questions, contextSuffix);
  }

  getQuestionData(hookId: string): {
    questions: Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect: boolean;
    }>;
  } | undefined {
    return this.questionResolver.getQuestionData(hookId);
  }

  storeHookPermissionText(hookId: string, text: string): void {
    this.hookResolver.storeHookPermissionText(hookId, text);
  }

  // --- Pruning (delegates to all sub-components) ---

  startPruning(intervalMs = 30 * 60 * 1000): void {
    this.stopPruning();
    this.pruneTimer = setInterval(() => this.pruneStaleEntries(), intervalMs);
  }

  stopPruning(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  pruneStaleEntries(): void {
    this.sdkTracker.pruneStaleEntries();
    this.hookResolver.pruneStaleEntries();
    this.questionResolver.pruneStaleEntries();
  }

  // --- Hook permission resolution (delegated to SdkPermTracker + HookResolver) ---

  findHookPermission(
    replyToMessageId: string | undefined,
    channelType: string,
  ): { permissionId: string; sessionId: string; timestamp: number } | undefined {
    return this.sdkTracker.findHookPermission(replyToMessageId, channelType);
  }

  pendingPermissionCount(): number {
    return this.sdkTracker.pendingPermissionCount();
  }

  async resolveHookPermission(permissionId: string, decision: string, channelType: string): Promise<void> {
    await this.hookResolver.resolveHookPermission(permissionId, decision, channelType, {
      getPermissionMessages: () => this.sdkTracker.getPermissionMessages(),
      getLatestPermission: () => this.sdkTracker.getLatestPermission(),
      deletePermissionMessage: (id: string) => this.sdkTracker.getPermissionMessages().delete(id),
      deleteLatestPermission: (ct: string) => this.sdkTracker.getLatestPermission().delete(ct),
    });
  }

  // --- Hook callback resolution (delegated to HookResolver) ---

  async resolveHookCallback(
    hookId: string,
    decision: string,
    sessionId: string,
    messageId: string,
    adapter: BaseChannelAdapter,
    chatId: string,
  ): Promise<boolean> {
    return this.hookResolver.resolveHookCallback(hookId, decision, sessionId, messageId, adapter, chatId, {
      hasQuestionData: (id: string) => this.questionResolver.hasQuestionData(id),
      deleteQuestionData: (id: string) => this.questionResolver.deleteQuestionData(id),
    });
  }

  // --- AskUserQuestion resolution (delegated to QuestionResolver) ---

  async resolveAskQuestion(
    hookId: string,
    optionIndex: number,
    sessionId: string,
    messageId: string,
    adapter: BaseChannelAdapter,
    chatId: string,
  ): Promise<boolean> {
    return this.questionResolver.resolveAskQuestion(
      hookId,
      optionIndex,
      sessionId,
      messageId,
      adapter,
      chatId,
      {
        isResolved: (id: string) => this.hookResolver.isResolved(id),
        markResolved: (id: string) => this.hookResolver.markResolved(id),
        trackHookMessage: (id: string, sid: string) => this.hookResolver.trackHookMessage(id, sid),
      },
    );
  }

  toggleMultiSelectOption(hookId: string, optionIndex: number): Set<number> | null {
    return this.questionResolver.toggleMultiSelectOption(hookId, optionIndex);
  }

  getToggledSelections(hookId: string): Set<number> {
    return this.questionResolver.getToggledSelections(hookId);
  }

  cleanupQuestion(hookId: string): void {
    this.questionResolver.cleanupQuestion(hookId);
  }

  async resolveMultiSelect(
    hookId: string,
    sessionId: string,
    messageId: string,
    adapter: BaseChannelAdapter,
    chatId: string,
  ): Promise<boolean> {
    return this.questionResolver.resolveMultiSelect(
      hookId,
      sessionId,
      messageId,
      adapter,
      chatId,
      {
        isResolved: (id: string) => this.hookResolver.isResolved(id),
        markResolved: (id: string) => this.hookResolver.markResolved(id),
        trackHookMessage: (id: string, sid: string) => this.hookResolver.trackHookMessage(id, sid),
      },
    );
  }

  async resolveAskQuestionSkip(
    hookId: string,
    sessionId: string,
    messageId: string,
    adapter: BaseChannelAdapter,
    chatId: string,
  ): Promise<boolean> {
    return this.questionResolver.resolveAskQuestionSkip(
      hookId,
      sessionId,
      messageId,
      adapter,
      chatId,
      {
        isResolved: (id: string) => this.hookResolver.isResolved(id),
        markResolved: (id: string) => this.hookResolver.markResolved(id),
        trackHookMessage: (id: string, sid: string) => this.hookResolver.trackHookMessage(id, sid),
      },
    );
  }

  async resolveAskQuestionWithText(
    hookId: string,
    text: string,
    sessionId: string,
    messageId: string,
    adapter: BaseChannelAdapter,
    chatId: string,
  ): Promise<boolean> {
    return this.questionResolver.resolveAskQuestionWithText(
      hookId,
      text,
      sessionId,
      messageId,
      adapter,
      chatId,
      {
        isResolved: (id: string) => this.hookResolver.isResolved(id),
        markResolved: (id: string) => this.hookResolver.markResolved(id),
        trackHookMessage: (id: string, sid: string) => this.hookResolver.trackHookMessage(id, sid),
      },
    );
  }

  // --- Dynamic session whitelist (delegated to SessionWhitelist) ---

  isToolAllowed(sessionId: string | undefined, toolName: string, toolInput: Record<string, unknown>): boolean {
    return this.whitelist.isToolAllowed(sessionId, toolName, toolInput);
  }

  addAllowedTool(sessionId: string | undefined, toolName: string): void {
    this.whitelist.addAllowedTool(sessionId, toolName);
  }

  addAllowedBashPrefix(sessionId: string | undefined, prefix: string): void {
    this.whitelist.addAllowedBashPrefix(sessionId, prefix);
  }

  rememberSessionAllowance(
    sessionId: string | undefined,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): void {
    this.whitelist.rememberSessionAllowance(sessionId, toolName, toolInput);
  }

  extractBashPrefix(command: string): string {
    return this.whitelist.extractBashPrefix(command);
  }

  clearSessionWhitelist(sessionId?: string): void {
    this.whitelist.clearSessionWhitelist(sessionId);
  }

  // --- Broker callback delegation ---

  handleBrokerCallback(callbackData: string): boolean {
    return this.broker.handlePermissionCallback(callbackData);
  }
}