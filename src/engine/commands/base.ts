import type { CommandHandler, CommandContext } from './types.js';

/** Base class for command handlers with common utilities */
export abstract class BaseCommand implements CommandHandler {
  abstract readonly name: string;
  abstract readonly quick: boolean;
  abstract readonly description?: string;
  abstract execute(ctx: CommandContext): Promise<boolean>;

  /** Send a formatted message or simple text */
  protected async send(
    ctx: CommandContext,
    msg: { chatId: string; text: string } | { type: string; chatId: string; data: any },
  ): Promise<void> {
    if ('type' in msg) {
      await ctx.adapter.sendFormatted(msg as any);
    } else {
      await ctx.adapter.send(msg);
    }
  }
}