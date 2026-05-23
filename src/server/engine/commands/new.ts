import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentNewSession, presentHome } from '../../presentation/command-presenter.js';
import { generateSessionId } from '../../../shared/core/id.js';
import { t } from '../../../shared/i18n/index.js';
import type { AgentProviderKind } from '../../../shared/providers/kinds.js';
import type { ChannelBinding } from '../../store/interface.js';
import { startWorkbenchTopic } from '../services/topic-starter.js';

interface NewSessionProviderChoice {
  kind: AgentProviderKind;
  displayName: string;
}

interface NewSessionClientChoice {
  clientId?: string;
  cwd?: string;
}

export class NewCommand extends BaseCommand {
  readonly name = '/new';
  readonly quick = true;
  readonly helpCategory = 'session' as const;
  readonly description = '新建会话';
  readonly helpDesc = '在工作台中新建一个话题会话；可用 /new <engine> 选择执行引擎。';
  readonly helpExample = '/new <engine>';

  async execute(ctx: CommandContext): Promise<boolean> {
    const scopeId = ctx.scopeId;
    const previousBinding = await ctx.services.store.getBinding(ctx.msg.channelType, scopeId);
    const providerChoice = await this.resolveProviderChoice(ctx, previousBinding);
    if (!providerChoice) return true;
    const clientChoice = await this.resolveClientChoice(ctx, previousBinding);
    if (!clientChoice) return true;
    const hadActiveSession = previousBinding
      ? (ctx.services.sdkEngine?.hasSessionContext?.(
          ctx.msg.channelType,
          scopeId,
          previousBinding.sessionId,
        ) ??
          false) ||
        !!previousBinding.sdkSessionId
      : false;

    const newSessionId = generateSessionId();
    if (
      await this.openWorkbenchTopic(
        ctx,
        previousBinding,
        newSessionId,
        providerChoice,
        clientChoice,
      )
    ) {
      return true;
    }

    await ctx.services.router.rebind(ctx.msg.channelType, scopeId, newSessionId, {
      provider: providerChoice.kind,
      clientId: clientChoice.clientId,
      cwd: clientChoice.cwd ?? previousBinding?.cwd,
      agentSettingSources: previousBinding?.agentSettingSources,
      projectName: previousBinding?.projectName,
    });
    const permissionMode =
      ctx.surface === 'workbench'
        ? ctx.services.state.getPermMode(ctx.msg.channelType, scopeId)
        : ctx.services.state.getPermMode(ctx.msg.channelType, scopeId, previousBinding?.sessionId);
    ctx.services.state.setPermMode(ctx.msg.channelType, scopeId, newSessionId, permissionMode);

    ctx.services.state.clearLastActive(ctx.msg.channelType, scopeId);

    const feedbackText = hadActiveSession ? t('newSession.feedbackText') : undefined;
    await this.send(
      ctx,
      presentNewSession(ctx.msg.chatId, {
        cwd: clientChoice.cwd ?? previousBinding?.cwd,
        feedbackText,
      }),
    );

    if (ctx.surface === 'workbench') {
      const homeData = await ctx.helpers.buildHomePayload(ctx.msg.channelType, scopeId, ctx.locale);
      homeData.task.active = false;
      await this.send(ctx, presentHome(ctx.msg.chatId, homeData));
    }
    return true;
  }

  private async resolveClientChoice(
    ctx: CommandContext,
    previousBinding: ChannelBinding | null,
  ): Promise<NewSessionClientChoice | null> {
    const clients = ctx.services.getExecutionClients?.() ?? [];
    const requested = ctx.parts[2]?.trim();
    if (requested) {
      const client = clients.find((entry) => entry.clientId === requested);
      if (!client) {
        await this.send(ctx, { chatId: ctx.msg.chatId, text: `⚠️ 未找到 client: ${requested}` });
        return null;
      }
      return {
        clientId: client.clientId,
        cwd: client.workspaces.find((workspace) => workspace.isDefault)?.path ?? previousBinding?.cwd,
      };
    }

    const selected =
      (previousBinding?.clientId &&
        clients.find((entry) => entry.clientId === previousBinding.clientId)) ||
      (clients.length === 1 ? clients[0] : undefined);
    return {
      clientId: selected?.clientId ?? previousBinding?.clientId,
      cwd:
        selected?.workspaces.find((workspace) => workspace.isDefault)?.path ??
        previousBinding?.cwd,
    };
  }

