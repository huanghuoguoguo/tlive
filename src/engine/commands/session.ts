import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentSessionSwitched, presentSessionUsage, presentSessionNotFound } from '../messages/presenter.js';
import { scanClaudeSessions } from '../../session-scanner.js';
import { shortPath } from '../../utils/path.js';
import { generateSessionId } from '../../utils/id.js';
import { FLAGS, hasFlag, getNonFlagArg } from '../../utils/constants.js';
import { isSameRepoRoot } from '../../utils/repo.js';

export class SessionCommand extends BaseCommand {
  readonly name = '/session';
  readonly quick = true;
  readonly description = 'Switch session';

  async execute(ctx: CommandContext): Promise<boolean> {
    const sessionArgs = ctx.parts.slice(1);
    const showAll = hasFlag(sessionArgs, FLAGS.ALL);
    const idxToken = getNonFlagArg(sessionArgs, [FLAGS.ALL]);
    const idx = parseInt(idxToken || '', 10);
    if (Number.isNaN(idx) || idx < 1) {
      await this.send(ctx, presentSessionUsage(ctx.msg.chatId));
      return true;
    }

    const binding = await ctx.store.getBinding(ctx.msg.channelType, ctx.msg.chatId);
    const currentCwd = binding?.cwd || ctx.defaultWorkdir;
    const sessions = scanClaudeSessions(10, showAll ? undefined : currentCwd);

    if (idx > sessions.length) {
      await this.send(ctx, presentSessionNotFound(ctx.msg.chatId, idx));
      return true;
    }

    const target = sessions[idx - 1];
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