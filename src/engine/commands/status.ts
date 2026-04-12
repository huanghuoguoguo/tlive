import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentStatus } from '../messages/presenter.js';

export class StatusCommand extends BaseCommand {
  readonly name = '/status';
  readonly quick = true;
  readonly description = 'Bridge status';

  async execute(ctx: CommandContext): Promise<boolean> {
    const channelList = Array.from(ctx.getAdapters().keys()).join(', ') || 'none';
    await this.send(ctx, presentStatus(ctx.msg.chatId, {
      healthy: true,
      channels: channelList.split(', '),
    }));
    return true;
  }
}