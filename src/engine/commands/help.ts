import { BaseCommand } from './base.js';
import type { CommandContext, HelpEntry } from './types.js';
import { presentHelp } from '../messages/presenter.js';
import { commandRegistry } from './registry.js';

export class HelpCommand extends BaseCommand {
  readonly name = '/help';
  readonly quick = true;
  readonly description = 'Show all commands';

  async execute(ctx: CommandContext): Promise<boolean> {
    const entries: HelpEntry[] = commandRegistry.getHelpEntries();
    await this.send(ctx, presentHelp(ctx.msg.chatId, { commands: entries }));
    return true;
  }
}