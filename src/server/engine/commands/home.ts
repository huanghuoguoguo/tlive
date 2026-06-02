import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentDirectoryNotFound, presentHome } from '../../presentation/command-presenter.js';
import type { FormattableMessage, HomeView } from '../../../shared/formatting/message-types.js';
import { shortPath } from '../../../shared/core/path.js';
import { t } from '../../../shared/i18n/index.js';
import { switchCommandDirectory } from './cd.js';
import { generateId } from '../../../shared/core/id.js';

const HOME_VIEWS = new Set<HomeView>(['main', 'nodes', 'recent', 'files', 'help', 'diagnostics']);

function homeViewFromArg(raw?: string): HomeView {
  return HOME_VIEWS.has(raw as HomeView) ? (raw as HomeView) : 'main';
}

async function buildHomeMessage(
  ctx: CommandContext,
  view: HomeView = 'main',
): Promise<FormattableMessage> {
  const data = await ctx.helpers.buildHomePayload(
    ctx.msg.channelType,
    ctx.scopeId,
    ctx.locale,
    view,
  );
  const instanceId = ctx.services.state.getActiveHomeInstance(ctx.msg.channelType, ctx.scopeId);
  return presentHome(ctx.msg.chatId, {
    ...data,
    view,
    home: instanceId ? { ...data.home, instanceId } : data.home,
  });
}

function activateNewHomeInstance(ctx: CommandContext): void {
  ctx.services.state.setActiveHomeInstance(
    ctx.msg.channelType,
    ctx.scopeId,
    generateId('home', 8),
  );
}

async function editHomeInPlaceOrSend(
  ctx: CommandContext,
  view: HomeView,
  send: (msg: FormattableMessage) => Promise<void>,
): Promise<void> {
  const homeMessage = await buildHomeMessage(ctx, view);
  if (!ctx.msg.messageId) {
    await send(homeMessage);
    return;
  }

  try {
    await ctx.adapter.editMessage(
      ctx.msg.chatId,
      ctx.msg.messageId,
      ctx.adapter.format(homeMessage),
    );
  } catch {
    await send(homeMessage);
  }
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
    activateNewHomeInstance(ctx);
    await this.send(ctx, await buildHomeMessage(ctx, 'main'));
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
    activateNewHomeInstance(ctx);
    await this.send(ctx, await buildHomeMessage(ctx, 'main'));
    return true;
  }
}

export class HomeViewCommand extends BaseCommand {
  readonly name = '/home-view';
  readonly quick = true;
  readonly helpCategory = 'status' as const;
  readonly description = undefined;

  async execute(ctx: CommandContext): Promise<boolean> {
    await editHomeInPlaceOrSend(ctx, homeViewFromArg(ctx.parts[1]), (msg) => this.send(ctx, msg));
    return true;
  }
}

export class HomeRefreshCommand extends BaseCommand {
  readonly name = '/home-refresh';
  readonly quick = true;
  readonly helpCategory = 'status' as const;
  readonly description = undefined;

  async execute(ctx: CommandContext): Promise<boolean> {
    await editHomeInPlaceOrSend(ctx, homeViewFromArg(ctx.parts[1]), (msg) => this.send(ctx, msg));
    return true;
  }
}

export class HomeDirectoryCommand extends BaseCommand {
  readonly name = '/home-dir';
  readonly quick = true;
  readonly helpCategory = 'status' as const;
  readonly description = undefined;

  async execute(ctx: CommandContext): Promise<boolean> {
    const path = ctx.parts.slice(1).join(' ').trim();
    if (path) {
      const result = await switchCommandDirectory(ctx, path);
      if (!result.ok) {
        await this.send(
          ctx,
          result.error
            ? { chatId: ctx.msg.chatId, text: result.error }
            : presentDirectoryNotFound(ctx.msg.chatId, shortPath(result.requestedPath)),
        );
        return true;
      }
    }
    await editHomeInPlaceOrSend(ctx, 'files', (msg) => this.send(ctx, msg));
    return true;
  }
}

export class ClientUpgradeCommand extends BaseCommand {
  readonly name = '/client-upgrade';
  readonly quick = true;
  readonly helpCategory = 'status' as const;
  readonly description = undefined;

