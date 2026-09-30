import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentStopResult } from '../../presentation/command-presenter.js';
import { chatKey } from '../../../shared/core/key.js';
import { ControlTimeoutError } from '../../../shared/providers/errors.js';
import { t } from '../../../shared/i18n/index.js';

export class StopCommand extends BaseCommand {
  readonly name = '/stop';
  readonly quick = true;
  readonly helpCategory = 'system' as const;
  readonly description = '中断执行';
  readonly helpDesc = '中断当前正在执行的任务。用于停止长时间运行的命令或 AI 回复生成。';
  readonly helpExample = '/stop';

  async execute(ctx: CommandContext): Promise<boolean> {
    const explicitSessionKey = ctx.parts.slice(1).join(' ').trim();
    if (explicitSessionKey && ctx.services.sdkEngine?.interruptSession) {
      return this.reportStop(ctx, () =>
        ctx.services.sdkEngine!.interruptSession!(explicitSessionKey),
      );
    }

    if (ctx.surface === 'workbench') {
      await this.send(ctx, {
        chatId: ctx.msg.chatId,
        text: t('cmd.stop.workbenchHint'),
      });
      return true;
    }

    const key = chatKey(ctx.msg.channelType, ctx.scopeId);
    return this.reportStop(ctx, () =>
      ctx.services.sdkEngine?.interruptChat
        ? ctx.services.sdkEngine.interruptChat(key)
        : this.interruptLegacy(ctx, key),
    );
  }

  /**
   * A worker that goes silent after the interrupt signal still stops the turn, so
   * report that rather than failing the loop with an unacknowledged interrupt.
   */
  private async reportStop(ctx: CommandContext, stop: () => Promise<boolean>): Promise<boolean> {
    try {
      await this.send(ctx, presentStopResult(ctx.msg.chatId, await stop(), ctx.locale));
    } catch (err) {
      if (!(err instanceof ControlTimeoutError)) throw err;
      await this.send(ctx, { chatId: ctx.msg.chatId, text: t('cmd.stop.notAcknowledged') });
    }
    return true;
  }

  private async interruptLegacy(ctx: CommandContext, key: string): Promise<boolean> {
    const ctrl = ctx.services.activeControls.get(key);
    if (!ctrl) return false;
    ctx.services.activeControls.delete(key);
    await ctrl.interrupt();
    return true;
  }
}
