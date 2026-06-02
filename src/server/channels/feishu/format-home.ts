/**
 * Feishu home screen formatting - extracted from main formatter.
 */

import type { Locale } from '../../../shared/i18n/index.js';
import { t } from '../../../shared/i18n/index.js';
import type { FeishuCardElement } from './card-builder.js';
import type {
  HomeClientEntry,
  HomeData,
  HomeProviderEntry,
  HomeSessionEntry,
  HomeTopicEntry,
  HomeView,
} from '../../../shared/formatting/message-types.js';
import type { Button } from '../../../shared/ui/types.js';
import type { NewSessionButtonProvider } from '../../../shared/ui/buttons.js';
import { truncate } from '../../../shared/core/string.js';
import { actionCallback, homeInstanceActionArg } from '../../../shared/core/callbacks.js';
import { compareVersions } from '../../../shared/utils/version-checker.js';
import { buttonElements, markdownElement } from './card-elements.js';

const MAX_RECENT_VIEW_ITEMS = 8;
const MAX_DIRECTORY_BUTTONS = 12;
const MAX_DIRECTORY_FILES = 12;

/** Unified session status label for consistent display across /status and /home */
export function sessionStatusLabel(
  _locale: Locale,
  isTurnActive: boolean,
  isAlive: boolean,
): { icon: string; text: string } {
  if (isTurnActive) return { icon: '⏳', text: t('home.statusExecuting') };
  if (isAlive) return { icon: '🟢', text: t('home.statusActive') };
  return { icon: '💤', text: t('home.statusIdle') };
}

export interface FormatHomeParams {
  chatId: string;
  data: HomeData;
  locale: Locale;
}

export function buildHomeElements(params: FormatHomeParams): FeishuCardElement[] {
  const { data } = params;
  if (data.home?.stale) return buildStaleView();
  const view = data.view ?? 'main';
  if (view === 'nodes') return buildNodesView(data);
  if (view === 'recent') return buildRecentView(data);
  if (view === 'files') return buildFilesView(data);
  if (view === 'help') return buildHelpView(data);
  if (view === 'diagnostics') return buildDiagnosticsView(data);
  return buildMainView(data);
}

export function homeButtons(
  _locale: Locale,
  _providers: readonly NewSessionButtonProvider[] = [],
): Button[] {
  return [];
}

function buildMainView(data: HomeData): FeishuCardElement[] {
  const elements: FeishuCardElement[] = [homeHeaderElement('工作台', data)];
  const buttons: Button[] = [
    ...newSessionButtonsForDefaultClient(data, 0),
    { label: '节点', callbackData: homeAction(data, 'home-view', 'nodes'), row: 1 },
    { label: '最近会话', callbackData: homeAction(data, 'home-view', 'recent'), row: 1 },
    { label: '目录', callbackData: homeAction(data, 'home-view', 'files'), row: 1 },
    { label: '帮助', callbackData: homeAction(data, 'home-view', 'help'), row: 2 },
    {
      label: '连通检查',
      callbackData: homeAction(data, 'client-ping', data.clients?.defaultClientId),
      row: 2,
    },
    { label: '诊断', callbackData: homeAction(data, 'home-view', 'diagnostics'), row: 3 },
    { label: '刷新', callbackData: homeAction(data, 'home-refresh', 'main'), row: 3 },
  ];
  elements.push(...buttonElements(buttons));
  return elements;
}

function buildFilesView(data: HomeData): FeishuCardElement[] {
  const elements: FeishuCardElement[] = [
    homeHeaderElement('目录', data),
    ...panelNavButtons('files', data),
  ];
  const directory = data.workspace.directory;
  if (!directory) {
    elements.push(markdownElement('暂时无法读取当前目录。'));
    return elements;
  }

  const source = directory.clientId ? `节点: \`${directory.clientId}\`` : '来源: server';
  elements.push(markdownElement(`当前目录: \`${directory.displayPath}\`\n${source}`));

  if (directory.error) {
    elements.push(markdownElement(`⚠️ ${directory.error}`));
    return elements;
  }

  const directories = directory.entries.filter((entry) => entry.kind === 'directory');
  const files = directory.entries.filter((entry) => entry.kind !== 'directory');
  const buttons: Button[] = [];
  if (directory.parent) {
    buttons.push({
      label: '上级目录',
      callbackData: homeAction(data, 'home-dir', directory.parent),
      style: 'primary',
      row: 0,
    });
  }
  directories.slice(0, MAX_DIRECTORY_BUTTONS).forEach((entry, index) => {
    buttons.push({
      label: directoryButtonLabel(entry.name),
      callbackData: homeAction(data, 'home-dir', entry.path),
      row: Math.floor(index / 2) + 1,
    });
  });

  if (buttons.length) {
    elements.push(...buttonElements(buttons));
  } else {
    elements.push(markdownElement('没有子目录。'));
  }

  if (files.length) {
    elements.push(
      markdownElement(`**文件**\n${files.slice(0, MAX_DIRECTORY_FILES).map(fileLine).join('\n')}`),
    );
  }
  if (
    directory.hasMore ||
    directories.length > MAX_DIRECTORY_BUTTONS ||
    files.length > MAX_DIRECTORY_FILES
  ) {
    elements.push(markdownElement('仅显示前几项。'));
  }
  return elements;
}