  private async resolveProviderChoice(
    ctx: CommandContext,
    previousBinding: ChannelBinding | null,
  ): Promise<NewSessionProviderChoice | null> {
    const requested = ctx.parts[1]?.trim().toLowerCase();
    const defaultKind =
      ctx.services.providers.availableForNewSession()[0]?.kind ??
      ctx.services.providers.defaultProviderKind;
    const kind = requested || previousBinding?.provider || defaultKind;
    if (!ctx.services.providers.isKnown(kind)) {
      const availableKinds =
        ctx.services.providers
          .availableForNewSession()
          .map((provider) => provider.kind)
          .join(' / ') || 'none';
      await this.send(ctx, {
        chatId: ctx.msg.chatId,
        text: `⚠️ 不支持的会话类型: ${requested}。可用: ${availableKinds}`,
      });
      return null;
    }

    const provider = ctx.services.providers.get(kind);
    if (!provider) {
      const descriptor = ctx.services.providers.descriptor(kind);
      const reason = descriptor?.reason ? `\n原因: ${descriptor.reason}` : '';
      await this.send(ctx, {
        chatId: ctx.msg.chatId,
        text: `⚠️ ${descriptor?.displayName ?? kind} provider 当前不可用。${reason}`,
      });
      return null;
    }

    return {
      kind,
      displayName: ctx.services.providers.descriptor(kind)?.displayName ?? provider.displayName,
    };
  }

  private async openWorkbenchTopic(
    ctx: CommandContext,
    previousBinding: Awaited<ReturnType<CommandContext['services']['store']['getBinding']>>,
    newSessionId: string,
    providerChoice: NewSessionProviderChoice,
    clientChoice: NewSessionClientChoice,
  ): Promise<boolean> {
    const cwd = clientChoice.cwd || previousBinding?.cwd || ctx.services.defaultWorkdir;
    const title = `新 ${providerChoice.displayName} 会话`;
    const intro = `💬 已开启新话题，请在本话题内继续发送消息。`;
    const topic = await startWorkbenchTopic(ctx, title, intro);
    if (!topic) return false;

    const topicScopeId = topic.scopeId;
    await ctx.services.router.rebind(ctx.msg.channelType, topicScopeId, newSessionId, {
      provider: providerChoice.kind,
      clientId: clientChoice.clientId,
      cwd,
      agentSettingSources: previousBinding?.agentSettingSources,
      projectName: previousBinding?.projectName,
    });
    ctx.services.state.setPermMode(
      ctx.msg.channelType,
      topicScopeId,
      newSessionId,
      ctx.services.state.getPermMode(ctx.msg.channelType, ctx.scopeId),
    );
    ctx.services.workspace.pushHistory(ctx.msg.channelType, topicScopeId, cwd);
    ctx.helpers.updateWorkspaceBindingFromPath(ctx.msg.channelType, topicScopeId, cwd);
    ctx.services.topicSessions?.upsert({
      channelType: ctx.msg.channelType,
      chatId: ctx.msg.chatId,
      scopeId: topicScopeId,
      threadId: topic.threadId,
      rootMessageId: topic.rootMessageId,
      lastMessageId: topic.lastMessageId,
      provider: providerChoice.kind,
      clientId: clientChoice.clientId,
      cwd,
      title,
      preview: title,
    });
    return true;
  }
}
