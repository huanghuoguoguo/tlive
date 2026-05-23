import { generateSessionId } from '../../core/id.js';
import { shortPath } from '../../core/path.js';
import { truncate } from '../../core/string.js';
import { withInboundReplyContext } from '../../channels/reply-context.js';
import { historyProviderKinds } from '../../providers/history.js';
import { normalizeAgentProviderKind, type AgentProviderKind } from '../../providers/kinds.js';
import { scanAgentSessions, type ScannedSession } from '../../providers/session-scanner.js';
import type { TopicSessionRecord } from '../state/topic-sessions.js';
import type { CommandContext } from '../commands/types.js';
import { startWorkbenchTopic } from './topic-starter.js';
import { t } from '../../i18n/index.js';

type AgentSessionTarget = Pick<
  ScannedSession,
  'provider' | 'providerDisplayName' | 'sdkSessionId' | 'cwd' | 'preview'
>;

type ParsedResumeToken = {
  provider?: AgentProviderKind;
  sdkSessionId: string;
};

function parseResumeToken(token: string, ctx: CommandContext): ParsedResumeToken {
  const separator = token.indexOf(':');
  if (separator > 0) {
    const maybeProvider = token.slice(0, separator);
    if (ctx.services.providers.isKnown(maybeProvider)) {
      return {
        provider: maybeProvider,
        sdkSessionId: token.slice(separator + 1),
      };
    }
  }
  return { sdkSessionId: token };
}

function providerDisplayName(ctx: CommandContext, provider: AgentProviderKind | undefined): string {
  const normalized = normalizeAgentProviderKind(provider);
  return ctx.services.providers.descriptor(normalized)?.displayName ?? normalized;
}

function buildTopicTitle(target: AgentSessionTarget, _locale: string): string {
  const preview = target.preview.replace(/\s+/g, ' ').trim();
  return truncate(
    preview ||
      t('topicResume.sessionPreview').replace(
        '{provider}',
        target.providerDisplayName,
      ),
    120,
  );
}

function buildThreadIntro(target: AgentSessionTarget, _locale: string): string {
  return t('topicResume.connected')
    .replace('{provider}', target.providerDisplayName)
    .replace('{sessionId}', target.sdkSessionId.slice(0, 8))
    .replace('{cwd}', shortPath(target.cwd));
}

async function sendPlain(ctx: CommandContext, text: string): Promise<void> {
  await ctx.adapter.send(withInboundReplyContext({ chatId: ctx.msg.chatId, text }, ctx.msg));
}

export class TopicResumeService {
  constructor(private readonly ctx: CommandContext) {}

  async resume(token: string): Promise<boolean> {
    const parsed = parseResumeToken(token, this.ctx);
    const target = this.findScannedTarget(parsed);
    const topic = this.findTopic(parsed, target);
    const provider = normalizeAgentProviderKind(
      target?.provider ?? parsed.provider ?? topic?.provider,
    );
    const displayName = target?.providerDisplayName ?? providerDisplayName(this.ctx, provider);

    if (!target && !topic) {
      await sendPlain(
        this.ctx,
        t('topicResume.sessionNotFound').replace('{provider}', displayName),
      );
      return true;
    }

    const resolvedTarget: AgentSessionTarget = target ?? {
      provider,
      providerDisplayName: displayName,
      sdkSessionId: parsed.sdkSessionId,
      cwd: topic?.cwd || this.ctx.services.defaultWorkdir,
      preview:
        topic?.preview ||
        topic?.title ||
        t('topicResume.sessionPreview').replace('{provider}', displayName),
    };

    if (topic) {
      await this.bindExistingTopic(topic, resolvedTarget);
      await this.notifyExistingTopic(topic, resolvedTarget);
      return true;
    }

    await this.openNewTopic(resolvedTarget);
    return true;
  }

  private findScannedTarget(parsed: ParsedResumeToken): AgentSessionTarget | undefined {
    return scanAgentSessions(50, undefined, historyProviderKinds(this.ctx.services.providers)).find(
      (session) =>
        session.sdkSessionId === parsed.sdkSessionId &&
        (!parsed.provider || session.provider === parsed.provider),
    );
  }

