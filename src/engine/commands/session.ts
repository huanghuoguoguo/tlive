import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import {
  presentSessions,
  presentSessionSwitched,
  presentSessionDetail,
  presentNoSessions,
} from '../messages/presenter.js';
import {
  scanClaudeSessions,
  readSessionTranscriptPreview,
} from '../../providers/session-scanner.js';
import { shortPath } from '../../core/path.js';
import { generateSessionId } from '../../core/id.js';
import { isSameRepoRoot } from '../../utils/repo.js';
import {
  FLAGS,
  hasFlag,
  getNonFlagArg,
  SESSION_STALE_THRESHOLD_MS,
} from '../../engine/constants.js';
import { formatSize, formatSessionDate, parseSessionIndex } from '../../formatting/session-format.js';
import { chatKey } from '../../core/key.js';

/** Verbose flag for session detail view */
const VERBOSE_FLAG = { long: '--verbose', short: '-v' };

export class SessionCommand extends BaseCommand {
  readonly name = '/session';
  readonly quick = true;
  readonly description = '会话管理';
  readonly helpDesc = `列出或切换 Claude Code 会话。
无参数时列出当前工作区的会话。
使用 -a 列出所有项目的会话。
指定编号切换到对应会话。
使用 -v 查看会话详情。`;
  readonly helpExample = '/session · /session -a · /session 3 · /session 3 -v';

  async execute(ctx: CommandContext): Promise<boolean> {
    const args = ctx.parts.slice(1);
    const showAll = hasFlag(args, FLAGS.ALL);
    const showVerbose = hasFlag(args, VERBOSE_FLAG);
    const indexArg = getNonFlagArg(args, [FLAGS.ALL, VERBOSE_FLAG]);

    // Parse index if provided
    const idx = indexArg ? parseInt(indexArg, 10) : NaN;
    const hasIndex = !Number.isNaN(idx) && idx > 0;

    if (showVerbose && hasIndex) {
      // /session 3 -v -> show session detail
      return this.showSessionDetail(ctx, idx);
    } else if (hasIndex) {
      // /session 3 -> switch to session
      return this.switchToSession(ctx, idx);
    } else {
      // /session or /session -a -> list sessions
      return this.listSessions(ctx, showAll);
    }
  }

  /** List available sessions */
  private async listSessions(ctx: CommandContext, showAll: boolean): Promise<boolean> {
    const binding = await ctx.services.store.getBinding(ctx.msg.channelType, ctx.msg.chatId);
    const currentCwd = binding?.cwd || ctx.services.defaultWorkdir;

    const sessions = scanClaudeSessions(10, showAll ? undefined : currentCwd);
    const currentSdkId = binding?.sdkSessionId;
    const workspaceBinding = ctx.services.workspace.getBinding(ctx.msg.channelType, ctx.msg.chatId);

    if (sessions.length === 0) {
      const hint = showAll ? '' : ` in ${shortPath(currentCwd)}\nUse /session -a to see all projects.`;
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

  /** Switch to a specific session */
  private async switchToSession(ctx: CommandContext, idx: number): Promise<boolean> {
    const result = await parseSessionIndex(ctx);

    if (!result.ok) {
      if (result.error === 'invalid_index') {
        await this.send(ctx, { chatId: ctx.msg.chatId, text: '请输入有效的会话编号。使用 /session 查看列表。' });
      } else {
        await this.send(ctx, { chatId: ctx.msg.chatId, text: `会话 #${idx} 不存在。使用 /session 查看列表。` });
      }
      return true;
    }

    const { target, currentCwd } = result;

    // Check if target sdkSession is bound to another active bridge session
    const allBindings = await ctx.services.store.listBindings();
    for (const b of allBindings) {
      if (b.sdkSessionId === target.sdkSessionId) {
        const bChatKey = chatKey(b.channelType, b.chatId);
        const isActive = ctx.services.activeControls?.has(bChatKey) ?? false;
        if (b.channelType === ctx.msg.channelType && b.chatId === ctx.msg.chatId) {
          break;
        }
        if (isActive) {
          await this.send(ctx, {
            chatId: ctx.msg.chatId,
            text: `⚠️ 会话 #${idx} 正在 ${b.chatId.slice(-4)} 活跃执行中\n\n请等待任务完成后再切换，或使用 /stop 中断后切换。`,
          });
          return true;
        }
        break;
      }
    }

    const binding = await ctx.services.store.getBinding(ctx.msg.channelType, ctx.msg.chatId);
    const switchedRepo = !isSameRepoRoot(currentCwd, target.cwd);
    const hadActiveSession = binding
      ? (ctx.services.sdkEngine?.hasSessionContext?.(ctx.msg.channelType, ctx.msg.chatId, binding.sessionId) ?? false)
        || !!binding.sdkSessionId
      : false;

    const newBindingId = generateSessionId();
    await ctx.services.router.rebind(ctx.msg.channelType, ctx.msg.chatId, newBindingId, {
      sdkSessionId: target.sdkSessionId,
      cwd: target.cwd,
      claudeSettingSources: binding?.claudeSettingSources,
      projectName: switchedRepo ? undefined : binding?.projectName,
    });
    ctx.services.workspace.pushHistory(ctx.msg.channelType, ctx.msg.chatId, target.cwd);
    ctx.helpers.updateWorkspaceBindingFromPath(ctx.msg.channelType, ctx.msg.chatId, target.cwd);

    const feedbackText = hadActiveSession && switchedRepo
      ? `🧭 已保留旧工作区会话，并切换默认会话`
      : undefined;
    await this.send(ctx, presentSessionSwitched(ctx.msg.chatId, idx, shortPath(target.cwd), target.preview, feedbackText));
    return true;
  }

  /** Show detailed session info */
  private async showSessionDetail(ctx: CommandContext, idx: number): Promise<boolean> {
    const result = await parseSessionIndex(ctx);

    if (!result.ok) {
      if (result.error === 'invalid_index') {
        await this.send(ctx, { chatId: ctx.msg.chatId, text: '请输入有效的会话编号。使用 /session 查看列表。' });
      } else {
        await this.send(ctx, { chatId: ctx.msg.chatId, text: `会话 #${idx} 不存在。使用 /session 查看列表。` });
      }
      return true;
    }

    const { target } = result;
    const transcript = readSessionTranscriptPreview(target, 4).map(item => ({
      role: item.role,
      text: item.text,
    }));

    await this.send(ctx, presentSessionDetail(ctx.msg.chatId, {
      index: idx,
      cwd: shortPath(target.cwd),
      preview: target.preview,
      date: formatSessionDate(target.mtime, ctx.locale),
      size: formatSize(target.size),
      transcript,
    }));
    return true;
  }
}