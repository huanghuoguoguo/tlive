import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentStopResult } from '../messages/presenter.js';

export class StopCommand extends BaseCommand {
  readonly name = '/stop';
  readonly quick = true;
  readonly description = 'Interrupt execution';

  async execute(ctx: CommandContext): Promise<boolean> {
    const chatKey = `${ctx.msg.channelType}:${ctx.msg.chatId}`;
    const ctrl = ctx.activeControls.get(chatKey);
    if (ctrl) {
      ctx.activeControls.delete(chatKey);
      await ctrl.interrupt();
      await this.send(ctx, presentStopResult(ctx.msg.chatId, true));
    } else {
      await this.send(ctx, presentStopResult(ctx.msg.chatId, false));
    }
    return true;
  }
}