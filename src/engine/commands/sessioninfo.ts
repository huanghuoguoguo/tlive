import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentSessionDetail, presentSessionUsage, presentSessionNotFound } from '../messages/presenter.js';
import { scanClaudeSessions, readSessionTranscriptPreview } from '../../session-scanner.js';
import { shortPath } from '../../utils/path.js';
import { FLAGS, hasFlag, getNonFlagArg } from '../../utils/constants.js';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function formatSessionDate(mtime: number): string {
  return new Date(mtime).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export class SessioninfoCommand extends BaseCommand {
  readonly name = '/sessioninfo';
  readonly quick = true;
  readonly description = 'Show session info';

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
    const transcript = readSessionTranscriptPreview(target, 4).map(item => ({
      role: item.role,
      text: item.text,
    }));
    await this.send(ctx, presentSessionDetail(ctx.msg.chatId, {
      index: idx,
      cwd: shortPath(target.cwd),
      preview: target.preview,
      date: formatSessionDate(target.mtime),
      size: formatSize(target.size),
      transcript,
    }));
    return true;
  }
}