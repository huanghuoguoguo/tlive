import type { BaseChannelAdapter } from '../../../channels/base.js';
import { truncate } from '../../../utils/string.js';

interface QuestionData {
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description?: string }>;
    multiSelect: boolean;
  }>;
  ts: number;
  contextSuffix?: string;
}

/**
 * Handles AskUserQuestion flow including multi-select toggles and resolution.
 *
 * Handles:
 * - hookQuestionData: Store AskUserQuestion data for answer resolution
 * - toggledSelections: Track multi-select toggled options per hookId
 */
export class QuestionResolver {
  /** Store AskUserQuestion data for answer resolution */
  private hookQuestionData = new Map<string, QuestionData>();
  /** Track multi-select toggled options per hookId (key: hookId, value: Set of selected indices) */
  private toggledSelections = new Map<string, Set<number>>();

  // --- Question data storage ---

  /** Store AskUserQuestion data for later answer resolution */
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
    this.hookQuestionData.set(hookId, { questions, ts: Date.now(), contextSuffix });
  }

  /** Get stored AskUserQuestion data (for option count validation) */
  getQuestionData(hookId: string): QuestionData | undefined {
    return this.hookQuestionData.get(hookId);
  }

  /** Check if question data exists for a hookId */
  hasQuestionData(hookId: string): boolean {
    return this.hookQuestionData.has(hookId);
  }

  /** Delete question data for a hookId */
  deleteQuestionData(hookId: string): void {
    this.hookQuestionData.delete(hookId);
  }

  // --- Multi-select toggle ---

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

  // --- Resolution methods ---

  /** Handle AskUserQuestion answer callback — resolve hook with selected answer */
  async resolveAskQuestion(
    hookId: string,
    optionIndex: number,
    sessionId: string,
    messageId: string,
    adapter: BaseChannelAdapter,
    chatId: string,
    hookResolver?: { isResolved: (id: string) => boolean; markResolved: (id: string) => void; trackHookMessage: (id: string, sid: string) => void },
  ): Promise<boolean> {
    if (hookResolver?.isResolved(hookId)) return true;
    // Mark resolved immediately to prevent double-click races (async yields below)
    hookResolver?.markResolved(hookId);

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
    await adapter.editCardResolution(chatId, messageId, {
      resolution: 'selected',
      label: `✅ Selected: ${selected.label}`,
      contextSuffix: ctx ? ` Terminal${ctx}` : undefined,
    });
    if (sessionId) {
      hookResolver?.trackHookMessage(messageId, sessionId);
    }
    return true;
  }

  /** Submit multi-select: resolve hook with all toggled options */
  async resolveMultiSelect(
    hookId: string,
    sessionId: string,
    messageId: string,
    adapter: BaseChannelAdapter,
    chatId: string,
    hookResolver?: { isResolved: (id: string) => boolean; markResolved: (id: string) => void; trackHookMessage: (id: string, sid: string) => void },
  ): Promise<boolean> {
    if (hookResolver?.isResolved(hookId)) return true;

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

    hookResolver?.markResolved(hookId);
    const q = questionData.questions[0];
    // Join selected labels with comma (per Claude Code docs)
    const selectedLabels = [...selected].sort((a, b) => a - b).map(i => q.options[i]?.label).filter(Boolean);

    const ctx = questionData.contextSuffix || '';
    this.hookQuestionData.delete(hookId);
    this.toggledSelections.delete(hookId);
    await adapter.editCardResolution(chatId, messageId, {
      resolution: 'answered',
      label: `✅ Selected: ${selectedLabels.join(', ')}`,
      contextSuffix: ctx ? ` Terminal${ctx}` : undefined,
    });
    if (sessionId) {
      hookResolver?.trackHookMessage(messageId, sessionId);
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
    hookResolver?: { isResolved: (id: string) => boolean; markResolved: (id: string) => void; trackHookMessage: (id: string, sid: string) => void },
  ): Promise<boolean> {
    if (hookResolver?.isResolved(hookId)) return true;

    const questionData = this.hookQuestionData.get(hookId);
    if (!questionData) {
      await adapter.send({ chatId, text: '❌ Question data not found' });
      return true;
    }

    hookResolver?.markResolved(hookId);

    const ctx = questionData.contextSuffix || '';
    this.hookQuestionData.delete(hookId);
    await adapter.editCardResolution(chatId, messageId, {
      resolution: 'skipped',
      label: '⏭ Skipped',
      contextSuffix: ctx ? ` Terminal${ctx}` : undefined,
    });
    if (sessionId) {
      hookResolver?.trackHookMessage(messageId, sessionId);
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
    hookResolver?: { isResolved: (id: string) => boolean; markResolved: (id: string) => void; trackHookMessage: (id: string, sid: string) => void },
  ): Promise<boolean> {
    if (hookResolver?.isResolved(hookId)) return true;

    const questionData = this.hookQuestionData.get(hookId);
    if (!questionData) {
      await adapter.send({ chatId, text: '❌ Question data not found' });
      return true;
    }

    hookResolver?.markResolved(hookId);

    const ctx = questionData.contextSuffix || '';
    this.hookQuestionData.delete(hookId);
    await adapter.editCardResolution(chatId, messageId, {
      resolution: 'answered',
      label: `✅ Answer: ${truncate(text, 50)}`,
      contextSuffix: ctx ? ` Terminal${ctx}` : undefined,
    });
    if (sessionId) {
      hookResolver?.trackHookMessage(messageId, sessionId);
    }
    return true;
  }

  // --- Pruning ---

  /** Clean up stale entries older than 1 hour */
  pruneStaleEntries(): void {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [id, entry] of this.hookQuestionData) {
      if (entry.ts < cutoff) {
        this.hookQuestionData.delete(id);
        this.toggledSelections.delete(id);
      }
    }
  }
}