  private findTopic(
    parsed: ParsedResumeToken,
    target: AgentSessionTarget | undefined,
  ): TopicSessionRecord | undefined {
    const topicSessions = this.ctx.services.topicSessions;
    if (!topicSessions) return undefined;
    const provider = target?.provider ?? parsed.provider;
    return provider
      ? topicSessions.findBySdkSession(provider, parsed.sdkSessionId)
      : topicSessions.findBySdkSessionId(parsed.sdkSessionId);
  }

  private async bindExistingTopic(
    record: TopicSessionRecord,
    target: AgentSessionTarget,
  ): Promise<void> {
    const existing = await this.ctx.services.store.getBinding(record.channelType, record.scopeId);
    const source =
      existing ??
      (await this.ctx.services.store.getBinding(this.ctx.msg.channelType, this.ctx.scopeId));
    await this.ctx.services.router.rebind(
      record.channelType,
      record.scopeId,
      existing?.sessionId ?? generateSessionId(),
      {
        sdkSessionId: target.sdkSessionId,
        provider: target.provider,
        clientId: existing?.clientId ?? source?.clientId ?? record.clientId,
        cwd: target.cwd,
        agentSettingSources: existing?.agentSettingSources ?? source?.agentSettingSources,
        projectName: existing?.projectName ?? source?.projectName,
      },
    );
    this.ctx.services.workspace.pushHistory(record.channelType, record.scopeId, target.cwd);
    this.ctx.helpers.updateWorkspaceBindingFromPath(record.channelType, record.scopeId, target.cwd);
  }

  private async notifyExistingTopic(
    record: TopicSessionRecord,
    target: AgentSessionTarget,
  ): Promise<void> {
    const sdkShort = target.sdkSessionId.slice(0, 8);
    const text = t('topicResume.resumed')
      .replace('{provider}', target.providerDisplayName)
      .replace('{sessionId}', sdkShort);
    const replyTarget = record.lastMessageId ?? record.rootMessageId;
    if (!replyTarget) {
      await sendPlain(this.ctx, t('topicResume.anchorMissing'));
      return;
    }

    const result = await this.ctx.adapter.send({
      ...this.ctx.adapter.formatContent(record.chatId, text),
      threadId: record.threadId,
      replyToMessageId: replyTarget,
      replyInThread: true,
    });
    this.ctx.services.topicSessions?.upsert({
      ...record,
      sdkSessionId: target.sdkSessionId,
      provider: target.provider,
      clientId: record.clientId,
      cwd: target.cwd,
      title: record.title || target.preview,
      preview: target.preview,
      lastMessageId: result.messageId || record.lastMessageId,
    });
  }

  private async openNewTopic(target: AgentSessionTarget): Promise<void> {
    if (this.ctx.surface !== 'workbench' || !this.ctx.msg.messageId) {
      await sendPlain(this.ctx, t('topicResume.fromWorkbench'));
      return;
    }

    const topicTitle = buildTopicTitle(target, this.ctx.locale);
    const introText = buildThreadIntro(target, this.ctx.locale);
    const topic = await startWorkbenchTopic(this.ctx, topicTitle, introText);

    if (!topic) {
      await sendPlain(this.ctx, t('topicResume.createFailed'));
      return;
    }

    const currentBinding = await this.ctx.services.store.getBinding(
      this.ctx.msg.channelType,
      this.ctx.scopeId,
    );
    const scopeId = topic.scopeId;
    await this.ctx.services.router.rebind(this.ctx.msg.channelType, scopeId, generateSessionId(), {
      sdkSessionId: target.sdkSessionId,
      provider: target.provider,
      clientId: currentBinding?.clientId,
      cwd: target.cwd,
      agentSettingSources: currentBinding?.agentSettingSources,
      projectName: currentBinding?.projectName,
    });
    this.ctx.services.workspace.pushHistory(this.ctx.msg.channelType, scopeId, target.cwd);
    this.ctx.helpers.updateWorkspaceBindingFromPath(this.ctx.msg.channelType, scopeId, target.cwd);
    this.ctx.services.topicSessions?.upsert({
      channelType: this.ctx.msg.channelType,
      chatId: this.ctx.msg.chatId,
      scopeId,
      threadId: topic.threadId,
      rootMessageId: topic.rootMessageId,
      lastMessageId: topic.lastMessageId,
      sdkSessionId: target.sdkSessionId,
      provider: target.provider,
      clientId: currentBinding?.clientId,
      cwd: target.cwd,
      title: topicTitle,
      preview: target.preview,
    });
  }
}
