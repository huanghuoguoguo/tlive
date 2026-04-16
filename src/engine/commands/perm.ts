import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentPermissionStatus } from '../messages/presenter.js';

export class PermCommand extends BaseCommand {
  readonly name = '/perm';
  readonly quick = true;
  readonly description = '权限模式';
  readonly helpDesc = '查看或切换权限提示模式。on 表示每次工具调用需确认，off 表示自动允许。';
  readonly helpExample = '/perm on 或 /perm off';

  async execute(ctx: CommandContext): Promise<boolean> {
    const sub = ctx.parts[1]?.toLowerCase();
    const binding = await ctx.services.store.getBinding(ctx.msg.channelType, ctx.msg.chatId);
    const sessionId = binding?.sessionId;
    const mode = (sub === 'on' || sub === 'off') ? sub : ctx.services.state.getPermMode(ctx.msg.channelType, ctx.msg.chatId, sessionId);
    if (sub === 'on' || sub === 'off') {
      ctx.services.state.setPermMode(ctx.msg.channelType, ctx.msg.chatId, sessionId, sub);
    }
    const chatKey = ctx.services.state.stateKey(ctx.msg.channelType, ctx.msg.chatId);
    await this.send(ctx, presentPermissionStatus(ctx.msg.chatId, {
      mode,
      ...ctx.services.permissions.getPermissionStatus(chatKey, binding?.sessionId),
    }));
    return true;
  }
}