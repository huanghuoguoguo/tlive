import { FLAGS, getNonFlagArg, hasFlag } from '../../core/args.js';
import { historyProviderKinds } from '../../providers/history.js';
import type { ScannedSession } from '../../providers/session-scanner.js';
import { scanAgentSessions } from '../../providers/session-scanner.js';
import type { ChannelBinding } from '../../store/interface.js';
import type { CommandContext } from './types.js';

/** Result of parsing session index from command args. */
export type SessionParseResult =
  | { ok: false; error: 'invalid_index'; chatId: string }
  | { ok: false; error: 'index_out_of_range'; chatId: string; idx: number }
  | {
      ok: true;
      idx: number;
      sessions: ScannedSession[];
      target: ScannedSession;
      showAll: boolean;
      currentCwd: string;
    };

export async function scanSessionsForContext(
  ctx: CommandContext,
  showAll: boolean,
): Promise<{ binding: ChannelBinding | null; currentCwd: string; sessions: ScannedSession[] }> {
  const binding = await ctx.services.store.getBinding(ctx.msg.channelType, ctx.scopeId);
  const currentCwd = binding?.cwd || ctx.services.defaultWorkdir;
  const sessions = scanAgentSessions(
    10,
    showAll ? undefined : currentCwd,
    historyProviderKinds(ctx.services.providers),
  );
  return { binding, currentCwd, sessions };
}

/**
 * Parse session index from command args and validate against scanned agent sessions.
 * Shared helper for /session switching and detail commands.
 */
export async function parseSessionIndex(ctx: CommandContext): Promise<SessionParseResult> {
  const sessionArgs = ctx.parts.slice(1);
  const showAll = hasFlag(sessionArgs, FLAGS.ALL);
  const idxToken = getNonFlagArg(sessionArgs, [FLAGS.ALL]);
  const idx = parseInt(idxToken || '', 10);

  if (Number.isNaN(idx) || idx < 1) {
    return { ok: false, error: 'invalid_index', chatId: ctx.msg.chatId };
  }

  const { currentCwd, sessions } = await scanSessionsForContext(ctx, showAll);

  if (idx > sessions.length) {
    return { ok: false, error: 'index_out_of_range', chatId: ctx.msg.chatId, idx };
  }

  return { ok: true, idx, sessions, target: sessions[idx - 1], showAll, currentCwd };
}