function buildNodesView(data: HomeData): FeishuCardElement[] {
  const elements: FeishuCardElement[] = [
    homeHeaderElement('执行节点', data),
    ...panelNavButtons('nodes', data),
  ];
  const clients = data.clients?.entries ?? [];
  if (!clients.length) {
    elements.push(markdownElement('⚠️ 当前没有可用执行节点。请启动 `tlive client`。'));
    return elements;
  }

  for (const client of clients) {
    elements.push(markdownElement(clientDetailMarkdown(client, data.bridge.version)));
    const upgrade = clientUpgradeState(client, data.bridge.version);
    const leadingButtons: Button[] = [];
    if (!client.isDefault) {
      leadingButtons.push({
        label: '设为默认',
        callbackData: homeAction(data, 'use', client.clientId),
        style: 'primary',
        row: 0,
      });
    }
    leadingButtons.push({
      label: '连通检查',
      callbackData: homeAction(data, 'client-ping', client.clientId),
      row: 0,
    });
    leadingButtons.push({
      label: '节点历史',
      callbackData: homeAction(data, 'home-history', client.clientId),
      row: 0,
    });
    if (upgrade.outdated && upgrade.supported && !upgrade.busy && data.bridge.version) {
      leadingButtons.push({
        label: '升级节点',
        callbackData: homeAction(data, 'client-upgrade', client.clientId, data.bridge.version),
        style: 'primary',
        row: 0,
      });
    }
    const newSessionRowOffset = leadingButtons.length ? 1 : 0;
    const buttons: Button[] = [
      ...leadingButtons,
      ...client.providers
        .filter((provider) => provider.available)
        .map((provider, index) => ({
          label: `新建 ${provider.displayName}`,
          callbackData: homeAction(data, 'new', provider.kind, client.clientId),
          style: 'default' as const,
          row: Math.floor(index / 2) + newSessionRowOffset,
        })),
    ];
    elements.push(...buttonElements(buttons));
  }

  return elements;
}

function buildRecentView(data: HomeData): FeishuCardElement[] {
  const elements: FeishuCardElement[] = [
    homeHeaderElement('最近会话', data),
    ...panelNavButtons('recent', data),
  ];
  const sessionElements = buildRecentSessionElements(data, MAX_RECENT_VIEW_ITEMS);
  if (!sessionElements.length) {
    elements.push(markdownElement('暂无可继续的最近会话。'));
    return elements;
  }
  elements.push(...sessionElements);
  const hasMore =
    (data.session.topics?.length ?? 0) + (data.session.recent?.length ?? 0) > MAX_RECENT_VIEW_ITEMS;
  if (hasMore) {
    elements.push(
      ...buttonElements([{ label: '更多', callbackData: homeAction(data, 'home-history'), row: 0 }]),
    );
  }
  return elements;
}

function buildHelpView(data: HomeData): FeishuCardElement[] {
  const elements: FeishuCardElement[] = [
    homeHeaderElement('帮助', data),
    ...panelNavButtons('help', data),
    markdownElement(
      '工作台用于选择节点、新建话题和恢复最近会话；执行、权限确认和停止操作放在具体话题内。',
    ),
  ];
  const helpEntries = (data.help?.entries ?? [])
    .slice(0, 8)
    .map((entry) => `/${entry.cmd} - ${entry.desc}`);
  if (helpEntries.length) {
    elements.push(markdownElement(`**常用命令**\n${helpEntries.join('\n')}`));
  }
  elements.push(
    ...buttonElements([
      { label: '完整帮助', callbackData: homeAction(data, 'help'), row: 0 },
      { label: 'Bridge 状态', callbackData: homeAction(data, 'status'), row: 0 },
      { label: '内部诊断', callbackData: homeAction(data, 'diagnose'), row: 1 },
    ]),
  );
  return elements;
}

