import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentPairings, presentNoPairings, presentPairingUnavailable } from '../messages/presenter.js';

export class PairingsCommand extends BaseCommand {
  readonly name = '/pairings';
  readonly quick = true;
  readonly description = 'List pending pairings';

  async execute(ctx: CommandContext): Promise<boolean> {
    const tgAdapter = ctx.getAdapters().get('telegram');
    if (tgAdapter && 'listPairings' in tgAdapter) {
      const pairings = (tgAdapter as any).listPairings() as Array<{ code: string; userId: string; username: string }>;
      if (pairings.length === 0) {
        await this.send(ctx, presentNoPairings(ctx.msg.chatId));
      } else {
        const lines = pairings.map(p => `• <code>${p.code}</code> — ${p.username} (${p.userId})`);
        await this.send(ctx, presentPairings(ctx.msg.chatId, lines));
      }
    } else {
      await this.send(ctx, presentPairingUnavailable(ctx.msg.chatId));
    }
    return true;
  }
}