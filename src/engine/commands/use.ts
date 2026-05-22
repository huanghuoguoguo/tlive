import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';

export class UseCommand extends BaseCommand {
  readonly name = '/use';
  readonly quick = true;
  readonly helpCategory = 'session' as const;
  readonly description = '选择默认执行节点';
  readonly helpDesc = '在主工作台选择默认 client。只影响之后新建的话题，不影响已有话题。';
  readonly helpExample = '/use local · /use vm-0-16-ubuntu';

  async execute(ctx: CommandContext): Promise<boolean> {
    if (ctx.surface === 'topic') {
      await this.send(ctx, {
        chatId: ctx.msg.chatId,
        text: '⚠️ 话题内执行节点已固定，不能用 /use 切换。请回主工作台切换默认 client。',
      });
      return true;
    }

    const requested = ctx.parts[1]?.trim();
    const clients = ctx.services.getExecutionClients?.() ?? [];
    if (!requested) {
      const current = (await ctx.services.store.getBinding(ctx.msg.channelType, ctx.scopeId))?.clientId;
      const list = clients
        .map((client) => `${client.clientId}${client.clientId === current ? ' ◀' : ''}`)
        .join('\n');
      await this.send(ctx, {
        chatId: ctx.msg.chatId,
        text: list ? `当前可用 client:\n${list}` : '⚠️ 当前没有可用执行节点',
      });
      return true;
    }

    const selected = clients.find((client) => client.clientId === requested);
    if (!selected) {
      await this.send(ctx, {
        chatId: ctx.msg.chatId,
        text: `⚠️ 未找到 client: ${requested}`,
      });
      return true;
    }

    const binding = await ctx.services.router.resolve(ctx.msg.channelType, ctx.scopeId);
    binding.clientId = selected.clientId;
    binding.cwd = selected.workspaces.find((workspace) => workspace.isDefault)?.path ?? binding.cwd;
    await ctx.services.store.saveBinding(binding);

    await this.send(ctx, {
      chatId: ctx.msg.chatId,
      text: `✅ 默认执行节点已切换为 ${selected.name || selected.clientId}`,
    });
    return true;
  }
}
