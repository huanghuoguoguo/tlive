import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { truncate } from '../../../shared/core/string.js';
import { resolveCommandClientTarget } from './execution-client.js';

const execAsync = promisify(exec);
const BASH_TIMEOUT_MS = 30_000;
const BASH_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

export class BashCommand extends BaseCommand {
  readonly name = '/bash';
  readonly quick = true;
  readonly helpCategory = 'session' as const;
  readonly description = '执行命令';
  readonly helpDesc =
    '在当前工作目录执行 shell 命令。超时30秒，输出超过4MB会被截断。用于快速查看文件、运行脚本等。';
  readonly helpExample = '/bash ls -la';

  async execute(ctx: CommandContext): Promise<boolean> {
    const cmdText = ctx.parts.slice(1).join(' ').trim();
    if (!cmdText) {
      await this.send(ctx, { chatId: ctx.msg.chatId, text: 'Usage: /bash <command>' });
      return true;
    }

    const binding = await ctx.services.store.getBinding(ctx.msg.channelType, ctx.scopeId);
    const cwd = binding?.cwd || ctx.services.defaultWorkdir;
    const target = resolveCommandClientTarget(ctx, binding);
    if (target.error) {
      await this.send(ctx, { chatId: ctx.msg.chatId, text: target.error });
      return true;
    }

    try {
      const { stdout, stderr } =
        target.clientId && ctx.services.remoteClientRegistry
          ? await this.execRemote(ctx, target.clientId, cmdText, cwd)
          : await execAsync(cmdText, {
              cwd,
              timeout: BASH_TIMEOUT_MS,
              maxBuffer: BASH_MAX_BUFFER_BYTES,
            });

      const output = (stdout + (stderr ? '\n⚠️ stderr:\n' + stderr : '')).trim();
      const truncatedOutput = truncate(output, 4000);

      await this.send(ctx, {
        chatId: ctx.msg.chatId,
        text: ctx.adapter.formatCodeOutput(truncatedOutput || '(no output)'),
      });
    } catch (err: any) {
      const errMsg = err.stderr || err.message || String(err);
      const truncatedErr = truncate(errMsg, 1000);
      await this.send(ctx, { chatId: ctx.msg.chatId, text: `❌ ${truncatedErr}` });
    }
    return true;
  }

  private async execRemote(
    ctx: CommandContext,
    clientId: string,
    command: string,
    cwd: string,
  ): Promise<{ stdout: string; stderr: string }> {
    const result = await ctx.services.remoteClientRegistry!.execShell(clientId, command, cwd, {
      timeoutMs: BASH_TIMEOUT_MS,
      maxBufferBytes: BASH_MAX_BUFFER_BYTES,
    });
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    if (result.ok) return { stdout, stderr };

    const err = new Error(result.error || `Remote command failed: ${result.exitCode ?? 'unknown'}`);
    (err as Error & { stderr?: string }).stderr = stderr || stdout;
    throw err;
  }
}
