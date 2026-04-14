import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage } from '../../channels/types.js';
import type { ChannelBinding } from '../../store/interface.js';
import type { MessageRenderer } from '../messages/renderer.js';
import type { CostTracker } from '../utils/cost-tracker.js';
import type { DeferredToolHandler } from '../../providers/base.js';
import type { LogContext } from '../../logger.js';

/**
 * Context for query execution, encapsulating all parameters.
 * Reduces parameter count and improves code readability.
 */
export class QueryContext {
  constructor(
    readonly adapter: BaseChannelAdapter,
    readonly msg: InboundMessage,
    readonly binding: ChannelBinding,
    readonly sessionKey: string,
    readonly renderer: MessageRenderer,
    readonly costTracker: CostTracker,
    readonly sdkPermissionHandler: (toolName: string, toolInput: Record<string, unknown>, promptSentence: string, signal?: AbortSignal) => Promise<'allow' | 'allow_always' | 'deny'>,
    readonly sdkAskQuestionHandler: (questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string }>; multiSelect: boolean }>, signal?: AbortSignal) => Promise<Record<string, string>>,
    readonly sdkDeferredToolHandler: DeferredToolHandler,
    readonly ctx: LogContext,
  ) {}

  /** Get workdir from binding or default */
  getWorkdir(defaultWorkdir: string): string {
    return this.binding.cwd || defaultWorkdir;
  }

  /** Get setting sources from binding or default */
  getSettingSources(defaultSources: ClaudeSettingSource[]): ClaudeSettingSource[] {
    return this.binding.claudeSettingSources ?? defaultSources;
  }
}

import type { ClaudeSettingSource } from '../../config.js';