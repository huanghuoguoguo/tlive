import type { CommandContext } from './types.js';
import type { ChannelBinding } from '../../store/interface.js';

export interface CommandClientTarget {
  clientId?: string;
  error?: string;
}

export function resolveCommandClientTarget(
  ctx: CommandContext,
  binding: ChannelBinding | null,
): CommandClientTarget {
  const clients = ctx.services.getExecutionClients?.() ?? [];
  const clientId = binding?.clientId;
  if (clientId) {
    if (clients.length === 0 || clients.some((client) => client.clientId === clientId)) {
      return { clientId };
    }
    return { error: `⚠️ 执行节点不在线: ${clientId}` };
  }

  if (clients.length === 1) {
    return { clientId: clients[0].clientId };
  }

  if (clients.length > 1) {
    return { error: '⚠️ 请先在工作台用 /use <client> 选择执行节点。' };
  }

  return {};
}
