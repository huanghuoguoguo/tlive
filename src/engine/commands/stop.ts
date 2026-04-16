import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentStopResult } from '../messages/presenter.js';
import { chatKey } from '../../core/key.js';

export class StopCommand extends BaseCommand {
  readonly name = '/stop';
  readonly quick = true;
  readonly description = '中断执行';
  readonly helpDesc = '中断当前正在执行的任务。用于停止长时间运行的命令或 AI 回复生成。';
  readonly helpExample = '/stop';

  async execute(ctx: CommandContext): Promise<boolean> {
    const key = chatKey(ctx.msg.channelType, ctx.msg.chatId);
    const ctrl = ctx.services.activeControls.get(key);
    if (ctrl) {
      ctx.services.activeControls.delete(key);
      await ctrl.interrupt();
      await this.send(ctx, presentStopResult(ctx.msg.chatId, true));
    } else {
      await this.send(ctx, presentStopResult(ctx.msg.chatId, false));
    }
    return true;
  }
}