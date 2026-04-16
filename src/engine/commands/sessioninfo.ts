import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentSessionDetail, presentSessionUsage, presentSessionNotFound } from '../messages/presenter.js';
import { readSessionTranscriptPreview } from '../../providers/session-scanner.js';
import { shortPath } from '../../core/path.js';
import { formatSize, formatSessionDate, parseSessionIndex } from '../../formatting/session-format.js';

export class SessioninfoCommand extends BaseCommand {
  readonly name = '/sessioninfo';
  readonly quick = true;
  readonly description = '会话详情';
  readonly helpDesc = '显示指定会话的详细信息，包括目录、大小、预览和对话片段。';
  readonly helpExample = '/sessioninfo 3';

  async execute(ctx: CommandContext): Promise<boolean> {
    const result = await parseSessionIndex(ctx);

    if (!result.ok) {
      if (result.error === 'invalid_index') {
        await this.send(ctx, presentSessionUsage(result.chatId));
      } else {
        await this.send(ctx, presentSessionNotFound(result.chatId, result.idx));
      }
      return true;
    }

    const { target } = result;
    const transcript = readSessionTranscriptPreview(target, 4).map(item => ({
      role: item.role,
      text: item.text,
    }));
    await this.send(ctx, presentSessionDetail(ctx.msg.chatId, {
      index: result.idx,
      cwd: shortPath(target.cwd),
      preview: target.preview,
      date: formatSessionDate(target.mtime, ctx.locale),
      size: formatSize(target.size),
      transcript,
    }));
    return true;
  }
}