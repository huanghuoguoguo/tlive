import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentSessions, presentNoSessions } from '../messages/presenter.js';
import { scanClaudeSessions } from '../../providers/session-scanner.js';
import { shortPath } from '../../utils/path.js';
import { FLAGS, hasFlag } from '../../utils/constants.js';
import { SESSION_STALE_THRESHOLD_MS } from '../../utils/constants.js';
import { formatSize, formatSessionDate } from '../../utils/session-format.js';

export class SessionsCommand extends BaseCommand {
  readonly name = '/sessions';
  readonly quick = true;
  readonly description = 'List sessions';

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
      date: formatSessionDate(s.mtime),
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