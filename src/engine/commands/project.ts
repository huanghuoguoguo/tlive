import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import {
  presentProjectList,
  presentProjectSwitched,
  presentProjectNotFound,
  presentProjectUsage,
  presentProjectInfoExtended,
  presentNoProjects,
} from '../messages/presenter.js';
import { shortPath } from '../../utils/path.js';
import { generateSessionId } from '../../utils/id.js';
import { basename } from 'node:path';
import { getProjectByName } from '../../config.js';
import { isSameRepoRoot } from '../../utils/repo.js';
import { areSettingSourcesEqual } from '../../utils/automation.js';
import type { ProjectListData } from '../../formatting/message-types.js';

export class ProjectCommand extends BaseCommand {
  readonly name = '/project';
  readonly quick = true;
  readonly description = 'List projects';

  async execute(ctx: CommandContext): Promise<boolean> {
    const sub = ctx.parts[1]?.toLowerCase();

    const projectsConfig = ctx.helpers.projectsConfig;

    if (!projectsConfig || projectsConfig.valid.length === 0) {
      await this.send(ctx, presentNoProjects(ctx.msg.chatId));
      return true;
    }

    // /project or /project list - show all projects
    if (!sub || sub === 'list') {
      const binding = await ctx.store.getBinding(ctx.msg.channelType, ctx.msg.chatId);
      const currentProjectName = binding?.projectName;
      const projects: ProjectListData['projects'] = projectsConfig.valid.map(p => ({
        name: p.name,
        workdir: shortPath(p.workdir),
        isCurrent: p.name === currentProjectName,
        isDefault: p.name === projectsConfig.defaultProject,
      }));

      await this.send(ctx, presentProjectList(ctx.msg.chatId, {
        projects,
        defaultProject: projectsConfig.defaultProject,
        currentProject: currentProjectName,
      }));
      return true;
    }

    // /project use <name> - switch to a project
    if (sub === 'use') {
      const projectName = ctx.parts[2]?.trim();
      if (!projectName) {
        await this.send(ctx, presentProjectUsage(ctx.msg.chatId));
        return true;
      }

      const project = getProjectByName(projectsConfig.valid, projectName);
      if (!project) {
        await this.send(ctx, presentProjectNotFound(ctx.msg.chatId, projectName));
        return true;
      }

      const binding = await ctx.store.getBinding(ctx.msg.channelType, ctx.msg.chatId);
      const currentCwd = binding?.cwd || ctx.defaultWorkdir;
      const previousProjectName = binding?.projectName;

      ctx.workspace.pushHistory(ctx.msg.channelType, ctx.msg.chatId, currentCwd);

      const switchedRepo = !isSameRepoRoot(currentCwd, project.workdir);
      const settingsChanged = !areSettingSourcesEqual(
        binding?.claudeSettingSources,
        project.claudeSettingSources,
      );
      const shouldResetSession = switchedRepo || settingsChanged;

      const { hadActiveSession } = shouldResetSession
        ? await ctx.helpers.resetSessionContext(
          ctx.msg.channelType,
          ctx.msg.chatId,
          switchedRepo ? 'cd' : 'settings',
          { previousCwd: currentCwd, clearProject: switchedRepo, binding },
        )
        : { hadActiveSession: false };

      if (binding) {
        binding.cwd = project.workdir;
        binding.projectName = project.name;
        binding.claudeSettingSources = project.claudeSettingSources
          ? [...project.claudeSettingSources]
          : undefined;
        await ctx.store.saveBinding(binding);
      } else {
        await ctx.router.rebind(ctx.msg.channelType, ctx.msg.chatId, generateSessionId(), {
          cwd: project.workdir,
          projectName: project.name,
          claudeSettingSources: project.claudeSettingSources
            ? [...project.claudeSettingSources]
            : undefined,
        });
      }
      ctx.workspace.pushHistory(ctx.msg.channelType, ctx.msg.chatId, project.workdir);
      ctx.workspace.setBinding(ctx.msg.channelType, ctx.msg.chatId, project.workdir);

      const feedbackParts: string[] = [];
      if (previousProjectName && previousProjectName !== project.name) {
        feedbackParts.push(`已从项目 ${previousProjectName} 切换`);
      } else {
        feedbackParts.push(`已切换到项目 ${project.name}`);
      }
      feedbackParts.push(`工作区更新为 ${shortPath(project.workdir)}`);
      if (hadActiveSession && switchedRepo) {
        feedbackParts.push('已关闭旧项目的活跃会话');
      } else if (hadActiveSession && settingsChanged) {
        feedbackParts.push('已应用项目设置并重置会话');
      }

      await this.send(ctx, presentProjectSwitched(ctx.msg.chatId, {
        projectName: project.name,
        workdir: shortPath(project.workdir),
        feedbackText: feedbackParts.join('，'),
      }));
      return true;
    }

    // /project status - show current project status
    if (sub === 'status' || sub === 'info') {
      const binding = await ctx.store.getBinding(ctx.msg.channelType, ctx.msg.chatId);
      const currentProjectName = binding?.projectName;
      const currentCwd = binding?.cwd || ctx.defaultWorkdir;
      const workspaceBinding = ctx.workspace.getBinding(ctx.msg.channelType, ctx.msg.chatId);

      if (!currentProjectName) {
        const implicitName = basename(currentCwd);
        await this.send(ctx, presentProjectInfoExtended(ctx.msg.chatId, {
          projectName: implicitName,
          workdir: shortPath(currentCwd),
          isImplicit: true,
          workspaceBinding: workspaceBinding ? shortPath(workspaceBinding) : undefined,
        }));
      } else {
        const project = getProjectByName(projectsConfig.valid, currentProjectName);
        await this.send(ctx, presentProjectInfoExtended(ctx.msg.chatId, {
          projectName: currentProjectName,
          workdir: project ? shortPath(project.workdir) : shortPath(currentCwd),
          isImplicit: false,
          workspaceBinding: workspaceBinding ? shortPath(workspaceBinding) : undefined,
          isValidProject: !!project,
        }));
      }
      return true;
    }

    await this.send(ctx, presentProjectUsage(ctx.msg.chatId));
    return true;
  }
}