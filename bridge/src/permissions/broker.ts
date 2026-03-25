import { PendingPermissions } from './gateway.js';
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
    adapters: BaseChannelAdapter[]
  ): Promise<void> {
    const inputStr = typeof request.toolInput === 'string'
      ? request.toolInput
      : JSON.stringify(request.toolInput, null, 2);

    const { formatPermissionCard } = await import('../formatting/index.js');

    for (const adapter of adapters) {
      const chatId = getChatId(adapter.channelType);
      if (!chatId) continue;

      const formatted = formatPermissionCard(
        {
          toolName: request.toolName,
          toolInput: inputStr,
          permissionId: request.permissionRequestId,
          expiresInMinutes: 5,
          terminalUrl: this.publicUrl || undefined,
        },
        adapter.channelType as import('../channels/types.js').ChannelType,
      );

      await adapter.send({
        chatId,
        text: formatted.text,
        html: formatted.html,
        embed: formatted.embed,
        buttons: formatted.buttons,
        feishuHeader: formatted.feishuHeader,
      });
    }
  }

  handlePermissionCallback(callbackData: string): boolean {
    // Format: perm:allow:<id>, perm:deny:<id>, perm:allow_session:<id>
    const match = callbackData.match(/^perm:(allow|deny|allow_session):(.+)$/);
    if (!match) return false;

    const [, action, permId] = match;
    const allowed = action === 'allow' || action === 'allow_session';
    return this.gateway.resolve(permId, allowed);
  }
}
