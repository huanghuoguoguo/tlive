import type { ChannelType, OutboundMessage } from '../channels/types.js';
import { buildFeishuHomeCard } from '../formatting/feishu-experience.js';

function withChatId(chatId: string, message: Omit<OutboundMessage, 'chatId'>): OutboundMessage {
  return { chatId, ...message };
}

export function presentStatus(chatId: string, channelType: ChannelType, coreStatus: string, channelList: string): OutboundMessage {
  if (channelType === 'telegram') {
    return withChatId(chatId, {
      html: [
        '📡 <b>TLive Status</b>',
        '',
        '<b>Bridge:</b>    🟢 running',
        `<b>Core:</b>      ${coreStatus}`,
        `<b>Channels:</b>  <code>${channelList}</code>`,
      ].join('\n'),
    });
  }

  return withChatId(chatId, {
    text: `**Bridge:** 🟢 running\n**Core:** ${coreStatus}\n**Channels:** ${channelList}`,
    feishuHeader: { template: 'blue', title: '📡 TLive Status' },
  });
}

export function presentNewSession(chatId: string, channelType: ChannelType, cwdLabel: string): OutboundMessage {
  if (channelType === 'feishu') {
    return withChatId(chatId, {
      text: `Session cleared${cwdLabel}. Send a message to begin.`,
      feishuHeader: { template: 'green', title: '🆕 New Session' },
    });
  }

  return withChatId(chatId, {
    html: `🆕 <b>New session started${cwdLabel}.</b> Send a message to begin.`,
  });
}

export function presentSessions(
  chatId: string,
  channelType: ChannelType,
  filterHint: string,
  lines: string[],
  footer: string,
  buttons?: OutboundMessage['buttons'],
): OutboundMessage {
  const body = lines.join('\n');
  if (channelType === 'telegram') {
    return withChatId(chatId, {
      html: `<b>📋 Sessions${filterHint}</b>\n\n${body}${footer}`,
    });
  }

  return withChatId(chatId, {
    text: `${body}${footer}`,
    feishuHeader: { template: 'blue', title: `📋 Sessions${filterHint}` },
    buttons,
  });
}

export function presentHelp(chatId: string, channelType: ChannelType): OutboundMessage {
  if (channelType === 'telegram') {
    return withChatId(chatId, {
      html: [
        '<b>❓ TLive Commands</b>',
        '',
        '<code>/new</code> — New conversation',
        '<code>/sessions</code> — List sessions in current directory',
        '<code>/sessions --all</code> — List all sessions',
        '<code>/session &lt;n&gt;</code> — Switch to session #n',
        '<code>/cd &lt;path&gt;</code> — Change directory',
        '<code>/pwd</code> — Show current directory',
        '<code>/verbose 0|1</code> — Detail level',
        '  0 = quiet · 1 = terminal card',
        '<code>/perm on|off</code> — Tool permission prompts',
        '<code>/effort low|high|max</code> — Thinking depth',
        '<code>/model &lt;name&gt;</code> — Switch model',
        '<code>/settings user|full|isolated</code> — Claude settings scope',
        '<code>/stop</code> — Interrupt current execution',
        '<code>/hooks pause|resume</code> — Toggle IM approval',
        '<code>/status</code> — Bridge status',
        '<code>/approve &lt;code&gt;</code> — Approve pairing request',
        '<code>/pairings</code> — List pending pairings',
        '<code>/help</code> — This message',
        '',
        '<i>💬 Reply <b>allow</b>/<b>deny</b> to approve permissions</i>',
      ].join('\n'),
    });
  }

  return withChatId(chatId, {
    text: [
      '常用操作：',
      '/home — 返回工作台',
      '/sessions — 查看当前目录会话',
      '/sessions --all — 查看全部会话',
      '/cd <path> — 切换目录',
      '/pwd — 查看当前目录',
      '/stop — 停止当前执行',
      '/status — 查看桥接状态',
      '',
      '💬 权限审批时也可以直接回复 **allow** / **deny**',
    ].join('\n'),
    feishuHeader: { template: 'indigo', title: '❓ 常用帮助' },
    buttons: [
      { label: '🏠 工作台', callbackData: 'cmd:home', style: 'primary' },
      { label: '📋 会话列表', callbackData: 'cmd:sessions', style: 'primary' },
      { label: '📍 当前目录', callbackData: 'cmd:pwd', style: 'default' },
      { label: '📚 完整命令', callbackData: 'cmd:help-cli', style: 'default' },
    ],
  });
}

