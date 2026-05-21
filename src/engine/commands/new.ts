import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentNewSession, presentHome } from '../messages/presenter.js';
import { generateSessionId } from '../../core/id.js';
import { t } from '../../i18n/index.js';
import { chatScopeId } from '../../core/key.js';
import type { AgentProviderKind } from '../../providers/kinds.js';
import type { ChannelBinding } from '../../store/interface.js';

interface NewSessionProviderChoice {
  kind: AgentProviderKind;
  displayName: string;
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
    if (await this.openWorkbenchTopic(ctx, previousBinding, newSessionId, providerChoice)) {
      return true;
    }

    await ctx.services.router.rebind(ctx.msg.channelType, scopeId, newSessionId, {
      provider: providerChoice.kind,
      cwd: previousBinding?.cwd,
      agentSettingSources: previousBinding?.agentSettingSources,
      projectName: previousBinding?.projectName,
    });

    ctx.services.state.clearLastActive(ctx.msg.channelType, scopeId);

    const feedbackText = hadActiveSession ? t(ctx.locale, 'newSession.feedbackText') : undefined;
    await this.send(
      ctx,
      presentNewSession(ctx.msg.chatId, { cwd: previousBinding?.cwd, feedbackText }),
    );

    if (ctx.surface === 'workbench') {
      const homeData = await ctx.helpers.buildHomePayload(ctx.msg.channelType, scopeId, ctx.locale);
      homeData.task.active = false;
      await this.send(ctx, presentHome(ctx.msg.chatId, homeData));
    }
    return true;
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
  ): Promise<boolean> {
    if (ctx.surface !== 'workbench' || !ctx.msg.messageId) return false;

    const startThreadWithTitle = (ctx.adapter as any).startThreadWithTitle;
    const startThreadFromMessage = (ctx.adapter as any).startThreadFromMessage;
    if (
      typeof startThreadWithTitle !== 'function' &&
      typeof startThreadFromMessage !== 'function'
    ) {
      return false;
    }

    const cwd = previousBinding?.cwd || ctx.services.defaultWorkdir;
    const title = `新 ${providerChoice.displayName} 会话`;
    const intro = `💬 已开启新话题，请在本话题内继续发送消息。`;
    const started =
      typeof startThreadWithTitle === 'function'
        ? await startThreadWithTitle
            .call(ctx.adapter, ctx.msg.chatId, title, intro)
            .catch(() => null)
        : await startThreadFromMessage
            .call(ctx.adapter, ctx.msg.chatId, ctx.msg.messageId, intro)
            .catch(() => null);
    if (!started?.threadId || !started?.messageId) return false;

    const topicScopeId = chatScopeId(ctx.msg.chatId, started.threadId);
    await ctx.services.router.rebind(ctx.msg.channelType, topicScopeId, newSessionId, {
      provider: providerChoice.kind,
      cwd,
      agentSettingSources: previousBinding?.agentSettingSources,
      projectName: previousBinding?.projectName,
    });
    ctx.services.workspace.pushHistory(ctx.msg.channelType, topicScopeId, cwd);
    ctx.helpers.updateWorkspaceBindingFromPath(ctx.msg.channelType, topicScopeId, cwd);
    ctx.services.topicSessions?.upsert({
      channelType: ctx.msg.channelType,
      chatId: ctx.msg.chatId,
      scopeId: topicScopeId,
      threadId: started.threadId,
      rootMessageId: started.rootMessageId ?? started.messageId,
      lastMessageId: started.messageId,
      provider: providerChoice.kind,
      cwd,
      title,
      preview: title,
    });
    return true;
  }
}
