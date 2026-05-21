import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentSessions, presentSessionDetail, presentNoSessions } from '../messages/presenter.js';
import {
  scanAgentSessions,
  readSessionTranscriptPreview,
} from '../../providers/session-scanner.js';
import {
  normalizeAgentProviderKind,
  sameAgentSession,
  type AgentProviderKind,
} from '../../providers/kinds.js';
import { historyProviderKinds } from '../../providers/history.js';
import { shortPath } from '../../core/path.js';
import { generateSessionId } from '../../core/id.js';
import { isSameRepoRoot } from '../../utils/repo.js';
import { FLAGS, hasFlag, getNonFlagArg } from '../../core/args.js';
import { SESSION_STALE_THRESHOLD_MS } from '../../core/timing.js';
import { formatSize, formatSessionDate } from '../../formatting/session-format.js';
import { parseSessionIndex, scanSessionsForContext } from './session-parser.js';
import { chatKey, chatScopeId } from '../../core/key.js';
import { truncate } from '../../core/string.js';
import { withInboundReplyContext } from '../../channels/reply-context.js';
import type { TopicSessionRecord } from '../state/topic-sessions.js';
import type { ScannedSession } from '../../providers/session-scanner.js';

/** Verbose flag for session detail view */
const VERBOSE_FLAG = { long: '--verbose', short: '-v' };

type AgentSessionTarget = Pick<
  ScannedSession,
  'provider' | 'providerDisplayName' | 'sdkSessionId' | 'cwd' | 'preview'
>;

function providerDisplayName(ctx: CommandContext, provider: AgentProviderKind | undefined): string {
  const normalized = normalizeAgentProviderKind(provider);
  return ctx.services.providers.descriptor(normalized)?.displayName ?? normalized;
}