export function presentHelpCli(chatId: string, channelType: ChannelType): OutboundMessage {
  if (channelType !== 'feishu') {
    return presentHelp(chatId, channelType);
  }

  return withChatId(chatId, {
    text: [
      '/home — 返回工作台',
      '/new — 新会话（重置当前飞书侧绑定）',
      '/sessions — 列出当前目录会话',
      '/sessions --all — 列出全部会话',
      '/session <n> — 切到第 n 个会话',
      '/sessioninfo <n> — 查看第 n 个会话详情',
      '/cd <path> — 切目录',
      '/pwd — 看当前目录',
      '/verbose 0|1 — 详细程度',
      '/perm on|off — 权限审批开关',
      '/effort low|high|max — 推理强度',
      '/model <name> — 切模型',
      '/settings user|full|isolated — Claude 配置范围',
      '/hooks pause|resume — Hook 审批开关',
      '/stop — 中断当前执行',
      '/status — 查看桥接状态',
      '/help — 常用帮助',
    ].join('\n'),
    feishuHeader: { template: 'blue', title: '📚 完整命令' },
    buttons: [
      { label: '🏠 工作台', callbackData: 'cmd:home', style: 'primary' },
      { label: '❓ 常用帮助', callbackData: 'cmd:help', style: 'default' },
    ],
  });
}

export function presentHome(
  chatId: string,
  channelType: ChannelType,
  data: { cwd: string; hasActiveTask: boolean; recentSummary?: string },
): OutboundMessage {
  if (channelType !== 'feishu') {
    return presentHelp(chatId, channelType);
  }

  const buttons = [
    { label: '🕘 最近会话', callbackData: 'cmd:sessions --all', style: 'primary' as const, row: 0 },
    { label: '🆕 新会话', callbackData: 'cmd:new', style: 'default' as const, row: 0 },
    { label: '📡 当前状态', callbackData: 'cmd:status', style: 'default' as const, row: 1 },
    { label: '📋 会话列表', callbackData: 'cmd:sessions', style: 'default' as const, row: 1 },
    ...(data.hasActiveTask ? [{ label: '⏹ 停止执行', callbackData: 'cmd:stop', style: 'danger' as const, row: 2 }] : []),
    { label: '❓ 帮助', callbackData: 'cmd:help', style: 'default' as const, row: 2 },
  ];

  const card = buildFeishuHomeCard({
    cwd: data.cwd,
    hasActiveTask: data.hasActiveTask,
    recentSummary: data.recentSummary,
    buttons,
  });

  return withChatId(chatId, {
    text: `当前目录：${data.cwd}`,
    feishuHeader: card.header,
    feishuElements: card.elements as unknown as Array<Record<string, unknown>>,
  });
}

export function presentSessionDetail(
  chatId: string,
  channelType: ChannelType,
  detail: { index: number; cwd: string; preview: string; date: string; size: string; transcript?: Array<{ role: 'user' | 'assistant'; text: string }> },
): OutboundMessage {
  if (channelType !== 'feishu') {
    return withChatId(chatId, {
      text: `${detail.index}. ${detail.date}\n${detail.cwd}\n${detail.size}\n${detail.preview}`,
    });
  }

  return withChatId(chatId, {
    text: [
      `**会话 #${detail.index}**`,
      `时间：${detail.date}`,
      `目录：${detail.cwd}`,
      `大小：${detail.size}`,
      `摘要：${detail.preview}`,
      ...(detail.transcript?.length
        ? [
            '',
            '**最近对话摘录**',
            ...detail.transcript.map(item => `${item.role === 'user' ? '你' : '助手'}：${item.text}`),
          ]
        : []),
    ].join('\n'),
    feishuHeader: { template: 'blue', title: `🗂️ 会话 #${detail.index}` },
    buttons: [
      { label: '▶️ 继续这个会话', callbackData: `cmd:session ${detail.index}`, style: 'primary' },
      { label: '📋 返回列表', callbackData: 'cmd:sessions', style: 'default' },
    ],
  });
}

