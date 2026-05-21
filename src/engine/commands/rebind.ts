import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentSessionSwitched } from '../messages/presenter.js';
import { shortPath } from '../../core/path.js';

/**
 * /rebind <bindingSessionId> — switch to an existing in-memory managed session.
 * Used by the /home UI to quickly switch between active sessions.
 */
export class RebindCommand extends BaseCommand {
  readonly name = '/rebind';
  readonly quick = true;
  readonly helpCategory = 'session' as const;
  readonly description = undefined; // Hidden from /help

  async execute(ctx: CommandContext): Promise<boolean> {
    const targetBindingId = ctx.parts[1]?.trim();
    const scopeId = ctx.scopeId;
    if (!targetBindingId) {
      await this.send(ctx, { chatId: ctx.msg.chatId, text: '⚠️ 用法: /rebind <bindingSessionId>' });
      return true;
    }

    const sessions = ctx.services.sdkEngine?.getSessionsForChat(ctx.msg.channelType, scopeId) ?? [];
    const target = sessions.find((s) => s.bindingSessionId === targetBindingId);
    if (!target) {
      await this.send(ctx, { chatId: ctx.msg.chatId, text: '⚠️ 未找到该会话，可能已过期。' });
      return true;
    }

    // Already current
    if (target.isCurrent) {
      await this.send(ctx, { chatId: ctx.msg.chatId, text: '✅ 已经是当前会话。' });
      return true;
    }

    const binding = await ctx.services.store.getBinding(ctx.msg.channelType, scopeId);

    await ctx.services.router.rebind(ctx.msg.channelType, scopeId, targetBindingId, {
      sdkSessionId: target.sdkSessionId,
      provider: target.provider ?? binding?.provider ?? ctx.services.providers.defaultProviderKind,
      cwd: target.workdir,
      agentSettingSources: binding?.agentSettingSources,
      projectName: binding?.projectName,
    });
    ctx.services.workspace.pushHistory(ctx.msg.channelType, scopeId, target.workdir);
    ctx.helpers.updateWorkspaceBindingFromPath(ctx.msg.channelType, scopeId, target.workdir);

    const sdkShort = target.sdkSessionId?.slice(0, 8) ?? '-';
    await this.send(
      ctx,
      presentSessionSwitched(
        ctx.msg.chatId,
        0, // no index for rebind
        shortPath(target.workdir),
        `SDK: ${sdkShort}`,
      ),
    );
    return true;
  }
}
