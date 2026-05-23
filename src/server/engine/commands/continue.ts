import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { withInboundReplyContext } from '../../channels/reply-context.js';
import { TopicResumeService } from '../services/topic-resume.js';
import { t } from '../../../shared/i18n/index.js';

async function sendPlain(ctx: CommandContext, text: string): Promise<void> {
  await ctx.adapter.send(withInboundReplyContext({ chatId: ctx.msg.chatId, text }, ctx.msg));
}

/** Hidden callback command: resume an agent session into a Feishu topic. */
export class ContinueSessionCommand extends BaseCommand {
  readonly name = '/continue';
  readonly quick = true;
  readonly helpCategory = 'session' as const;
  readonly description = undefined;

  async execute(ctx: CommandContext): Promise<boolean> {
    const token = ctx.parts[1]?.trim();
    if (!token) {
      await sendPlain(ctx, t('cmd.continue.usage'));
      return true;
    }

    return new TopicResumeService(ctx).resume(token);
  }
}
