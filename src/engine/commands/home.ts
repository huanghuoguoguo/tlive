import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentHome } from '../messages/presenter.js';

export class HomeCommand extends BaseCommand {
  readonly name = '/home';
  readonly quick = true;
  readonly description = 'Show home screen';

  async execute(ctx: CommandContext): Promise<boolean> {
    await this.send(ctx, presentHome(ctx.msg.chatId, await ctx.helpers.buildHomePayload(ctx.msg.channelType, ctx.msg.chatId)));
    return true;
  }
}