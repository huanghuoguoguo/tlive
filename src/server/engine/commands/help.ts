import { BaseCommand } from './base.js';
import type { CommandContext, HelpEntry } from './types.js';
import { presentHelp } from '../messages/presenter.js';
import { commandRegistry } from './registry.js';
import { helpButtonsForSurface, helpEntriesForSurface } from '../conversations/surface-policy.js';

export class HelpCommand extends BaseCommand {
  readonly name = '/help';
  readonly quick = true;
  readonly helpCategory = 'other' as const;
  readonly description = '显示帮助';
  readonly helpDesc = '显示所有可用命令的详细说明，包括用法和示例。按类别分组展示。';
  readonly helpExample = '/help';

  async execute(ctx: CommandContext): Promise<boolean> {
    const entries: HelpEntry[] = helpEntriesForSurface(
      commandRegistry.getHelpEntries(),
      ctx.surface,
    );
    await this.send(
      ctx,
      presentHelp(ctx.msg.chatId, {
        commands: entries,
        actionButtons: helpButtonsForSurface(ctx.surface),
      }),
    );
    return true;
  }
}
