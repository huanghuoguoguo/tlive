import type { CommandHandler, CommandContext } from './types.js';
import type { HelpCategoryId } from './help-categories.js';
import { withInboundReplyContext } from '../../channels/reply-context.js';
import type { FormattableMessage } from '../../formatting/message-types.js';

type PlainCommandMessage = { chatId: string; text: string };

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
    msg: PlainCommandMessage | FormattableMessage,
  ): Promise<void> {
    if ('type' in msg) {
      await ctx.adapter.send(withInboundReplyContext(ctx.adapter.format(msg), ctx.msg));
    } else {
      await ctx.adapter.send(withInboundReplyContext(msg, ctx.msg));
    }
  }
}
