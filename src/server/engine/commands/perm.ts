import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentPermissionStatus } from '../../presentation/command-presenter.js';

export class PermCommand extends BaseCommand {
  readonly name = '/perm';
  readonly quick = true;
  readonly helpCategory = 'status' as const;
  readonly description = '权限模式';
  readonly helpDesc = '查看或切换权限提示模式。on 表示每次工具调用需确认，off 表示自动允许。';
  readonly helpExample = '/perm on 或 /perm off';

  async execute(ctx: CommandContext): Promise<boolean> {
    const sub = ctx.parts[1]?.toLowerCase();
    const scopeId = ctx.scopeId;
    const binding = await ctx.services.store.getBinding(ctx.msg.channelType, scopeId);
    const sessionId = ctx.surface === 'workbench' ? undefined : binding?.sessionId;
    const mode =
      sub === 'on' || sub === 'off'
        ? sub
        : ctx.services.state.getPermMode(ctx.msg.channelType, scopeId, sessionId);
    if (sub === 'on' || sub === 'off') {
      ctx.services.state.setPermMode(ctx.msg.channelType, scopeId, sessionId, sub);
    }
    const chatKey = ctx.services.state.stateKey(ctx.msg.channelType, scopeId);
    const route =
      ctx.surface === 'topic'
        ? {
            scopeId,
            threadId: ctx.msg.threadId,
            replyInThread: ctx.msg.replyInThread ?? !!ctx.msg.threadId,
          }
        : undefined;
    await this.send(
      ctx,
      presentPermissionStatus(ctx.msg.chatId, {
        mode,
        route,
        ...ctx.services.permissions.getPermissionStatus(chatKey, binding?.sessionId),
      }),
    );
    return true;
  }
}