  async execute(ctx: CommandContext): Promise<boolean> {
    const clientId = ctx.parts[1]?.trim();
    if (!clientId) {
      await this.send(ctx, { chatId: ctx.msg.chatId, text: '⚠️ 缺少执行节点 ID。' });
      return true;
    }
    const home = await ctx.helpers.buildHomePayload(ctx.msg.channelType, ctx.scopeId, ctx.locale);
    const client = home.clients?.entries.find((entry) => entry.clientId === clientId);
    if (!client) {
      await this.send(ctx, { chatId: ctx.msg.chatId, text: `⚠️ 执行节点不在线: ${clientId}` });
      return true;
    }
    if (!client.upgrade?.supported) {
      await this.send(ctx, {
        chatId: ctx.msg.chatId,
        text: `⚠️ 节点 ${clientId} 不支持远程自升级，请先在节点机器上手动升级一次。`,
      });
      return true;
    }
    if (client.activeTurns > 0) {
      await this.send(ctx, {
        chatId: ctx.msg.chatId,
        text: `⚠️ 节点 ${clientId} 正在执行任务，任务结束后再升级。`,
      });
      return true;
    }
    const version = ctx.parts[2]?.trim() || home.bridge.version;
    if (!version) {
      await this.send(ctx, { chatId: ctx.msg.chatId, text: '⚠️ 无法确定目标版本。' });
      return true;
    }
    if (!ctx.services.remoteClientRegistry) {
      await this.send(ctx, { chatId: ctx.msg.chatId, text: '⚠️ remote client registry 未启用。' });
      return true;
    }

    const result = await ctx.services.remoteClientRegistry.upgradeClient(clientId, version);
    if (!result.ok) {
      await this.send(ctx, {
        chatId: ctx.msg.chatId,
        text: `⚠️ 节点升级请求失败: ${result.error || result.stderr || 'unknown error'}`,
      });
      return true;
    }

    await this.send(ctx, {
      chatId: ctx.msg.chatId,
      text: `✅ 已向节点 ${clientId} 发送升级请求：${client.version || 'unknown'} → ${version}。节点会短暂断开并自动重连。`,
    });
    return true;
  }
}

export class ClientPingCommand extends BaseCommand {
  readonly name = '/client-ping';
  readonly quick = true;
  readonly helpCategory = 'status' as const;
  readonly description = undefined;

  async execute(ctx: CommandContext): Promise<boolean> {
    const home = await ctx.helpers.buildHomePayload(ctx.msg.channelType, ctx.scopeId, ctx.locale);
    const clients = home.clients?.entries ?? [];
    const requested = ctx.parts[1]?.trim();
    const clientId =
      requested ||
      home.clients?.defaultClientId ||
      (clients.length === 1 ? clients[0].clientId : undefined);

    if (!clientId) {
      await this.send(ctx, { chatId: ctx.msg.chatId, text: '⚠️ 没有可检查的执行节点。' });
      return true;
    }

    const client = clients.find((entry) => entry.clientId === clientId);
    if (!client) {
      await this.send(ctx, { chatId: ctx.msg.chatId, text: `⚠️ 执行节点不在线: ${clientId}` });
      return true;
    }

    if (!ctx.services.remoteClientRegistry) {
      await this.send(ctx, { chatId: ctx.msg.chatId, text: '⚠️ remote client registry 未启用。' });
      return true;
    }

    const startedAt = Date.now();
    try {
      const result = await ctx.services.remoteClientRegistry.pingClient(clientId);
      const latencyMs = Date.now() - startedAt;
      if (!result.ok) {
        await this.send(ctx, {
          chatId: ctx.msg.chatId,
          text: `⚠️ 节点 ${clientId} 响应失败: ${result.error || result.stderr || 'unknown error'}`,
        });
        return true;
      }

      const hello = result.stdout?.trim() || 'hello';
      await this.send(ctx, {
        chatId: ctx.msg.chatId,
        text: `✅ 节点 ${clientId} 可达 (${latencyMs}ms)\n${hello}`,
      });
    } catch (err) {
      await this.send(ctx, {
        chatId: ctx.msg.chatId,
        text: `⚠️ 节点 ${clientId} 连通检查失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
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
          clientId: topic.clientId,
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
    const requestedClientId = ctx.parts[1];
    const sessions = (home.session.recent ?? []).filter(
      (session) =>
        session.sdkSessionId && (!requestedClientId || session.clientId === requestedClientId),
    );
    const shown = sessions.slice(0, HISTORY_DETAIL_LIMIT);
    await this.send(ctx, {
      type: 'sessionList',
      chatId: ctx.msg.chatId,
      data: {
        title: requestedClientId
          ? t('homeCmd.recentNodeTitle').replace('{clientId}', requestedClientId)
          : t('homeCmd.recentSessionsTitle'),
        emptyText: requestedClientId
          ? t('homeCmd.recentNodeEmpty').replace('{clientId}', requestedClientId)
          : t('homeCmd.recentSessionsEmpty'),
        entries: shown.map((session) => ({
          index: session.index,
          provider: session.provider,
          providerDisplayName: session.providerDisplayName,
          clientId: session.clientId,
          sdkSessionId: session.sdkSessionId,
          date: session.date,
          cwd: session.cwd,
          preview: session.preview,
          transcript: session.transcript,
          isCurrent: session.isCurrent,
          actionLabel: session.topic ? t('homeCmd.btnBackToTopic') : t('homeCmd.btnResumeToTopic'),
          actionStyle: session.isCurrent ? 'default' : 'primary',
        })),
      },
    });
    return true;
  }
}