function buildDiagnosticsView(data: HomeData): FeishuCardElement[] {
  const queue = data.bridge.queueInfo
    ? `${data.bridge.queueInfo.depth}/${data.bridge.queueInfo.max}`
    : '无';
  const lines = [
    `Bridge: ${data.bridge.healthy === false ? '异常' : '正常'}`,
    `Channels: ${(data.bridge.channels ?? []).join(' / ') || 'none'}`,
    `Queue: ${queue}`,
    `权限模式: ${data.permission.mode}`,
  ];
  return [
    homeHeaderElement('诊断', data),
    ...panelNavButtons('diagnostics', data),
    markdownElement(lines.join('\n')),
    ...buttonElements([
      { label: 'Bridge 状态', callbackData: homeAction(data, 'status'), row: 0 },
      { label: '内部诊断', callbackData: homeAction(data, 'diagnose'), row: 0 },
    ]),
  ];
}

function buildStaleView(): FeishuCardElement[] {
  return [
    markdownElement(
      '**工作台已过期**\n这个工作台不是当前最新版本。请使用聊天底部的最新工作台，或重新发送 `/home` 打开新的工作台。',
    ),
  ];
}

function homeHeaderElement(title: string, data: HomeData): FeishuCardElement {
  return markdownElement(
    `**${title}**\n默认执行节点: ${data.clients?.defaultClientId ? `\`${data.clients.defaultClientId}\`` : '未选择'}\n当前目录: \`${data.workspace.cwd}\``,
  );
}

function homeAction(
  data: Pick<HomeData, 'home'> | undefined,
  name: string,
  ...args: Array<string | undefined>
): string {
  return actionCallback(name, ...args, homeInstanceActionArg(data?.home?.instanceId));
}

function panelNavButtons(view: HomeView, data: Pick<HomeData, 'home'>): FeishuCardElement[] {
  return buttonElements([
    { label: '返回', callbackData: homeAction(data, 'home-view', 'main'), row: 0 },
    { label: '刷新', callbackData: homeAction(data, 'home-refresh', view), row: 0 },
  ]);
}

function newSessionButtonsForDefaultClient(data: HomeData, row: number): Button[] {
  const clients = data.clients?.entries ?? [];
  const defaultClient =
    clients.find((client) => client.clientId === data.clients?.defaultClientId) ??
    (clients.length === 1 ? clients[0] : undefined);
  const providers =
    defaultClient?.providers.filter((provider) => provider.available) ??
    data.providers?.available.filter((provider) => provider.available) ??
    [];
  return providers.map((provider) => ({
    label: `新建 ${provider.displayName}`,
    callbackData: homeAction(data, 'new', provider.kind, defaultClient?.clientId),
    style: provider.isDefault ? ('primary' as const) : ('default' as const),
    row,
  }));
}

