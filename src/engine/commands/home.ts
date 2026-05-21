import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentHome } from '../messages/presenter.js';
import type { FormattableMessage } from '../../formatting/message-types.js';

async function buildHomeMessage(ctx: CommandContext): Promise<FormattableMessage> {
  return presentHome(
    ctx.msg.chatId,
    await ctx.helpers.buildHomePayload(ctx.msg.channelType, ctx.scopeId, ctx.locale),
  );
}

export class HomeCommand extends BaseCommand {
  readonly name = '/home';
  readonly quick = true;
  readonly helpCategory = 'status' as const;
  readonly description = '显示主界面';
  readonly helpDesc =
    '显示主控制面板，包括当前会话状态、历史会话列表、工作区切换按钮等。是查看和管理工作区的主要入口。';
  readonly helpExample = '/home';

  async execute(ctx: CommandContext): Promise<boolean> {
    await this.send(ctx, await buildHomeMessage(ctx));
    return true;
  }
}

export class TliveCommand extends BaseCommand {
  readonly name = '/tlive';
  readonly quick = true;
  readonly helpCategory = 'status' as const;
  readonly description = '打开工作台';
  readonly helpDesc =
    '打开 TLive 工作台。除 /home 和 /stop 外，其它 slash 文本默认透传给底层 agent。';
  readonly helpExample = '/tlive';

  async execute(ctx: CommandContext): Promise<boolean> {
    await this.send(ctx, await buildHomeMessage(ctx));
    return true;
  }
}
