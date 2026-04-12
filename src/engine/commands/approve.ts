import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentApproveSuccess, presentApproveFailure, presentApproveUsage, presentPairingUnavailable } from '../messages/presenter.js';

export class ApproveCommand extends BaseCommand {
  readonly name = '/approve';
  readonly quick = true;
  readonly description = 'Approve pairing code';

  async execute(ctx: CommandContext): Promise<boolean> {
    const code = ctx.parts[1];
    if (!code) {
      await this.send(ctx, presentApproveUsage(ctx.msg.chatId));
      return true;
    }
    const tgAdapter = ctx.getAdapters().get('telegram');
    if (tgAdapter && 'approvePairing' in tgAdapter) {
      const result = (tgAdapter as any).approvePairing(code);
      if (result) {
        await this.send(ctx, presentApproveSuccess(ctx.msg.chatId, result.username, result.userId));
      } else {
        await this.send(ctx, presentApproveFailure(ctx.msg.chatId));
      }
    } else {
      await this.send(ctx, presentPairingUnavailable(ctx.msg.chatId));
    }
    return true;
  }
}