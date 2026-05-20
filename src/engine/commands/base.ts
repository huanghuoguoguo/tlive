import type { CommandHandler, CommandContext } from './types.js';
import type { HelpCategoryId } from './help-categories.js';
import { withInboundReplyContext } from '../../channels/reply-context.js';

/** Base class for command handlers with common utilities */
export abstract class BaseCommand implements CommandHandler {
  abstract readonly name: string;
  abstract readonly quick: boolean;
  abstract readonly helpCategory: HelpCategoryId;
  abstract readonly description?: string;
  abstract execute(ctx: CommandContext): Promise<boolean>;

  /** Send a formatted message or simple text */
  protected async send(
    ctx: CommandContext,
    msg: { chatId: string; text: string } | { type: string; chatId: string; data: any },
  ): Promise<void> {
    if ('type' in msg) {
      const format = (ctx.adapter as any).format;
      if (typeof format === 'function') {
        await ctx.adapter.send(withInboundReplyContext(format.call(ctx.adapter, msg as any), ctx.msg));
        return;
      }
      await ctx.adapter.sendFormatted(msg as any);
    } else {
      await ctx.adapter.send(withInboundReplyContext(msg, ctx.msg));
    }
  }
}
