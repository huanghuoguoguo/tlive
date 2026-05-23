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
 * Tracks AskUserQuestion multi-select state.
 *
 * Handles:
 * - questionData: Store AskUserQuestion data for answer rendering and validation
 * - toggledSelections: Track multi-select toggled options per interactionId
 */
export class QuestionResolver {
  /** Store AskUserQuestion data for answer resolution */
  private questionData = new Map<string, QuestionData>();
  /** Track multi-select toggled options per interactionId */
  private toggledSelections = new Map<string, Set<number>>();

  // --- Question data storage ---

  /** Store AskUserQuestion data for later answer resolution */
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
    this.questionData.set(interactionId, { questions, ts: Date.now(), contextSuffix });
  }

  /** Get stored AskUserQuestion data (for option count validation) */
  getQuestionData(interactionId: string): QuestionData | undefined {
    return this.questionData.get(interactionId);
  }

  /** Check if question data exists for an interaction. */
  hasQuestionData(interactionId: string): boolean {
    return this.questionData.has(interactionId);
  }

  /** Delete question data for an interaction. */
  deleteQuestionData(interactionId: string): void {
    this.questionData.delete(interactionId);
  }

  // --- Multi-select toggle ---

  /** Toggle a multi-select option. Returns the current selection set for re-rendering. */
  toggleMultiSelectOption(interactionId: string, optionIndex: number): Set<number> | null {
    const questionData = this.questionData.get(interactionId);
    if (!questionData) return null;
    const q = questionData.questions[0];
    if (!q || optionIndex < 0 || optionIndex >= q.options.length) return null;

    let selected = this.toggledSelections.get(interactionId);
    if (!selected) {
      selected = new Set();
      this.toggledSelections.set(interactionId, selected);
    }
    if (selected.has(optionIndex)) selected.delete(optionIndex);
    else selected.add(optionIndex);
    return selected;
  }

  /** Get current toggled selections for an interaction. */
  getToggledSelections(interactionId: string): Set<number> {
    return this.toggledSelections.get(interactionId) ?? new Set();
  }

  /** Clean up toggle state and question data for an interaction. */
  cleanupQuestion(interactionId: string): void {
    this.questionData.delete(interactionId);
    this.toggledSelections.delete(interactionId);
  }

  // --- Pruning ---

  /** Clean up stale entries older than 1 hour */
  pruneStaleEntries(): void {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [id, entry] of this.questionData) {
      if (entry.ts < cutoff) {
        this.questionData.delete(id);
        this.toggledSelections.delete(id);
      }
    }
  }
}
