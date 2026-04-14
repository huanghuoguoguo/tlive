import type { ClaudeSettingSource } from '../../config.js';
import type { BridgeStore } from '../../store/interface.js';
import type { ChannelBinding } from '../../store/interface.js';
import { generateSessionId } from './id.js';

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
      cwd?: string;
      claudeSettingSources?: ClaudeSettingSource[];
      projectName?: string;
    },
  ): Promise<ChannelBinding> {
    const binding: ChannelBinding = {
      channelType,
      chatId,
      sessionId,
      sdkSessionId: opts?.sdkSessionId,
      cwd: opts?.cwd,
      claudeSettingSources: opts?.claudeSettingSources,
      projectName: opts?.projectName,
      createdAt: new Date().toISOString(),
    };
    await this.store.saveBinding(binding);
    return binding;
  }
}
