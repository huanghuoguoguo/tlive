import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentPermissionStatus } from '../messages/presenter.js';

export class PermCommand extends BaseCommand {
  readonly name = '/perm';
  readonly quick = true;
  readonly description = 'Permission prompts';

  async execute(ctx: CommandContext): Promise<boolean> {
    const sub = ctx.parts[1]?.toLowerCase();
    const mode = (sub === 'on' || sub === 'off') ? sub : ctx.state.getPermMode(ctx.msg.channelType, ctx.msg.chatId);
    if (sub === 'on' || sub === 'off') {
      ctx.state.setPermMode(ctx.msg.channelType, ctx.msg.chatId, sub);
    }
    const binding = await ctx.store.getBinding(ctx.msg.channelType, ctx.msg.chatId);
    const chatKey = ctx.state.stateKey(ctx.msg.channelType, ctx.msg.chatId);
    await this.send(ctx, presentPermissionStatus(ctx.msg.chatId, {
      mode,
      ...ctx.permissions.getPermissionStatus(chatKey, binding?.sessionId),
    }));
    return true;
  }
}