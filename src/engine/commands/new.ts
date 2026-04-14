import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentNewSession, presentHome } from '../messages/presenter.js';
import { generateSessionId } from '../../utils/id.js';

export class NewCommand extends BaseCommand {
  readonly name = '/new';
  readonly quick = true;
  readonly description = 'New conversation';

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
      ? `🆕 已保留旧会话，开启新会话`
      : undefined;
    await this.send(ctx, presentNewSession(ctx.msg.chatId, { cwd: previousBinding?.cwd, feedbackText }));

    // Send home screen after session reset
    const homeData = await ctx.helpers.buildHomePayload(ctx.msg.channelType, ctx.msg.chatId);
    homeData.hasActiveTask = false;
    await this.send(ctx, presentHome(ctx.msg.chatId, homeData));
    return true;
  }
}
