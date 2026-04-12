import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentDirectory, presentDirectoryHistory } from '../messages/presenter.js';
import { shortPath } from '../../utils/path.js';

export class PwdCommand extends BaseCommand {
  readonly name = '/pwd';
  readonly quick = true;
  readonly description = 'Show current directory';

  async execute(ctx: CommandContext): Promise<boolean> {
    const binding = await ctx.store.getBinding(ctx.msg.channelType, ctx.msg.chatId);
    const current = binding?.cwd || ctx.defaultWorkdir;
    const history = ctx.workspace.getHistory(ctx.msg.channelType, ctx.msg.chatId);
    const workspaceBinding = ctx.workspace.getBinding(ctx.msg.channelType, ctx.msg.chatId);

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