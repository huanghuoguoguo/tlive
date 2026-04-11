import type { PendingPermissions } from '../permissions/gateway.js';

export interface SdkQuestionPrompt {
  question: string;
  header: string;
  options: Array<{ label: string; description?: string; preview?: string }>;
  multiSelect: boolean;
}

export interface PendingSdkQuestionEntry {
  questions: SdkQuestionPrompt[];
  chatId: string;
  createdAt: number;
}

export interface SdkQuestionState {
  sdkQuestionData: Map<string, PendingSdkQuestionEntry>;
  sdkQuestionAnswers: Map<string, number>;
  sdkQuestionTextAnswers: Map<string, string>;
}

export class InteractionState {
  private sdkQuestionData = new Map<string, PendingSdkQuestionEntry>();
  private sdkQuestionAnswers = new Map<string, number>();
  private sdkQuestionTextAnswers = new Map<string, string>();

  beginSdkQuestion(permId: string, questions: SdkQuestionPrompt[], chatId: string): void {
    this.sdkQuestionData.set(permId, {
      questions,
      chatId,
      createdAt: Date.now(),
    });
  }

  getSdkQuestion(permId: string): PendingSdkQuestionEntry | undefined {
    return this.sdkQuestionData.get(permId);
  }

  getSdkQuestionOptionCount(permId: string): number {
    return this.sdkQuestionData.get(permId)?.questions?.[0]?.options?.length ?? 0;
  }

  findPendingSdkQuestion(chatId: string, gateway: PendingPermissions): { permId: string } | null {
    for (const [permId, data] of this.sdkQuestionData) {
      if (data.chatId === chatId && gateway.isPending(permId)) {
        return { permId };
      }
    }
    return null;
  }

  setSdkQuestionOptionAnswer(permId: string, optionIndex: number): void {
    this.sdkQuestionAnswers.set(permId, optionIndex);
  }

  setSdkQuestionTextAnswer(permId: string, text: string): void {
    this.sdkQuestionTextAnswers.set(permId, text);
  }

  consumeSdkQuestionAnswer(permId: string): { optionIndex?: number; textAnswer?: string } {
    const textAnswer = this.sdkQuestionTextAnswers.get(permId);
    const optionIndex = this.sdkQuestionAnswers.get(permId);
    this.sdkQuestionTextAnswers.delete(permId);
    this.sdkQuestionAnswers.delete(permId);
    return {
      optionIndex,
      textAnswer,
    };
  }

  cleanupSdkQuestion(permId: string): void {
    this.sdkQuestionData.delete(permId);
    this.sdkQuestionAnswers.delete(permId);
    this.sdkQuestionTextAnswers.delete(permId);
  }

  pruneResolvedSdkQuestions(gateway: PendingPermissions): void {
    for (const [permId] of this.sdkQuestionData) {
      if (!gateway.isPending(permId)) {
        this.cleanupSdkQuestion(permId);
      }
    }
  }

  snapshot(): SdkQuestionState {
    return {
      sdkQuestionData: this.sdkQuestionData,
      sdkQuestionAnswers: this.sdkQuestionAnswers,
      sdkQuestionTextAnswers: this.sdkQuestionTextAnswers,
    };
  }
}
