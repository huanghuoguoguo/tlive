import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage } from '../../channels/types.js';
import type { AgentSettingSource } from '../../config.js';
import { generateSessionId } from '../../core/id.js';
import { generateRequestId } from '../../logger.js';
import type { BridgeStore } from '../../store/interface.js';
import type { ChannelRouter } from '../../utils/router.js';
import type { IngressCoordinator } from '../coordinators/ingress.js';
import type { QueryOrchestrator } from '../coordinators/query.js';
import { areSettingSourcesEqual } from './utils.js';

export interface AutomationPromptOptions {
  channelType: string;
  chatId: string;
  text: string;
  requestId?: string;
  messageId?: string;
  userId?: string;
  workdir?: string;
  projectName?: string;
  settingSources?: AgentSettingSource[];
}

export interface AutomationPromptResult {
  sessionId?: string;
}

export interface AutomationPromptInjectorOptions {
  getAdapter: (channelType: string) => BaseChannelAdapter | undefined;
  router: ChannelRouter;
  store: BridgeStore;
  ingress: IngressCoordinator;
  query: QueryOrchestrator;
}

/**
 * Owns external prompt injection from automation/webhook entry points.
 *
 * BridgeManager keeps adapter lifecycle and loops; this class owns the
 * automation-specific binding mutation and query injection path.
 */
export class AutomationPromptInjector {
  constructor(private readonly options: AutomationPromptInjectorOptions) {}

  async inject(options: AutomationPromptOptions): Promise<AutomationPromptResult> {
    const adapter = this.options.getAdapter(options.channelType);
    if (!adapter) {
      throw new Error(`Channel '${options.channelType}' not available`);
    }

    const binding = await this.options.router.resolve(options.channelType, options.chatId);
    const workdirChanged = options.workdir !== undefined && binding.cwd !== options.workdir;
    const projectChanged =
      options.projectName !== undefined && binding.projectName !== options.projectName;
    const settingsChanged =
      options.settingSources !== undefined &&
      !areSettingSourcesEqual(binding.agentSettingSources, options.settingSources);
    const sessionContextChanged = workdirChanged || projectChanged || settingsChanged;

    let bindingChanged = false;

    if (options.workdir !== undefined && binding.cwd !== options.workdir) {
      binding.cwd = options.workdir;
      bindingChanged = true;
    }
    if (options.projectName !== undefined && binding.projectName !== options.projectName) {
      binding.projectName = options.projectName;
      bindingChanged = true;
    }
    if (options.settingSources !== undefined && settingsChanged) {
      binding.agentSettingSources = [...options.settingSources];
      bindingChanged = true;
    }

    if (sessionContextChanged) {
      binding.sessionId = generateSessionId();
      binding.sdkSessionId = undefined;
      bindingChanged = true;
    }

    if (bindingChanged) {
      await this.options.store.saveBinding(binding);
    }

    this.options.ingress.recordChat(options.channelType, options.chatId);
    await this.options.query.run(
      adapter,
      this.buildInboundMessage(adapter, options),
      options.requestId,
    );

    const updatedBinding = await this.options.store.getBinding(options.channelType, options.chatId);
    return {
      sessionId: updatedBinding?.sdkSessionId ?? updatedBinding?.sessionId,
    };
  }

  private buildInboundMessage(
    adapter: BaseChannelAdapter,
    options: AutomationPromptOptions,
  ): InboundMessage {
    return {
      channelType: adapter.channelType,
      chatId: options.chatId,
      userId: options.userId ?? 'automation',
      text: options.text,
      messageId: options.messageId ?? `automation-${options.requestId || generateRequestId()}`,
      attachments: [],
    };
  }
}
