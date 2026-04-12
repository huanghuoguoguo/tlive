import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentRestartResult } from '../messages/presenter.js';

export class RestartCommand extends BaseCommand {
  readonly name = '/restart';
  readonly quick = true;
  readonly description = 'Restart bridge';

  async execute(ctx: CommandContext): Promise<boolean> {
    await this.send(ctx, presentRestartResult(ctx.msg.chatId));
    setTimeout(() => {
      process.exit(0);
    }, 1000);
    return true;
  }
}