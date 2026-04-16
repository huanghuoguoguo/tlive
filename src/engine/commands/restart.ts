import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentRestartResult } from '../messages/presenter.js';

export class RestartCommand extends BaseCommand {
  readonly name = '/restart';
  readonly quick = true;
  readonly description = '重启 Bridge';
  readonly helpDesc = '重启 Bridge 服务。1秒后进程退出，由外部守护进程自动重启。';
  readonly helpExample = '/restart';

  async execute(ctx: CommandContext): Promise<boolean> {
    await this.send(ctx, presentRestartResult(ctx.msg.chatId));
    setTimeout(() => {
      process.exit(0);
    }, 1000);
    return true;
  }
}