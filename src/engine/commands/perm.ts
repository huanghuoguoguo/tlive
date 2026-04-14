import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentPermissionStatus } from '../messages/presenter.js';

export class PermCommand extends BaseCommand {
  readonly name = '/perm';
  readonly quick = true;
  readonly description = 'Permission prompts';

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