import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentSessionSwitched, presentSessionUsage, presentSessionNotFound } from '../messages/presenter.js';
import { shortPath } from '../../utils/path.js';
import { generateSessionId } from '../../utils/id.js';
import { isSameRepoRoot } from '../../utils/repo.js';
import { parseSessionIndex } from '../../utils/session-format.js';
import { chatKey } from '../../utils/key.js';

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

    // Check if target sdkSession is bound to another active bridge session
    const allBindings = await ctx.services.store.listBindings();
    for (const b of allBindings) {
      if (b.sdkSessionId === target.sdkSessionId) {
        // Found a binding that owns this sdkSession
        const bChatKey = chatKey(b.channelType, b.chatId);
        // Check if it's active (has running task)
        const isActive = ctx.services.activeControls?.has(bChatKey) ?? false;
        // Skip if it's the current chat's binding (allow switch)
        if (b.channelType === ctx.msg.channelType && b.chatId === ctx.msg.chatId) {
          break; // Current binding, allow switch
        }
        if (isActive) {
          // Target sdkSession is bound to another active session - cannot switch
          await this.send(ctx, {
            chatId: ctx.msg.chatId,
            text: `⚠️ 会话 #${idx} 正在 ${b.chatId.slice(-4)} 活跃执行中\n\n请等待任务完成后再切换，或使用 /stop 中断后切换。`,
          });
          return true;
        }
        // Not active - can switch, will resume the sdkSession
        break;
      }
    }

    // Get binding for switch operation
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
}
