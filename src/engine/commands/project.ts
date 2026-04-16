import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import {
  presentProjectInfoExtended,
  presentNoProjects,
  presentRecentProjects,
} from '../messages/presenter.js';
import { shortPath } from '../../core/path.js';
import { generateSessionId } from '../../core/id.js';
import { basename } from 'node:path';
import { getProjectByName } from '../../config.js';
import { isSameRepoRoot } from '../../utils/repo.js';
import { areSettingSourcesEqual } from '../../engine/automation/utils.js';
import type { ProjectListData } from '../../formatting/message-types.js';

export class ProjectCommand extends BaseCommand {
  readonly name = '/project';
  readonly quick = true;
  readonly description = 'Recent projects';

  async execute(ctx: CommandContext): Promise<boolean> {
    const sub = ctx.parts[1]?.toLowerCase();

    // /project status - show current project status
    if (sub === 'status' || sub === 'info') {
      const binding = await ctx.services.store.getBinding(ctx.msg.channelType, ctx.msg.chatId);
      const currentCwd = binding?.cwd || ctx.services.defaultWorkdir;
      const workspaceBinding = ctx.services.workspace.getBinding(ctx.msg.channelType, ctx.msg.chatId);
      const implicitName = basename(currentCwd);

      await this.send(ctx, presentProjectInfoExtended(ctx.msg.chatId, {
        projectName: implicitName,
        workdir: shortPath(currentCwd),
        isImplicit: true,
        workspaceBinding: workspaceBinding ? shortPath(workspaceBinding) : undefined,
      }));
      return true;
    }

    // /project or /project list - show recent projects (always from user habits)
    const recent = ctx.services.recentProjects.list();
    if (recent.length === 0) {
      await this.send(ctx, presentNoProjects(ctx.msg.chatId));
      return true;
    }

    const binding = await ctx.services.store.getBinding(ctx.msg.channelType, ctx.msg.chatId);
    const currentCwd = binding?.cwd || ctx.services.defaultWorkdir;

    await this.send(ctx, presentRecentProjects(ctx.msg.chatId, {
      projects: recent.map(p => ({
        name: p.name,
        workdir: shortPath(p.workdir),
        fullWorkdir: p.workdir,
        lastUsedAt: p.lastUsedAt,
        useCount: p.useCount,
        isCurrent: p.workdir === currentCwd,
      })),
      currentCwd: shortPath(currentCwd),
    }));
    return true;
  }
}