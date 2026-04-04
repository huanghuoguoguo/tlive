import { getBridgeContext } from '../context.js';
import type { ChannelBinding } from '../store/interface.js';

export class ChannelRouter {
  async resolve(channelType: string, chatId: string): Promise<ChannelBinding> {
    const { store } = getBridgeContext();

    let binding = await store.getBinding(channelType, chatId);
    if (binding) return binding;

    // Auto-create binding for first message
    binding = {
      channelType,
      chatId,
      sessionId: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
    };
    await store.saveBinding(binding);
    return binding;
  }

  async rebind(channelType: string, chatId: string, sessionId: string, opts?: { sdkSessionId?: string; cwd?: string }): Promise<ChannelBinding> {
    const { store } = getBridgeContext();
    const binding: ChannelBinding = {
      channelType,
      chatId,
      sessionId,
      sdkSessionId: opts?.sdkSessionId,
      cwd: opts?.cwd,
      createdAt: new Date().toISOString(),
    };
    await store.saveBinding(binding);
    return binding;
  }
}
