import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentHome } from '../messages/presenter.js';
import type { FormattableMessage } from '../../formatting/message-types.js';
import { t } from '../../i18n/index.js';

async function buildHomeMessage(ctx: CommandContext): Promise<FormattableMessage> {
  return presentHome(
    ctx.msg.chatId,
    await ctx.helpers.buildHomePayload(ctx.msg.channelType, ctx.scopeId, ctx.locale),
  );
}

export class HomeCommand extends BaseCommand {
  readonly name = '/home';
  readonly quick = true;
  readonly helpCategory = 'status' as const;
  readonly description = '显示主界面';
  readonly helpDesc =
    '显示主控制面板，包括当前会话状态、历史会话列表、工作区切换按钮等。是查看和管理工作区的主要入口。';
  readonly helpExample = '/home';

  async execute(ctx: CommandContext): Promise<boolean> {
    await this.send(ctx, await buildHomeMessage(ctx));
    return true;
  }
}

export class TliveCommand extends BaseCommand {
  readonly name = '/tlive';
  readonly quick = true;
  readonly helpCategory = 'status' as const;
  readonly description = '打开工作台';
  readonly helpDesc =
    '打开 TLive 工作台。主窗口用于新建会话、回到话题和诊断；/stop 只在具体话题内中断任务。';
  readonly helpExample = '/tlive';

  async execute(ctx: CommandContext): Promise<boolean> {
    await this.send(ctx, await buildHomeMessage(ctx));
    return true;
  }
}

const TOPIC_DETAIL_LIMIT = 8;
const HISTORY_DETAIL_LIMIT = 10;

export class HomeTopicsCommand extends BaseCommand {
  readonly name = '/home-topics';
  readonly quick = true;
  readonly helpCategory = 'status' as const;
  readonly description = undefined;

  async execute(ctx: CommandContext): Promise<boolean> {
    const home = await ctx.helpers.buildHomePayload(ctx.msg.channelType, ctx.scopeId, ctx.locale);
    const topics = home.session.topics ?? [];
    const shown = topics.slice(0, TOPIC_DETAIL_LIMIT);
    await this.send(ctx, {
      type: 'sessionList',
      chatId: ctx.msg.chatId,
      data: {
        title: t('homeCmd.recentTopicsTitle'),
        emptyText: t('homeCmd.recentTopicsEmpty'),
        entries: shown.map((topic) => ({
          index: topic.index,
          provider: topic.provider,
          providerDisplayName: topic.providerDisplayName,
          sdkSessionId: topic.sdkSessionId,
          date: topic.updatedAt,
          cwd: topic.cwd,
          title: topic.title,
          preview: topic.preview,
          isCurrent: topic.isCurrent,
          isActive: topic.isActive,
          actionLabel: t('homeCmd.btnBackToTopic'),
          actionStyle: topic.isCurrent ? 'default' : 'primary',
        })),
      },
    });
    return true;
  }
}

export class HomeHistoryCommand extends BaseCommand {
  readonly name = '/home-history';
  readonly quick = true;
  readonly helpCategory = 'status' as const;
  readonly description = undefined;

  async execute(ctx: CommandContext): Promise<boolean> {
    const home = await ctx.helpers.buildHomePayload(ctx.msg.channelType, ctx.scopeId, ctx.locale);
    const sessions = (home.session.recent ?? []).filter(
      (session) => session.sdkSessionId && !session.topic,
    );
    const shown = sessions.slice(0, HISTORY_DETAIL_LIMIT);
    await this.send(ctx, {
      type: 'sessionList',
      chatId: ctx.msg.chatId,
      data: {
        title: t('homeCmd.recentLocalTitle'),
        emptyText: t('homeCmd.recentLocalEmpty'),
        entries: shown.map((session) => ({
          index: session.index,
          provider: session.provider,
          providerDisplayName: session.providerDisplayName,
          sdkSessionId: session.sdkSessionId,
          date: session.date,
          cwd: session.cwd,
          preview: session.preview,
          transcript: session.transcript,
          isCurrent: session.isCurrent,
          actionLabel: t('homeCmd.btnResumeToTopic'),
          actionStyle: 'primary',
        })),
      },
    });
    return true;
  }
}
