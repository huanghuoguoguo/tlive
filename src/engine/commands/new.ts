import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentNewSession, presentHome } from '../messages/presenter.js';
import { generateSessionId } from '../../core/id.js';
import { t } from '../../i18n/index.js';

export class NewCommand extends BaseCommand {
  readonly name = '/new';
  readonly quick = true;
  readonly description = '新建会话';
  readonly helpDesc = '开启新的 bridge session，相当于新建一个连接。之前的连接仍可继续使用。\n如果只想重置当前 CC 窗口，请在 Claude Code 终端中输入 /clear。';
  readonly helpExample = '/new';

  async execute(ctx: CommandContext): Promise<boolean> {
    const previousBinding = await ctx.services.store.getBinding(ctx.msg.channelType, ctx.msg.chatId);
    const hadActiveSession = previousBinding
      ? (ctx.services.sdkEngine?.hasSessionContext?.(ctx.msg.channelType, ctx.msg.chatId, previousBinding.sessionId) ?? false)
        || !!previousBinding.sdkSessionId
      : false;

    const newSessionId = generateSessionId();
    await ctx.services.router.rebind(ctx.msg.channelType, ctx.msg.chatId, newSessionId, {
      cwd: previousBinding?.cwd,
      claudeSettingSources: previousBinding?.claudeSettingSources,
      projectName: previousBinding?.projectName,
    });

    ctx.services.state.clearLastActive(ctx.msg.channelType, ctx.msg.chatId);
    ctx.services.state.clearThread(ctx.msg.channelType, ctx.msg.chatId);

    const feedbackText = hadActiveSession
      ? t(ctx.locale, 'newSession.feedbackText')
      : undefined;
    await this.send(ctx, presentNewSession(ctx.msg.chatId, { cwd: previousBinding?.cwd, feedbackText }));

    // Send home screen after session reset
    const homeData = await ctx.helpers.buildHomePayload(ctx.msg.channelType, ctx.msg.chatId, ctx.locale);
    homeData.task.active = false;
    await this.send(ctx, presentHome(ctx.msg.chatId, homeData));
    return true;
  }
}