function parseContinueToken(
  token: string,
  ctx: CommandContext,
): { provider?: AgentProviderKind; sdkSessionId: string } {
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

function buildTopicTitle(target: AgentSessionTarget): string {
  const preview = target.preview.replace(/\s+/g, ' ').trim();
  return truncate(
    preview || `${target.providerDisplayName} 会话 ${target.sdkSessionId.slice(0, 8)}`,
    120,
  );
}

function buildThreadIntro(target: AgentSessionTarget): string {
  return `💬 已连接 ${target.providerDisplayName} 会话 \`${target.sdkSessionId.slice(0, 8)}\` · ${shortPath(target.cwd)}\n\n请在本话题内继续发送消息。`;
}

async function sendPlain(ctx: CommandContext, text: string): Promise<void> {
  await ctx.adapter.send(withInboundReplyContext({ chatId: ctx.msg.chatId, text }, ctx.msg) as any);
}

async function sendSessionIndexError(
  ctx: CommandContext,
  idx: number,
  error: string,
): Promise<void> {
  await ctx.adapter.send(
    withInboundReplyContext(
      {
        chatId: ctx.msg.chatId,
        text:
          error === 'invalid_index'
            ? '请输入有效的会话编号。使用 /session 查看列表。'
            : `会话 #${idx} 不存在。使用 /session 查看列表。`,
      },
      ctx.msg,
    ) as any,
  );
}

async function ensureTopicBinding(
  ctx: CommandContext,
  record: TopicSessionRecord,
  target: AgentSessionTarget,
): Promise<void> {
  const existing = await ctx.services.store.getBinding(record.channelType, record.scopeId);
  const source =
    existing ?? (await ctx.services.store.getBinding(ctx.msg.channelType, ctx.scopeId));
  await ctx.services.router.rebind(
    record.channelType,
    record.scopeId,
    existing?.sessionId ?? generateSessionId(),
    {
      sdkSessionId: target.sdkSessionId,
      provider: target.provider,
      cwd: target.cwd,
      agentSettingSources: existing?.agentSettingSources ?? source?.agentSettingSources,
      projectName: existing?.projectName ?? source?.projectName,
    },
  );
  ctx.services.workspace.pushHistory(record.channelType, record.scopeId, target.cwd);
  ctx.helpers.updateWorkspaceBindingFromPath(record.channelType, record.scopeId, target.cwd);
}

async function notifyExistingTopic(
  ctx: CommandContext,
  record: TopicSessionRecord,
  target: AgentSessionTarget,
): Promise<void> {
  const sdkShort = target.sdkSessionId.slice(0, 8);
  const text = `▶️ 已回到 ${target.providerDisplayName} 会话 \`${sdkShort}\`\n\n请在本话题内发送消息继续。`;
  const outMsg = ctx.adapter.formatContent(record.chatId, text);
  const replyTarget = record.lastMessageId ?? record.rootMessageId;
  if (!replyTarget) {
    await sendPlain(ctx, '⚠️ 已找到会话记录，但缺少话题消息锚点，请从工作台重新开启话题。');
    return;
  }
  const result = await ctx.adapter.send({
    ...outMsg,
    threadId: record.threadId,
    replyToMessageId: replyTarget,
    replyInThread: true,
  } as any);
  ctx.services.topicSessions?.upsert({
    ...record,
    sdkSessionId: target.sdkSessionId,
    provider: target.provider,
    cwd: target.cwd,
    title: record.title || target.preview,
    preview: target.preview,
    lastMessageId: result.messageId || record.lastMessageId,
  });
}

async function continueAgentSession(
  ctx: CommandContext,
  target: AgentSessionTarget,
  idxLabel?: string,
): Promise<boolean> {
  const topicSessions = ctx.services.topicSessions;
  const existingTopic = topicSessions?.findBySdkSession(target.provider, target.sdkSessionId);
  if (existingTopic) {
    await ensureTopicBinding(ctx, existingTopic, target);
    await notifyExistingTopic(ctx, existingTopic, target);
    return true;
  }

  const currentBinding = await ctx.services.store.getBinding(ctx.msg.channelType, ctx.scopeId);

  const startThreadWithTitle = (ctx.adapter as any).startThreadWithTitle;
  const startThread = (ctx.adapter as any).startThreadFromMessage;
  const topicTitle = buildTopicTitle(target);
  const introText = buildThreadIntro(target);
  if (
    (typeof startThreadWithTitle === 'function' || typeof startThread === 'function') &&
    ctx.msg.messageId
  ) {
    const started =
      typeof startThreadWithTitle === 'function'
        ? await startThreadWithTitle
            .call(ctx.adapter, ctx.msg.chatId, topicTitle, introText)
            .catch(() => null)
        : await startThread
            .call(ctx.adapter, ctx.msg.chatId, ctx.msg.messageId, introText)
            .catch(() => null);
    if (started?.threadId && started?.messageId) {
      const scopeId = chatScopeId(ctx.msg.chatId, started.threadId);
      await ctx.services.router.rebind(ctx.msg.channelType, scopeId, generateSessionId(), {
        sdkSessionId: target.sdkSessionId,
        provider: target.provider,
        cwd: target.cwd,
        agentSettingSources: currentBinding?.agentSettingSources,
        projectName: currentBinding?.projectName,
      });
      ctx.services.workspace.pushHistory(ctx.msg.channelType, scopeId, target.cwd);
      ctx.helpers.updateWorkspaceBindingFromPath(ctx.msg.channelType, scopeId, target.cwd);
      topicSessions?.upsert({
        channelType: ctx.msg.channelType,
        chatId: ctx.msg.chatId,
        scopeId,
        threadId: started.threadId,
        rootMessageId: started.rootMessageId ?? started.messageId,
        lastMessageId: started.messageId,
        sdkSessionId: target.sdkSessionId,
        provider: target.provider,
        cwd: target.cwd,
        title: topicTitle,
        preview: target.preview,
      });
      return true;
    }
  }

  const switchedRepo = !isSameRepoRoot(
    currentBinding?.cwd || ctx.services.defaultWorkdir,
    target.cwd,
  );
  await ctx.services.router.rebind(ctx.msg.channelType, ctx.scopeId, generateSessionId(), {
    sdkSessionId: target.sdkSessionId,
    provider: target.provider,
    cwd: target.cwd,
    agentSettingSources: currentBinding?.agentSettingSources,
    projectName: switchedRepo ? undefined : currentBinding?.projectName,
  });
  ctx.services.workspace.pushHistory(ctx.msg.channelType, ctx.scopeId, target.cwd);
  ctx.helpers.updateWorkspaceBindingFromPath(ctx.msg.channelType, ctx.scopeId, target.cwd);
  await sendPlain(
    ctx,
    `✅ 已切换到 ${target.providerDisplayName} 会话${idxLabel ? ` #${idxLabel}` : ''}：${shortPath(target.cwd)}\n${target.preview}`,
  );
  return true;
}

export class SessionCommand extends BaseCommand {
  readonly name = '/session';
  readonly quick = true;
  readonly helpCategory = 'session' as const;
  readonly description = '会话管理';
  readonly helpDesc = `列出或切换 Agent 会话。
无参数时列出当前工作区的会话。
使用 -a 列出所有项目的会话。
指定编号切换到对应会话。
使用 -v 查看会话详情。`;
  readonly helpExample = '/session · /session -a · /session 3 · /session 3 -v';

  async execute(ctx: CommandContext): Promise<boolean> {
    const args = ctx.parts.slice(1);
    const showAll = hasFlag(args, FLAGS.ALL);
    const showVerbose = hasFlag(args, VERBOSE_FLAG);
    const indexArg = getNonFlagArg(args, [FLAGS.ALL, VERBOSE_FLAG]);

    // Parse index if provided
    const idx = indexArg ? parseInt(indexArg, 10) : NaN;
    const hasIndex = !Number.isNaN(idx) && idx > 0;

    if (showVerbose && hasIndex) {
      // /session 3 -v -> show session detail
      return this.showSessionDetail(ctx, idx);
    } else if (hasIndex) {
      // /session 3 -> switch to session
      return this.switchToSession(ctx, idx);
    } else {
      // /session or /session -a -> list sessions
      return this.listSessions(ctx, showAll);
    }
  }

  /** List available sessions */
  private async listSessions(ctx: CommandContext, showAll: boolean): Promise<boolean> {
    const scopeId = ctx.scopeId;
    const { binding, currentCwd, sessions } = await scanSessionsForContext(ctx, showAll);
    const currentSdkId = binding?.sdkSessionId;
    const workspaceBinding = ctx.services.workspace.getBinding(ctx.msg.channelType, scopeId);

    if (sessions.length === 0) {
      const hint = showAll
        ? ''
        : ` in ${shortPath(currentCwd)}\nUse /session -a to see all projects.`;
      await this.send(ctx, presentNoSessions(ctx.msg.chatId, hint));
      return true;
    }

    const now = Date.now();
    const sessionData = sessions.map((s, i) => ({
      index: i + 1,
      provider: s.provider,
      providerDisplayName: s.providerDisplayName,
      date: formatSessionDate(s.mtime, ctx.locale),
      cwd: shortPath(s.cwd),
      size: formatSize(s.size),
      preview: s.preview,
      isCurrent: sameAgentSession(binding?.provider, currentSdkId, s.provider, s.sdkSessionId),
      isStale: now - s.mtime > SESSION_STALE_THRESHOLD_MS,
    }));

    const filterHint = showAll ? ' (all projects)' : ` (${shortPath(currentCwd)})`;
    await this.send(
      ctx,
      presentSessions(ctx.msg.chatId, {
        workspaceBinding: workspaceBinding ? shortPath(workspaceBinding) : undefined,
        sessions: sessionData,
        filterHint,
        showAll,
      }),
    );
    return true;
  }

  /** Switch to a specific session */
  private async switchToSession(ctx: CommandContext, idx: number): Promise<boolean> {
    const result = await parseSessionIndex(ctx);

    if (!result.ok) {
      await sendSessionIndexError(ctx, idx, result.error);
      return true;
    }

    const { target } = result;
    const existingTopic = ctx.services.topicSessions?.findBySdkSession(
      target.provider,
      target.sdkSessionId,
    );

    // Check if target sdkSession is bound to another active bridge session
    const allBindings = await ctx.services.store.listBindings();
    for (const b of allBindings) {
      if (sameAgentSession(b.provider, b.sdkSessionId, target.provider, target.sdkSessionId)) {
        const bChatKey = chatKey(b.channelType, b.chatId);
        const isActive = ctx.services.activeControls?.has(bChatKey) ?? false;
        if (b.channelType === ctx.msg.channelType && b.chatId === ctx.scopeId) {
          break;
        }
        if (existingTopic) {
          break;
        }
        if (isActive) {
          await this.send(ctx, {
            chatId: ctx.msg.chatId,
            text: `⚠️ 会话 #${idx} 正在 ${b.chatId.slice(-4)} 活跃执行中\n\n请等待任务完成后再切换，或使用 /stop 中断后切换。`,
          });
          return true;
        }
        break;
      }
    }

    return continueAgentSession(ctx, target, String(idx));
  }

  /** Show detailed session info */
  private async showSessionDetail(ctx: CommandContext, idx: number): Promise<boolean> {
    const result = await parseSessionIndex(ctx);

    if (!result.ok) {
      await sendSessionIndexError(ctx, idx, result.error);
      return true;
    }

    const { target } = result;
    const transcript = readSessionTranscriptPreview(target, 4).map((item) => ({
      role: item.role,
      text: item.text,
    }));

    await this.send(
      ctx,
      presentSessionDetail(ctx.msg.chatId, {
        index: idx,
        provider: target.provider,
        providerDisplayName: target.providerDisplayName,
        cwd: shortPath(target.cwd),
        preview: target.preview,
        date: formatSessionDate(target.mtime, ctx.locale),
        size: formatSize(target.size),
        transcript,
      }),
    );
    return true;
  }
}

/** Hidden callback command: continue an agent session by provider/session id. */
export class ContinueSessionCommand extends BaseCommand {
  readonly name = '/continue';
  readonly quick = true;
  readonly helpCategory = 'session' as const;
  readonly description = undefined;

  async execute(ctx: CommandContext): Promise<boolean> {
    const token = ctx.parts[1]?.trim();
    if (!token) {
      await sendPlain(ctx, '⚠️ 用法: /continue <provider>:<sdkSessionId>');
      return true;
    }

    const parsed = parseContinueToken(token, ctx);
    const target = scanAgentSessions(
      50,
      undefined,
      historyProviderKinds(ctx.services.providers),
    ).find(
      (s) =>
        s.sdkSessionId === parsed.sdkSessionId &&
        (!parsed.provider || s.provider === parsed.provider),
    );
    const topic = parsed.provider
      ? ctx.services.topicSessions?.findBySdkSession(parsed.provider, parsed.sdkSessionId)
      : ctx.services.topicSessions?.findBySdkSessionId(parsed.sdkSessionId);
    const provider = normalizeAgentProviderKind(
      target?.provider ?? parsed.provider ?? topic?.provider,
    );
    const displayName = target?.providerDisplayName ?? providerDisplayName(ctx, provider);
    if (!target && !topic) {
      await sendPlain(ctx, `⚠️ 未找到该 ${displayName} 会话，可能已被清理。`);
      return true;
    }

    return continueAgentSession(
      ctx,
      target ?? {
        provider,
        providerDisplayName: displayName,
        sdkSessionId: parsed.sdkSessionId,
        cwd: topic?.cwd || ctx.services.defaultWorkdir,
        preview: topic?.preview || topic?.title || `${displayName} 会话`,
      },
    );
  }
}
