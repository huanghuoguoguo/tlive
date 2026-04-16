import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentSessions, presentNoSessions } from '../messages/presenter.js';
import { scanClaudeSessions } from '../../providers/session-scanner.js';
import { shortPath } from '../../core/path.js';
import { FLAGS, hasFlag } from '../../engine/constants.js';
import { SESSION_STALE_THRESHOLD_MS } from '../../engine/constants.js';
import { formatSize, formatSessionDate } from '../../formatting/session-format.js';

export class SessionsCommand extends BaseCommand {
  readonly name = '/sessions';
  readonly quick = true;
  readonly description = '会话列表';
  readonly helpDesc = '列出历史会话。默认显示当前工作区的会话，使用 --all 显示所有项目的会话。可通过编号配合 /session 切换。';
  readonly helpExample = '/sessions 或 /sessions --all';

  async execute(ctx: CommandContext): Promise<boolean> {
    const binding = await ctx.services.store.getBinding(ctx.msg.channelType, ctx.msg.chatId);
    const currentCwd = binding?.cwd || ctx.services.defaultWorkdir;
    const showAll = hasFlag(ctx.parts.slice(1), FLAGS.ALL);

    const sessions = scanClaudeSessions(10, showAll ? undefined : currentCwd);
    const currentSdkId = binding?.sdkSessionId;

    const workspaceBinding = ctx.services.workspace.getBinding(ctx.msg.channelType, ctx.msg.chatId);

    if (sessions.length === 0) {
      const hint = showAll ? '' : ` in ${shortPath(currentCwd)}\nUse /sessions --all to see all projects.`;
      await this.send(ctx, presentNoSessions(ctx.msg.chatId, hint));
      return true;
    }

    const now = Date.now();
    const sessionData = sessions.map((s, i) => ({
      index: i + 1,
      date: formatSessionDate(s.mtime, ctx.locale),
      cwd: shortPath(s.cwd),
      size: formatSize(s.size),
      preview: s.preview,
      isCurrent: currentSdkId === s.sdkSessionId,
      isStale: (now - s.mtime) > SESSION_STALE_THRESHOLD_MS,
    }));

    const filterHint = showAll ? ' (all projects)' : ` (${shortPath(currentCwd)})`;
    await this.send(ctx, presentSessions(ctx.msg.chatId, {
      workspaceBinding: workspaceBinding ? shortPath(workspaceBinding) : undefined,
      sessions: sessionData,
      filterHint,
      showAll,
    }));
    return true;
  }
}