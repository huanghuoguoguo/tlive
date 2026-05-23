import type { AgentSettingSource } from '../../shared/config.js';
import type { BridgeStore } from '../store/interface.js';
import type { ChannelBinding } from '../store/interface.js';
import { generateSessionId } from '../../shared/core/id.js';
import type { AgentProviderKind } from '../../shared/providers/kinds.js';

export class ChannelRouter {
  constructor(private store: BridgeStore) {}

  async resolve(channelType: string, chatId: string): Promise<ChannelBinding> {
    let binding = await this.store.getBinding(channelType, chatId);
    if (binding) return binding;

    // Auto-create binding for first message
    binding = {
      channelType,
      chatId,
      sessionId: generateSessionId(),
      createdAt: new Date().toISOString(),
    };
    await this.store.saveBinding(binding);
    return binding;
  }

  async rebind(
    channelType: string,
    chatId: string,
    sessionId: string,
    opts?: {
      sdkSessionId?: string;
      provider?: AgentProviderKind;
      clientId?: string;
      cwd?: string;
      agentSettingSources?: AgentSettingSource[];
      projectName?: string;
    },
  ): Promise<ChannelBinding> {
    const binding: ChannelBinding = {
      channelType,
      chatId,
      sessionId,
      sdkSessionId: opts?.sdkSessionId,
      provider: opts?.provider,
      clientId: opts?.clientId,
      cwd: opts?.cwd,
      agentSettingSources: opts?.agentSettingSources,
      projectName: opts?.projectName,
      createdAt: new Date().toISOString(),
    };
    await this.store.saveBinding(binding);
    return binding;
  }
}
