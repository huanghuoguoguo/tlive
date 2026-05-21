import type {
  PendingPermissions,
  PermissionDecision as TextPermissionDecision,
} from '../../permissions/gateway.js';
import { SdkPermTracker } from './sdk-perm-tracker.js';
import { QuestionResolver } from './question-resolver.js';
import { SessionWhitelist } from './session-whitelist.js';

type PermissionDecision = TextPermissionDecision | 'cancelled';

/**
 * Coordinates all permission-related state and resolution logic.
 *
 * This is now a facade that delegates to specialized sub-components:
 * - SdkPermTracker: SDK permission tracking + text-based approval
 * - QuestionResolver: AskUserQuestion multi-select state
 * - SessionWhitelist: Dynamic tool/Bash prefix whitelist
 *
 * The public surface is intentionally limited to the active SDK permission,
 * question, and session-whitelist flows.
 */
export class PermissionCoordinator {
  private sdkTracker: SdkPermTracker;
  private questionResolver: QuestionResolver;
  private whitelist: SessionWhitelist;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(gateway: PendingPermissions) {
    this.sdkTracker = new SdkPermTracker(gateway);
    this.questionResolver = new QuestionResolver();
    this.whitelist = new SessionWhitelist();
  }

  // --- Sub-component accessors (for fine-grained access) ---

  get sdk(): SdkPermTracker {
    return this.sdkTracker;
  }

  get questions(): QuestionResolver {
    return this.questionResolver;
  }

  get sessionWhitelist(): SessionWhitelist {
    return this.whitelist;
  }

  // --- Gateway access ---

  getGateway(): PendingPermissions {
    return this.sdkTracker.getGateway();
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

  // --- Permission message tracking (delegated to SdkPermTracker) ---

  trackPermissionMessage(messageId: string, permissionId: string, sessionId: string, channelType: string): void {
    this.sdkTracker.trackPermissionMessage(messageId, permissionId, sessionId, channelType);
  }

  // --- Question data (delegated to QuestionResolver) ---

  storeQuestionData(
    interactionId: string,
    questions: Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect: boolean;
    }>,
    contextSuffix?: string,
  ): void {
    this.questionResolver.storeQuestionData(interactionId, questions, contextSuffix);
  }

  getQuestionData(interactionId: string): {
    questions: Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect: boolean;
    }>;
  } | undefined {
    return this.questionResolver.getQuestionData(interactionId);
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
    this.questionResolver.pruneStaleEntries();
  }

  toggleMultiSelectOption(interactionId: string, optionIndex: number): Set<number> | null {
    return this.questionResolver.toggleMultiSelectOption(interactionId, optionIndex);
  }

  getToggledSelections(interactionId: string): Set<number> {
    return this.questionResolver.getToggledSelections(interactionId);
  }

  cleanupQuestion(interactionId: string): void {
    this.questionResolver.cleanupQuestion(interactionId);
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

  rememberSameCommandAllowance(
    sessionId: string | undefined,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): void {
    this.whitelist.rememberSameCommandAllowance(sessionId, toolName, toolInput);
  }

  extractBashPrefix(command: string): string {
    return this.whitelist.extractBashPrefix(command);
  }

  clearSessionWhitelist(sessionId?: string): void {
    this.whitelist.clearSessionWhitelist(sessionId);
  }

  // --- Permission button callback resolution ---

  handlePermissionCallback(callbackData: string): boolean {
    return this.sdkTracker.getGateway().resolveCallback(callbackData);
  }
}
