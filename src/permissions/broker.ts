import type { PendingPermissions } from './gateway.js';
import type { BaseChannelAdapter } from '../channels/base.js';

export class PermissionBroker {
  private gateway: PendingPermissions;
  private publicUrl: string;

  constructor(gateway: PendingPermissions, publicUrl: string) {
    this.gateway = gateway;
    this.publicUrl = publicUrl;
  }

  async forwardPermissionRequest(
    request: { permissionRequestId: string; toolName: string; toolInput: unknown },
    getChatId: (channelType: string) => string,
    adapters: BaseChannelAdapter[],
    options?: { showTerminalUrl?: boolean },
  ): Promise<void> {
    const inputStr = typeof request.toolInput === 'string'
      ? request.toolInput
      : JSON.stringify(request.toolInput, null, 2);

    const { formatPermissionCard } = await import('../formatting/index.js');
    const showTerminal = options?.showTerminalUrl ?? true;

    for (const adapter of adapters) {
      const chatId = getChatId(adapter.channelType);
      if (!chatId) continue;

      const formatted = formatPermissionCard(
        {
          toolName: request.toolName,
          toolInput: inputStr,
          permissionId: request.permissionRequestId,
          expiresInMinutes: 5,
          terminalUrl: showTerminal ? (this.publicUrl || undefined) : undefined,
        },
        adapter.channelType as import('../channels/types.js').ChannelType,
      );

      await adapter.send({
        chatId,
        text: formatted.text,
        html: formatted.html,
        buttons: formatted.buttons,
        feishuHeader: formatted.feishuHeader,
        feishuElements: formatted.feishuElements,
      });
    }
  }

  handlePermissionCallback(callbackData: string): boolean {
    // Format: perm:allow:<id>, perm:deny:<id>, perm:allow_session:<id>
    const match = callbackData.match(/^perm:(allow|deny|allow_session):(.+)$/);
    if (!match) return false;

    const [, action, permId] = match;
    const decision = action === 'deny' ? 'deny' as const
      : action === 'allow_session' ? 'allow_always' as const
      : 'allow' as const;
    return this.gateway.resolve(permId, decision);
  }
}
