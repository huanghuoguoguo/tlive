import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { ClaudeSettingSource } from '../config.js';
import type { BridgeManager } from '../engine/coordinators/bridge-manager.js';
import type { ProjectConfig } from '../store/interface.js';

/** Build a consistent chat key from channelType and chatId */
export function buildChatKey(channelType: string, chatId: string): string {
  return `${channelType}:${chatId}`;
}

/** Expand tilde (~) in path to home directory */
export function expandPath(path: string): string {
  if (path.startsWith('~')) {
    return join(homedir(), path.slice(1));
  }
  return resolve(path);
}

/** Compare two ClaudeSettingSource arrays for equality */
export function areSettingSourcesEqual(
  current: ClaudeSettingSource[] | undefined,
  next: ClaudeSettingSource[] | undefined,
): boolean {
  const left = current ?? [];
  const right = next ?? [];
  return left.length === right.length && left.every((source, index) => source === right[index]);
}

/** Resolved route for automation delivery */
export interface AutomationRoute {
  channelType: string;
  chatId: string;
  workdir?: string;
  projectName?: string;
  claudeSettingSources?: ClaudeSettingSource[];
}

/** Options for resolving automation route */
export interface ResolveAutomationRouteOptions {
  /** Explicit channel type */
  channelType?: string;
  /** Explicit chat ID */
  chatId?: string;
  /** Project name for project-based routing */
  projectName?: string;
  /** Project configurations */
  projects?: ProjectConfig[];
  /** Default project name */
  defaultProject?: string;
  /** Bridge manager for adapter/chat lookups */
  bridge: BridgeManager;
}

/**
 * Resolve routing target for automation (webhook/cron).
 * Priority:
 * 1. Explicit channelType + chatId
 * 2. Explicit projectName (use project's webhookDefaultChat or last active chat)
 * 3. Default project's webhookDefaultChat
 */
export function resolveAutomationRoute(options: ResolveAutomationRouteOptions): AutomationRoute | null {
  const { channelType, chatId, projectName, projects, defaultProject, bridge } = options;

  // Priority 1: Explicit channelType + chatId
  if (channelType && chatId) {
    return { channelType, chatId };
  }

  // Priority 2: Explicit projectName
  if (projectName) {
    const project = projects?.find(p => p.name === projectName);
    if (!project) return null;

    // Use project's configured webhook default chat
    if (project.webhookDefaultChat) {
      return {
        channelType: project.webhookDefaultChat.channelType,
        chatId: project.webhookDefaultChat.chatId,
        workdir: project.workdir,
        projectName: project.name,
        claudeSettingSources: project.claudeSettingSources,
      };
    }

    // Fallback: find last active chat for project's enabled channels
    const enabledChannels = project.channels || bridge.getAdapters().map(a => a.channelType);
    for (const ct of enabledChannels) {
      const lastChatId = bridge.getLastChatId(ct);
      if (lastChatId) {
        return {
          channelType: ct,
          chatId: lastChatId,
          workdir: project.workdir,
          projectName: project.name,
          claudeSettingSources: project.claudeSettingSources,
        };
      }
    }
    return null;
  }

  // Priority 3: Default project
  if (defaultProject && projects) {
    const defaultProj = projects.find(p => p.name === defaultProject);
    if (defaultProj?.webhookDefaultChat) {
      return {
        channelType: defaultProj.webhookDefaultChat.channelType,
        chatId: defaultProj.webhookDefaultChat.chatId,
        workdir: defaultProj.workdir,
        projectName: defaultProj.name,
        claudeSettingSources: defaultProj.claudeSettingSources,
      };
    }
  }

  return null;
}