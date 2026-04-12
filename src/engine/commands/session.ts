import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentSessionSwitched, presentSessionUsage, presentSessionNotFound } from '../messages/presenter.js';
import { shortPath } from '../../utils/path.js';
import { generateSessionId } from '../../utils/id.js';
import { isSameRepoRoot } from '../../utils/repo.js';
import { parseSessionIndex } from '../utils/session-format.js';

export class SessionCommand extends BaseCommand {
  readonly name = '/session';
  readonly quick = true;
  readonly description = 'Switch session';

  async execute(ctx: CommandContext): Promise<boolean> {
    const result = await parseSessionIndex(ctx);

    if (!result.ok) {
      if (result.error === 'invalid_index') {
        await this.send(ctx, presentSessionUsage(result.chatId));
      } else {
        await this.send(ctx, presentSessionNotFound(result.chatId, result.idx));
      }
      return true;
    }

    const { target, currentCwd, idx } = result;

    // Get binding for switch operation
    const binding = await ctx.store.getBinding(ctx.msg.channelType, ctx.msg.chatId);
    const switchedRepo = !isSameRepoRoot(currentCwd, target.cwd);

    const { hadActiveSession } = await ctx.helpers.resetSessionContext(
      ctx.msg.channelType,
      ctx.msg.chatId,
      'switch',
      { previousCwd: currentCwd, clearProject: switchedRepo, binding },
    );

    const newBindingId = generateSessionId();
    await ctx.router.rebind(ctx.msg.channelType, ctx.msg.chatId, newBindingId, {
      sdkSessionId: target.sdkSessionId,
      cwd: target.cwd,
      claudeSettingSources: binding?.claudeSettingSources,
      projectName: switchedRepo ? undefined : binding?.projectName,
    });
    ctx.workspace.pushHistory(ctx.msg.channelType, ctx.msg.chatId, target.cwd);
    ctx.helpers.updateWorkspaceBindingFromPath(ctx.msg.channelType, ctx.msg.chatId, target.cwd);

    const feedbackText = hadActiveSession && switchedRepo
      ? `🔄 已关闭旧工作区的活跃会话`
      : undefined;
    await this.send(ctx, presentSessionSwitched(ctx.msg.chatId, idx, shortPath(target.cwd), target.preview, feedbackText));
    return true;
  }
}