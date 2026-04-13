import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentDirectory, presentDirectoryHistory, presentDirectoryNotFound } from '../messages/presenter.js';
import { shortPath } from '../../utils/path.js';
import { generateSessionId } from '../../utils/id.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isSameRepoRoot } from '../../utils/repo.js';

export class CdCommand extends BaseCommand {
  readonly name = '/cd';
  readonly quick = true;
  readonly description = 'Change directory';

  async execute(ctx: CommandContext): Promise<boolean> {
    const path = ctx.parts.slice(1).join(' ').trim();

    if (!path) {
      // Show current directory and history
      const binding = await ctx.store.getBinding(ctx.msg.channelType, ctx.msg.chatId);
      const current = binding?.cwd || ctx.defaultWorkdir;
      const history = ctx.workspace.getHistory(ctx.msg.channelType, ctx.msg.chatId);
      const workspaceBinding = ctx.workspace.getBinding(ctx.msg.channelType, ctx.msg.chatId);
      await this.send(ctx, presentDirectoryHistory(ctx.msg.chatId, shortPath(current), history.map(shortPath), workspaceBinding ? shortPath(workspaceBinding) : undefined));
      return true;
    }

    // Handle /cd - (back to previous directory)
    if (path === '-') {
      const previousDir = ctx.workspace.getPreviousDirectory(ctx.msg.channelType, ctx.msg.chatId);
      if (!previousDir) {
        await this.send(ctx, { chatId: ctx.msg.chatId, text: '⚠️ 没有历史目录可返回' });
        return true;
      }

      const binding = await ctx.store.getBinding(ctx.msg.channelType, ctx.msg.chatId);
      const currentCwd = binding?.cwd || ctx.defaultWorkdir;
      const switchedRepo = !isSameRepoRoot(currentCwd, previousDir);

      if (switchedRepo) {
        await ctx.helpers.resetSessionContext(
          ctx.msg.channelType,
          ctx.msg.chatId,
          'cd',
          { previousCwd: currentCwd, clearProject: true, binding },
        );
      }

      if (binding) {
        binding.cwd = previousDir;
        await ctx.store.saveBinding(binding);
      } else {
        await ctx.router.rebind(ctx.msg.channelType, ctx.msg.chatId, generateSessionId(), { cwd: previousDir });
      }
      ctx.workspace.pushHistory(ctx.msg.channelType, ctx.msg.chatId, previousDir);
      ctx.helpers.updateWorkspaceBindingFromPath(ctx.msg.channelType, ctx.msg.chatId, previousDir);

      const feedbackText = `🔙 已切换到上一目录`;
      await this.send(ctx, presentDirectory(ctx.msg.chatId, shortPath(previousDir), true, feedbackText));
      return true;
    }

    // Handle ~ expansion
    const expandedPath = path.startsWith('~') ? join(homedir(), path.slice(1)) : path;

    // Resolve relative paths
    const binding = await ctx.store.getBinding(ctx.msg.channelType, ctx.msg.chatId);
    const baseCwd = binding?.cwd || ctx.defaultWorkdir;
    const resolvedPath = expandedPath.startsWith('/') ? expandedPath : join(baseCwd, expandedPath);

    if (!existsSync(resolvedPath)) {
      await this.send(ctx, presentDirectoryNotFound(ctx.msg.chatId, shortPath(resolvedPath)));
      return true;
    }

    ctx.workspace.pushHistory(ctx.msg.channelType, ctx.msg.chatId, baseCwd);

    const switchedRepo = !isSameRepoRoot(baseCwd, resolvedPath);

    const { hadActiveSession } = switchedRepo
      ? await ctx.helpers.resetSessionContext(
        ctx.msg.channelType,
        ctx.msg.chatId,
        'cd',
        { previousCwd: baseCwd, clearProject: true, binding },
      )
      : { hadActiveSession: false };

    if (binding) {
      binding.cwd = resolvedPath;
      await ctx.store.saveBinding(binding);
    } else {
      await ctx.router.rebind(ctx.msg.channelType, ctx.msg.chatId, generateSessionId(), { cwd: resolvedPath });
    }
    ctx.workspace.pushHistory(ctx.msg.channelType, ctx.msg.chatId, resolvedPath);
    ctx.helpers.updateWorkspaceBindingFromPath(ctx.msg.channelType, ctx.msg.chatId, resolvedPath);

    const feedbackText = hadActiveSession && switchedRepo
      ? `🧭 已保留旧仓库会话，默认切到新目录`
      : undefined;
    await this.send(ctx, presentDirectory(ctx.msg.chatId, shortPath(resolvedPath), true, feedbackText));
    return true;
  }
}