function clientDetailMarkdown(client: HomeClientEntry, serverVersion?: string): string {
  const title = `${client.online ? '🟢' : '🔴'} ${client.name || client.clientId}${client.isDefault ? ' ◀' : ''}`;
  const providers = providerNames(client.providers);
  const upgrade = clientUpgradeState(client, serverVersion);
  return [
    `**${title}**`,
    `ID: \`${client.clientId}\`${client.isLocal ? ' · local' : ''}`,
    client.note ? `备注: ${client.note}` : undefined,
    `Provider: ${providers}`,
    upgrade.outdated ? clientVersionLine(client, serverVersion, upgrade) : undefined,
    client.activeTurns > 0 ? `运行中: ${client.activeTurns} 个任务` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

function clientUpgradeState(
  client: HomeClientEntry,
  serverVersion?: string,
): { outdated: boolean; supported: boolean; busy: boolean } {
  const outdated = Boolean(
    client.version && serverVersion && compareVersions(client.version, serverVersion) < 0,
  );
  return {
    outdated,
    supported: client.upgrade?.supported === true,
    busy: client.activeTurns > 0,
  };
}

function clientVersionLine(
  client: HomeClientEntry,
  serverVersion: string | undefined,
  upgrade: { supported: boolean; busy: boolean },
): string {
  const suffix = !upgrade.supported ? '（需手动升级）' : upgrade.busy ? '（任务结束后可升级）' : '';
  return `版本: \`${client.version ?? 'unknown'}\` → \`${serverVersion ?? 'unknown'}\`${suffix}`;
}

function providerNames(providers: HomeProviderEntry[]): string {
  return (
    providers
      .filter((provider) => provider.available)
      .map((provider) => provider.displayName)
      .join(' / ') || 'none'
  );
}

function directoryButtonLabel(name: string): string {
  return `📁 ${truncate(name, 18)}`;
}

function fileLine(entry: { name: string; kind: string }): string {
  const prefix = entry.kind === 'file' ? '文件' : '其他';
  return `- ${prefix} \`${safeInlineCode(truncate(entry.name, 40))}\``;
}

function safeInlineCode(value: string): string {
  return value.replace(/`/g, "'");
}

function buildRecentSessionElements(data: HomeData, limit: number): FeishuCardElement[] {
  const elements: FeishuCardElement[] = [];
  const topicSdkSessionIds = new Set(
    (data.session.topics ?? [])
      .map((topic) => topic.sdkSessionId)
      .filter((id): id is string => Boolean(id)),
  );
  let index = 1;
  let itemCount = 0;

  for (const topic of (data.session.topics ?? []).slice(0, limit)) {
    if (itemCount >= limit) return elements;
    elements.push(...topicSessionElements(data, topic, index++));
    itemCount += 1;
  }

  const recoverableSessions = (data.session.recent ?? [])
    .filter((session) => session.sdkSessionId && !topicSdkSessionIds.has(session.sdkSessionId))
    .slice(0, Math.max(0, limit - itemCount));
  for (const session of recoverableSessions) {
    if (itemCount >= limit) return elements;
    elements.push(...historySessionElements(data, session, index++));
    itemCount += 1;
  }

  return elements;
}

function topicSessionElements(
  data: Pick<HomeData, 'home'>,
  topic: HomeTopicEntry,
  index: number,
): FeishuCardElement[] {
  const status = topic.isActive ? '⏳ 执行中' : '✅ 可继续';
  const currentMark = topic.isCurrent ? ' ◀' : '';
  const sdkShort = topic.sdkSessionId ? topic.sdkSessionId.slice(0, 8) : '-';
  const providerLabel = topic.providerDisplayName ?? 'Agent';
  const clientLabel = topic.clientId ? `\`${topic.clientId}\`` : '未记录';
  const elements = [
    markdownElement(
      `**${index}. ${status} ${truncate(topic.title, 36)}${currentMark}**\n节点: ${clientLabel} · ${providerLabel} \`${sdkShort}\` · \`${topic.cwd}\` · ${topic.updatedAt}\n${truncate(topic.preview, 90)}`,
    ),
  ];
  if (!topic.sdkSessionId) return elements;
  return [
    ...elements,
    ...buttonElements([
      {
        label: '回到话题',
        callbackData: homeAction(
          data,
          'continue',
          `${topic.provider ? `${topic.provider}:` : ''}${topic.sdkSessionId}`,
        ),
        style: topic.isCurrent ? 'default' : 'primary',
        row: 0,
      },
    ]),
  ];
}

function historySessionElements(
  data: Pick<HomeData, 'home'>,
  session: HomeSessionEntry,
  index: number,
): FeishuCardElement[] {
  const providerLabel = session.providerDisplayName ?? 'Agent';
  const sdkShort = session.sdkSessionId ? session.sdkSessionId.slice(0, 8) : '-';
  const elements = [
    markdownElement(
      `**${index}. ${providerLabel} \`${sdkShort}\` · ${session.date}**\n节点: \`${session.clientId ?? '-'}\` · \`${session.cwd}\`\n${truncate(session.preview, 80)}`,
    ),
  ];
  if (!session.sdkSessionId) return elements;
  return [
    ...elements,
    ...buttonElements([
      {
        label: session.topic ? '回到话题' : '恢复到话题',
        callbackData: homeAction(
          data,
          'continue',
          `${session.provider ? `${session.provider}:` : ''}${session.sdkSessionId}`,
        ),
        style: session.isCurrent ? 'default' : 'primary',
        row: 0,
      },
    ]),
  ];
}
