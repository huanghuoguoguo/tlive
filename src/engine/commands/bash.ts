import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { truncate } from '../../utils/string.js';
import { escapeHtml } from '../../formatting/escape.js';

const execAsync = promisify(exec);

export class BashCommand extends BaseCommand {
  readonly name = '/bash';
  readonly quick = true;
  readonly description = 'Execute shell command';

  async execute(ctx: CommandContext): Promise<boolean> {
    const cmdText = ctx.msg.text.slice('/bash '.length).trim();
    if (!cmdText) {
      await ctx.adapter.send({ chatId: ctx.msg.chatId, text: 'Usage: /bash <command>' });
      return true;
    }

    const binding = await ctx.services.store.getBinding(ctx.msg.channelType, ctx.msg.chatId);
    const cwd = binding?.cwd || ctx.services.defaultWorkdir;

    try {
      const { stdout, stderr } = await execAsync(cmdText, {
        cwd,
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      });

      const output = (stdout + (stderr ? '\n⚠️ stderr:\n' + stderr : '')).trim();
      const truncatedOutput = truncate(output, 4000);

      if (ctx.adapter.channelType === 'telegram') {
        await ctx.adapter.send({
          chatId: ctx.msg.chatId,
          html: `<pre>${escapeHtml(truncatedOutput || '(no output)')}</pre>`,
        });
      } else if (ctx.adapter.channelType === 'feishu') {
        await ctx.adapter.send({
          chatId: ctx.msg.chatId,
          text: '```\n' + (truncatedOutput || '(no output)') + '\n```',
        });
      } else {
        await ctx.adapter.send({
          chatId: ctx.msg.chatId,
          text: truncatedOutput || '(no output)',
        });
      }
    } catch (err: any) {
      const errMsg = err.stderr || err.message || String(err);
      const truncatedErr = truncate(errMsg, 1000);
      await ctx.adapter.send({ chatId: ctx.msg.chatId, text: `❌ ${truncatedErr}` });
    }
    return true;
  }
}