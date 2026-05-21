import type { AgentSettingSource, ProjectConfig } from '../../store/interface.js';
import type { AutomationBridge } from '../types/automation-bridge.js';
import type { WebhookRequest } from './webhook.js';

export interface ResolvedWebhookRoute {
  channelType: string;
  chatId: string;
  workdir?: string;
  projectName?: string;
  settingSources?: AgentSettingSource[];
}

export interface WebhookRouteResolverOptions {
  bridge: AutomationBridge;
  projects?: ProjectConfig[];
  defaultProject?: string;
}

/**
 * Resolves webhook requests to bridge delivery coordinates.
 *
 * Priority:
 * 1. Explicit sessionId
 * 2. Explicit channelType + chatId
 * 3. Explicit projectName
 * 4. Configured defaultProject
 */
export class WebhookRouteResolver {
  constructor(private readonly options: WebhookRouteResolverOptions) {}

  async resolve(request: WebhookRequest): Promise<ResolvedWebhookRoute | null> {
    if (request.sessionId) {
      return this.resolveSessionRoute(request.sessionId);
    }

    if (request.channelType && request.chatId) {
      return this.resolveExplicitChatRoute(request.channelType, request.chatId);
    }

    if (request.projectName) {
      return this.resolveProjectRoute(request.projectName);
    }

    return this.resolveDefaultProjectRoute();
  }

  private async resolveSessionRoute(sessionId: string): Promise<ResolvedWebhookRoute | null> {
    const binding = await this.options.bridge.getBindingBySessionId(sessionId);
    if (!binding) {
      console.warn(`[webhook] Session '${sessionId}' not found`);
      return null;
    }

    return {
      channelType: binding.channelType,
      chatId: binding.chatId,
      workdir: binding.cwd,
      projectName: binding.projectName,
      settingSources: binding.agentSettingSources,
    };
  }

  private async resolveExplicitChatRoute(
    channelType: string,
    chatId: string,
  ): Promise<ResolvedWebhookRoute> {
    const binding = await this.options.bridge.getBinding(channelType, chatId);
    return {
      channelType,
      chatId,
      workdir: binding?.cwd,
      projectName: binding?.projectName,
      settingSources: binding?.agentSettingSources,
    };
  }

  private resolveProjectRoute(projectName: string): ResolvedWebhookRoute | null {
    const project = this.options.projects?.find((p) => p.name === projectName);
    if (!project) {
      console.warn(`[webhook] Project '${projectName}' not found`);
      return null;
    }

    if (project.webhookDefaultChat) {
      return {
        channelType: project.webhookDefaultChat.channelType,
        chatId: project.webhookDefaultChat.chatId,
        workdir: project.workdir,
        projectName: project.name,
        settingSources: project.agentSettingSources,
      };
    }

    for (const channelType of this.options.bridge.getAdapters().map((adapter) => adapter.channelType)) {
      const lastChatId = this.options.bridge.getLastChatId(channelType);
      if (lastChatId) {
        console.log(
          `[webhook] Project '${projectName}' using last active chat: ${channelType}:${lastChatId.slice(-8)}`,
        );
        return {
          channelType,
          chatId: lastChatId,
          workdir: project.workdir,
          projectName: project.name,
          settingSources: project.agentSettingSources,
        };
      }
    }

    console.warn(`[webhook] Project '${projectName}' has no webhookDefaultChat and no recent chats`);
    return null;
  }

  private resolveDefaultProjectRoute(): ResolvedWebhookRoute | null {
    if (!this.options.defaultProject || !this.options.projects) return null;

    const defaultProject = this.options.projects.find(
      (p) => p.name === this.options.defaultProject,
    );
    if (!defaultProject?.webhookDefaultChat) return null;

    return {
      channelType: defaultProject.webhookDefaultChat.channelType,
      chatId: defaultProject.webhookDefaultChat.chatId,
      workdir: defaultProject.workdir,
      projectName: defaultProject.name,
      settingSources: defaultProject.agentSettingSources,
    };
  }
}
