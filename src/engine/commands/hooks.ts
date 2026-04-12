import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentHooksChanged, presentHooksStatus } from '../messages/presenter.js';
import { areHooksPaused, pauseHooks, resumeHooks } from '../utils/hooks-state.js';

export class HooksCommand extends BaseCommand {
  readonly name = '/hooks';
  readonly quick = true;
  readonly description = 'Show hooks status';

  async execute(ctx: CommandContext): Promise<boolean> {
    const sub = ctx.parts[1]?.toLowerCase();
    if (sub === 'pause') {
      pauseHooks();
      await this.send(ctx, presentHooksChanged(ctx.msg.chatId, true));
    } else if (sub === 'resume') {
      resumeHooks();
      await this.send(ctx, presentHooksChanged(ctx.msg.chatId, false));
    } else {
      await this.send(ctx, presentHooksStatus(ctx.msg.chatId, areHooksPaused()));
    }
    return true;
  }
}