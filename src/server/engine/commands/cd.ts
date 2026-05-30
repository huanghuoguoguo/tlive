import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import type { ChannelBinding } from '../../store/interface.js';
import {
  presentDirectory,
  presentDirectoryHistory,
  presentDirectoryNotFound,
} from '../../presentation/command-presenter.js';
import { shortPath, expandTilde } from '../../../shared/core/path.js';
import { generateSessionId } from '../../../shared/core/id.js';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { isSameRepoRoot } from '../../../shared/utils/repo.js';
import { t } from '../../../shared/i18n/index.js';
import { resolveCommandClientTarget } from './execution-client.js';

export interface DirectorySwitchResult {
  ok: boolean;
  requestedPath: string;
  resolvedPath?: string;
  error?: string;
  hadActiveSession?: boolean;
  switchedRepo?: boolean;
  feedbackText?: string;
}

export class CdCommand extends BaseCommand {
  readonly name = '/cd';
  readonly quick = true;
  readonly helpCategory = 'session' as const;
  readonly description = '切换目录';
  readonly helpDesc =
    '切换当前 IM session 的工作目录，影响后续 bash 执行的目录。不修改执行引擎配置。若要在新工作区开始工作，请先 /cd 切换目录，再执行 /new。';
  readonly helpExample = '/cd ~/workspace/project · /cd - · /cd';

  async execute(ctx: CommandContext): Promise<boolean> {
    const path = ctx.parts.slice(1).join(' ').trim();
    const scopeId = ctx.scopeId;

    if (!path) {
      // Show current directory and history
      const binding = await ctx.services.store.getBinding(ctx.msg.channelType, scopeId);
      const current = binding?.cwd || ctx.services.defaultWorkdir;
      const history = ctx.services.workspace.getHistory(ctx.msg.channelType, scopeId);
      const workspaceBinding = ctx.services.workspace.getBinding(ctx.msg.channelType, scopeId);
      await this.send(
        ctx,
        presentDirectoryHistory(
          ctx.msg.chatId,
          shortPath(current),
          history.map(shortPath),
          workspaceBinding ? shortPath(workspaceBinding) : undefined,
          ctx.locale,
        ),
      );
      return true;
    }

    // Handle /cd - (back to previous directory)
    if (path === '-') {
      const previousDir = ctx.services.workspace.getPreviousDirectory(ctx.msg.channelType, scopeId);
      if (!previousDir) {
        await this.send(ctx, { chatId: ctx.msg.chatId, text: t('cmd.cd.noHistory') });
        return true;
      }

      const binding = await ctx.services.store.getBinding(ctx.msg.channelType, scopeId);
      const currentCwd = binding?.cwd || ctx.services.defaultWorkdir;
      const switchedRepo = !isSameRepoRoot(currentCwd, previousDir);

      if (switchedRepo) {
        await ctx.helpers.resetSessionContext(ctx.msg.channelType, scopeId, 'cd', {
          previousCwd: currentCwd,
          clearProject: true,
          binding,
        });
      }

      if (binding) {
        binding.cwd = previousDir;
        await ctx.services.store.saveBinding(binding);
      } else {
        await ctx.services.router.rebind(ctx.msg.channelType, scopeId, generateSessionId(), {
          provider: ctx.services.providers.defaultProviderKind,
          cwd: previousDir,
        });
      }
      ctx.services.workspace.pushHistory(ctx.msg.channelType, scopeId, previousDir);
      ctx.helpers.updateWorkspaceBindingFromPath(ctx.msg.channelType, scopeId, previousDir);

      const feedbackText = t('cmd.cd.switchedBack');
      await this.send(
        ctx,
        presentDirectory(ctx.msg.chatId, shortPath(previousDir), true, feedbackText),
      );
      return true;
    }

    const binding = await ctx.services.store.getBinding(ctx.msg.channelType, scopeId);
    const baseCwd = binding?.cwd || ctx.services.defaultWorkdir;
    const result = await switchCommandDirectory(ctx, path, { binding, baseCwd });
    if (!result.ok) {
      await this.send(
        ctx,
        result.error
          ? { chatId: ctx.msg.chatId, text: result.error }
          : presentDirectoryNotFound(ctx.msg.chatId, shortPath(result.requestedPath)),
      );
      return true;
    }

    await this.send(
      ctx,
      presentDirectory(ctx.msg.chatId, shortPath(result.resolvedPath!), true, result.feedbackText),
    );
    return true;
  }
}

export async function switchCommandDirectory(
  ctx: CommandContext,
  path: string,
  opts: { binding?: ChannelBinding | null; baseCwd?: string } = {},
): Promise<DirectorySwitchResult> {
  const scopeId = ctx.scopeId;
  const binding =
    opts.binding === undefined
      ? await ctx.services.store.getBinding(ctx.msg.channelType, scopeId)
      : opts.binding;
  const baseCwd = opts.baseCwd ?? binding?.cwd ?? ctx.services.defaultWorkdir;
  const target = resolveCommandClientTarget(ctx, binding);
  if (target.error) {
    return {
      ok: false,
      requestedPath: path,
      error: target.error,
    };
  }

  const requestedPath = resolveRequestedPath(path, baseCwd, Boolean(target.clientId));
  const resolvedPath = await resolveDirectory(ctx, target.clientId, requestedPath);
  if (!resolvedPath) {
    return { ok: false, requestedPath };
  }

  ctx.services.workspace.pushHistory(ctx.msg.channelType, scopeId, baseCwd);

  const switchedRepo = !isSameRepoRoot(baseCwd, resolvedPath);
  const { hadActiveSession } = switchedRepo
    ? await ctx.helpers.resetSessionContext(ctx.msg.channelType, scopeId, 'cd', {
        previousCwd: baseCwd,
        clearProject: true,
        binding,
      })
    : { hadActiveSession: false };

  if (binding) {
    binding.cwd = resolvedPath;
    binding.clientId = binding.clientId ?? target.clientId;
    await ctx.services.store.saveBinding(binding);
  } else {
    await ctx.services.router.rebind(ctx.msg.channelType, scopeId, generateSessionId(), {
      provider: ctx.services.providers.defaultProviderKind,
      clientId: target.clientId,
      cwd: resolvedPath,
    });
  }
  ctx.services.workspace.pushHistory(ctx.msg.channelType, scopeId, resolvedPath);
  ctx.helpers.updateWorkspaceBindingFromPath(ctx.msg.channelType, scopeId, resolvedPath);

  return {
    ok: true,
    requestedPath,
    resolvedPath,
    hadActiveSession,
    switchedRepo,
    feedbackText: hadActiveSession && switchedRepo ? t('cmd.cd.switchedRepo') : undefined,
  };
}

async function resolveDirectory(
  ctx: CommandContext,
  clientId: string | undefined,
  requestedPath: string,
): Promise<string | null> {
  if (clientId && ctx.services.remoteClientRegistry) {
    const result = await ctx.services.remoteClientRegistry.statPath(clientId, requestedPath);
    return result.ok && result.exists && result.isDirectory ? (result.path ?? requestedPath) : null;
  }

  try {
    return statSync(requestedPath).isDirectory() ? requestedPath : null;
  } catch {
    return null;
  }
}

function resolveRequestedPath(path: string, baseCwd: string, remote: boolean): string {
  if (remote && (path === '~' || path.startsWith('~/'))) return path;
  const expandedPath = remote ? path : expandTilde(path);
  return expandedPath.startsWith('/') ? expandedPath : join(baseCwd, expandedPath);
}
