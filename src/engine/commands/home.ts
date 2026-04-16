import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentHome } from '../messages/presenter.js';

export class HomeCommand extends BaseCommand {
  readonly name = '/home';
  readonly quick = true;
  readonly description = '显示主界面';
  readonly helpDesc = '显示主控制面板，包括当前会话状态、历史会话列表、工作区切换按钮等。是查看和管理工作区的主要入口。';
  readonly helpExample = '/home';

  async execute(ctx: CommandContext): Promise<boolean> {
    await this.send(ctx, presentHome(ctx.msg.chatId, await ctx.helpers.buildHomePayload(ctx.msg.channelType, ctx.msg.chatId, ctx.locale)));
    return true;
  }
}