export function presentVerbose(chatId: string, channelType: ChannelType, level: 0 | 1): OutboundMessage {
  const labels = ['🤫 quiet', '📝 terminal card'];
  const detail = level === 0
    ? '只在等待权限、等待回答、完成、失败时发消息'
    : '执行中会持续展示状态卡和进度摘要';
  const text = `Verbose: ${labels[level]}\n${detail}`;

  return withChatId(chatId, { text });
}

export function presentVerboseUsage(chatId: string, channelType: ChannelType): OutboundMessage {
  const text = 'Usage: `/verbose 0|1`\n0=quiet，只在关键节点发消息\n1=terminal card，显示执行中状态卡';

  return withChatId(chatId, { text });
}

export function presentPermissionModeChanged(chatId: string, channelType: ChannelType, mode: 'on' | 'off'): OutboundMessage {
  const text = mode === 'on'
    ? '🔐 Permission prompts: ON — dangerous tools will ask for confirmation'
    : '⚡ Permission prompts: OFF — all tools auto-allowed';

  return withChatId(chatId, { text });
}

export function presentPermissionModeStatus(chatId: string, channelType: ChannelType, current: string): OutboundMessage {
  const text = `🔐 Permission mode: **${current}**\nUsage: \`/perm on|off\`\non = prompt for dangerous tools (default)\noff = auto-allow all`;

  return withChatId(chatId, { text });
}

export function presentStopResult(chatId: string, interrupted: boolean): OutboundMessage {
  return withChatId(chatId, {
    text: interrupted ? '⏹ Interrupted current execution' : '⚠️ No active execution to stop',
  });
}

export function presentEffortChanged(chatId: string, level: 'low' | 'medium' | 'high' | 'max'): OutboundMessage {
  const icons: Record<'low' | 'medium' | 'high' | 'max', string> = {
    low: '⚡',
    medium: '🧠',
    high: '💪',
    max: '🔥',
  };

  return withChatId(chatId, {
    text: `${icons[level]} Effort: **${level}**`,
  });
}

export function presentEffortStatus(chatId: string, current: string): OutboundMessage {
  return withChatId(chatId, {
    text: `🧠 Effort: **${current}**\nUsage: \`/effort low|medium|high|max\`\nlow = fast · medium = balanced · high = thorough · max = maximum`,
  });
}

export function presentHooksStatus(chatId: string, paused: boolean): OutboundMessage {
  return withChatId(chatId, {
    text: `Hooks: ${paused ? '⏸ paused' : '▶ active'}`,
  });
}

export function presentHooksChanged(chatId: string, paused: boolean): OutboundMessage {
  return withChatId(chatId, {
    text: paused
      ? '⏸ Hooks paused — auto-allow, no notifications.'
      : '▶ Hooks resumed — forwarding to IM.',
  });
}

export function presentNoSessions(chatId: string, hint: string): OutboundMessage {
  return withChatId(chatId, {
    text: `No sessions found${hint}`,
  });
}

export function presentSessionUsage(chatId: string): OutboundMessage {
  return withChatId(chatId, {
    text: 'Usage: /session <number>\nUse /sessions to list.',
  });
}

export function presentSessionNotFound(chatId: string, idx: number): OutboundMessage {
  return withChatId(chatId, {
    text: `Session ${idx} not found. Use /sessions to list.`,
  });
}

export function presentSessionSwitched(chatId: string, idx: number, cwd: string, preview: string): OutboundMessage {
  return withChatId(chatId, {
    text: `🔄 Switched to session ${idx}\n${cwd} · ${preview}`,
  });
}

