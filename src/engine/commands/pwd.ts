import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentDirectory, presentDirectoryHistory } from '../messages/presenter.js';
import { shortPath } from '../../core/path.js';

export class PwdCommand extends BaseCommand {
  readonly name = '/pwd';
  readonly quick = true;
  readonly description = '当前目录';
  readonly helpDesc = '显示当前工作目录。如果有历史目录或工作区绑定，也会一并显示。';
  readonly helpExample = '/pwd';

  async execute(ctx: CommandContext): Promise<boolean> {
    const binding = await ctx.services.store.getBinding(ctx.msg.channelType, ctx.msg.chatId);
    const current = binding?.cwd || ctx.services.defaultWorkdir;
    const history = ctx.services.workspace.getHistory(ctx.msg.channelType, ctx.msg.chatId);
    const workspaceBinding = ctx.services.workspace.getBinding(ctx.msg.channelType, ctx.msg.chatId);

    if (history.length > 1 || workspaceBinding) {
      await this.send(ctx, presentDirectoryHistory(
        ctx.msg.chatId,
        shortPath(current),
        history.map(shortPath),
        workspaceBinding ? shortPath(workspaceBinding) : undefined,
      ));
    } else {
      await this.send(ctx, presentDirectory(ctx.msg.chatId, shortPath(current)));
    }
    return true;
  }
}