export function presentDirectory(chatId: string, cwd: string, withIcon = false): OutboundMessage {
  return withChatId(chatId, {
    text: withIcon ? `📂 ${cwd}` : cwd,
  });
}

export function presentDirectoryNotFound(chatId: string, path: string): OutboundMessage {
  return withChatId(chatId, {
    text: `❌ Directory not found: ${path}`,
  });
}

export function presentModelChanged(chatId: string, model?: string): OutboundMessage {
  return withChatId(chatId, {
    text: model ? `🤖 Model: **${model}**` : '🤖 Model: reset to default',
  });
}

export function presentModelStatus(chatId: string, current: string): OutboundMessage {
  return withChatId(chatId, {
    text: `🤖 Model: **${current}**\nUsage: \`/model <name>\` or \`/model reset\`\nExamples: \`claude-sonnet-4-6\`, \`claude-opus-4-6\``,
  });
}

export function presentSettingsUnavailable(chatId: string): OutboundMessage {
  return withChatId(chatId, {
    text: '⚠️ Settings only available for Claude provider',
  });
}

export function presentSettingsChanged(chatId: string, label: string): OutboundMessage {
  return withChatId(chatId, {
    text: `⚙️ Settings: ${label}`,
  });
}

export function presentSettingsStatus(chatId: string, preset: string, current: string[]): OutboundMessage {
  return withChatId(chatId, {
    text: [
      `⚙️ Settings: **${preset}** (${current.join(', ') || 'none'})`,
      'Usage: `/settings user|full|isolated`',
      '  user — ~/.claude/settings.json (auth, model)',
      '  full — + CLAUDE.md, MCP servers, skills',
      '  isolated — no external settings',
    ].join('\n'),
  });
}

export function presentApproveUsage(chatId: string): OutboundMessage {
  return withChatId(chatId, {
    text: 'Usage: /approve <pairing_code>',
  });
}

export function presentApproveSuccess(chatId: string, username: string, userId: string): OutboundMessage {
  return withChatId(chatId, {
    text: `✅ Approved user ${username} (${userId})`,
  });
}

export function presentApproveFailure(chatId: string): OutboundMessage {
  return withChatId(chatId, {
    text: '❌ Code not found or expired',
  });
}

export function presentPairingUnavailable(chatId: string): OutboundMessage {
  return withChatId(chatId, {
    text: '⚠️ Pairing not available',
  });
}

export function presentNoPairings(chatId: string): OutboundMessage {
  return withChatId(chatId, {
    text: 'No pending pairing requests.',
  });
}

export function presentPairings(chatId: string, lines: string[]): OutboundMessage {
  return withChatId(chatId, {
    html: `<b>🔐 Pending Pairings</b>\n\n${lines.join('\n')}\n\nUse /approve <code> to approve.`,
  });
}

export function presentVersionCheck(
  chatId: string,
  channelType: ChannelType,
  info: { current: string; latest: string; hasUpdate: boolean; publishedAt?: string },
): OutboundMessage {
  const dateStr = info.publishedAt
    ? new Date(info.publishedAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
    : '';

  if (channelType === 'feishu') {
    return withChatId(chatId, {
      text: info.hasUpdate
        ? `**发现新版本**\n当前：v${info.current}\n最新：v${info.latest}${dateStr ? `\n发布时间：${dateStr}` : ''}\n\n点击下方按钮升级或跳过`
        : `**已是最新版本**\n当前版本：v${info.current}`,
      feishuHeader: { template: info.hasUpdate ? 'green' : 'blue', title: '🔄 版本检查' },
      buttons: info.hasUpdate
        ? [
            { label: '⬆️ 立即升级', callbackData: `cmd:upgrade confirm:${info.latest}`, style: 'primary' as const, row: 0 },
            { label: '⏭️ 跳过此版本', callbackData: `cmd:upgrade skip:${info.latest}`, style: 'default' as const, row: 0 },
            { label: '📋 查看更新', callbackData: 'cmd:upgrade notes', style: 'default' as const, row: 1 },
          ]
        : [
            { label: '🔄 再次检查', callbackData: 'cmd:upgrade', style: 'default' as const },
          ],
    });
  }

  // Telegram
  return withChatId(chatId, {
    html: info.hasUpdate
      ? `🔄 <b>New version available!</b>\n\nCurrent: <code>v${info.current}</code>\nLatest: <code>v${info.latest}</code>${dateStr ? `\nReleased: ${dateStr}` : ''}\n\nRun <code>/upgrade confirm</code> to upgrade or <code>/upgrade skip</code> to skip this version.`
      : `✅ <b>Up to date</b>\n\nCurrent version: <code>v${info.current}</code>`,
  });
}

export function presentUpgradeResult(
  chatId: string,
  channelType: ChannelType,
  result: { success: boolean; version?: string; error?: string },
): OutboundMessage {
  if (result.success) {
    if (channelType === 'feishu') {
      return withChatId(chatId, {
        text: `**升级成功**\n版本：v${result.version}\n\n请运行 /tlive restart 或手动重启服务以生效`,
        feishuHeader: { template: 'green', title: '⬆️ 升级完成' },
        buttons: [
          { label: '🔄 重启服务', callbackData: 'cmd:restart', style: 'primary' as const },
        ],
      });
    }
    return withChatId(chatId, {
      text: `⬆️ Upgrade complete: v${result.version}\n\nRestart tlive to apply changes.`,
    });
  }

  if (channelType === 'feishu') {
    return withChatId(chatId, {
      text: `**升级失败**\n${result.error || '未知错误'}\n\n可以手动执行安装脚本`,
      feishuHeader: { template: 'red', title: '❌ 升级失败' },
      buttons: [
        { label: '📋 查看命令', callbackData: 'cmd:upgrade cmd', style: 'default' as const },
      ],
    });
  }
  return withChatId(chatId, {
    text: `❌ Upgrade failed: ${result.error || 'Unknown error'}`,
  });
}

export function presentUpgradeCommand(chatId: string, channelType: ChannelType): OutboundMessage {
  const cmd = 'curl -fsSL https://raw.githubusercontent.com/huanghuoguoguo/tlive/main/install.sh | bash';

  if (channelType === 'feishu') {
    return withChatId(chatId, {
      text: `**手动升级命令**\n\`\`\`bash\n${cmd}\n\`\`\``,
      feishuHeader: { template: 'blue', title: '📋 升级命令' },
    });
  }
  return withChatId(chatId, {
    text: `Manual upgrade:\n\`\`\`\n${cmd}\n\`\`\``,
  });
}

export function presentRestartResult(chatId: string, channelType: ChannelType): OutboundMessage {
  if (channelType === 'feishu') {
    return withChatId(chatId, {
      text: '🔄 正在重启服务...\n\n服务将在几秒后重新连接',
      feishuHeader: { template: 'blue', title: '🔄 重启中' },
    });
  }
  return withChatId(chatId, {
    text: '🔄 Restarting... The service will reconnect in a few seconds.',
  });
}

export function presentVersionSkipped(chatId: string, channelType: ChannelType, version: string): OutboundMessage {
  if (channelType === 'feishu') {
    return withChatId(chatId, {
      text: `⏭️ 已跳过版本 v${version}\n\n下次有新版本时将再次提醒`,
      feishuHeader: { template: 'yellow', title: '⏭️ 跳过版本' },
      buttons: [
        { label: '↩️ 取消跳过', callbackData: 'cmd:upgrade unskip', style: 'default' as const },
      ],
    });
  }
  return withChatId(chatId, {
    text: `⏭️ Skipped version v${version}\n\nYou will be notified when a newer version is available.`,
  });
}

export function presentVersionUnskipped(chatId: string, channelType: ChannelType): OutboundMessage {
  if (channelType === 'feishu') {
    return withChatId(chatId, {
      text: '↩️ 已取消跳过\n\n下次检查时会重新提醒更新',
      feishuHeader: { template: 'blue', title: '↩️ 恢复提醒' },
    });
  }
  return withChatId(chatId, {
    text: '↩️ Update notifications re-enabled.',
  });
}
